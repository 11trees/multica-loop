import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export function git(path: string, args: string[], trim = true): string {
  const output = execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", path, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return trim ? output.trim() : output;
}

export type RepositoryOverlay = { path: string; hash: string; executable: boolean; originalHash: string | null; originalExecutable: boolean };

function digest(content: Uint8Array | string) { return createHash("sha256").update(content).digest("hex"); }
function headFile(path: string, ref: string, relative: string) {
  const row = git(path, ["ls-tree", "-z", ref, "--", relative], false).split("\0")[0];
  if (!row) return { hash: null, executable: false };
  const [mode, type, object] = row.split("\t")[0]!.split(" ");
  if (type !== "blob" || mode === "120000") throw new Error("Runtime overlays require regular repository files");
  const content = execFileSync("git", ["--no-optional-locks", "-C", path, "cat-file", "blob", object!], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return { hash: digest(content), executable: mode === "100755" };
}
export function repositoryCommonDirectory(path: string) { return realpathSync(git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])); }
export function repositoryBranch(path: string) { return git(path, ["symbolic-ref", "--quiet", "HEAD"]); }

export function captureRepositoryOverlays(path: string, input: { path: string; hash: string }[], clean = true): RepositoryOverlay[] {
  const root = repositorySnapshot(path, false).repositoryPath;
  const overlays: RepositoryOverlay[] = [];
  for (const item of input) {
    if (!lstatSync(item.path).isFile()) throw new Error("Runtime overlays require regular files");
    const absolute = realpathSync(item.path);
    const name = relative(root, absolute).split(sep).join("/");
    if (!name || name === ".." || name.startsWith("../") || isAbsolute(name) || overlays.some(overlay => overlay.path === name)) throw new Error("Runtime overlay is outside the repository or repeated");
    if (digest(readFileSync(absolute)) !== item.hash) throw new Error("Runtime overlay changed before repository binding");
    const original = headFile(root, "HEAD", name);
    overlays.push({ path: name, hash: item.hash, executable: Boolean(lstatSync(absolute).mode & 0o111), originalHash: original.hash, originalExecutable: original.executable });
  }
  repositorySnapshot(root, clean, overlays);
  return overlays;
}

function overlayValue(path: string, overlay: RepositoryOverlay) {
  const file = join(path, overlay.path);
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && overlay.originalHash === null) return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Runtime overlay ${overlay.path} is no longer a regular file`);
  const hash = digest(readFileSync(file)), executable = Boolean(stat.mode & 0o111);
  if (hash === overlay.hash && executable === overlay.executable || hash === overlay.originalHash && executable === overlay.originalExecutable) {
    return overlay.originalHash ? [overlay.path, overlay.originalExecutable ? "executable" : "file", overlay.originalHash] : null;
  }
  throw new Error(`Runtime-owned file ${overlay.path} changed; restore it before recording engineering evidence`);
}

export function repositorySnapshot(path: string, clean = true, overlays: RepositoryOverlay[] = []) {
  const repositoryPath = realpathSync(git(realpathSync(path), ["rev-parse", "--show-toplevel"]));
  if (clean) {
    for (const overlay of overlays) {
      overlayValue(repositoryPath, overlay);
      const committed = headFile(repositoryPath, "HEAD", overlay.path);
      if (committed.hash !== overlay.originalHash || committed.executable !== overlay.originalExecutable) throw new Error(`Do not commit runtime-owned file ${overlay.path}; commit only the business changes`);
    }
    const changed = git(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false).split("\0").filter(Boolean);
    if (changed.some(row => !overlays.some(overlay => overlay.path === row.slice(3)))) throw new Error("Verification repository has uncommitted changes; commit or isolate them before freezing/testing");
  }
  return { repositoryPath, codeVersion: git(repositoryPath, ["rev-parse", "HEAD"]) };
}

/** Content identity survives committing the same files; ignored files are outside this boundary. */
export function repositoryFingerprint(path: string, overlays: RepositoryOverlay[] = []): string {
  const paths = [...new Set(git(path, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], false).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const relative of paths) {
    const overlay = overlays.find(item => item.path === relative);
    if (overlay) {
      const value = overlayValue(path, overlay);
      if (value) hash.update(JSON.stringify(value));
      continue;
    }
    const file = join(path, relative);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported repository entry ${relative}; map submodules before using captured checks`);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    hash.update(JSON.stringify([relative, stat.isSymbolicLink() ? "link" : (stat.mode & 0o111) ? "executable" : "file", createHash("sha256").update(content).digest("hex")]));
  }
  return hash.digest("hex");
}
