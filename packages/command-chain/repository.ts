import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function git(path: string, args: string[], trim = true): string {
  const output = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return trim ? output.trim() : output;
}

export function repositorySnapshot(path: string, clean = true) {
  const repositoryPath = realpathSync(git(realpathSync(path), ["rev-parse", "--show-toplevel"]));
  if (clean && git(repositoryPath, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Verification repository has uncommitted changes; commit or isolate them before freezing/testing");
  return { repositoryPath, codeVersion: git(repositoryPath, ["rev-parse", "HEAD"]) };
}

/** Content identity survives committing the same files; ignored files are outside this boundary. */
export function repositoryFingerprint(path: string): string {
  const paths = [...new Set(git(path, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], false).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const relative of paths) {
    const file = join(path, relative);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported repository entry ${relative}; map submodules before using captured checks`);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    hash.update(JSON.stringify([relative, stat.isSymbolicLink() ? "link" : (stat.mode & 0o111) ? "executable" : "file", createHash("sha256").update(content).digest("hex")]));
  }
  return hash.digest("hex");
}
