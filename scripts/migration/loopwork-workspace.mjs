import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function utf8(buffer) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text).equals(buffer)) throw new Error("Workspace paths must be valid UTF-8");
  return text;
}
const sameFile = (a, b) => ["dev", "ino", "size", "mode", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);

// A content witness, not a backup, accepted code verdict or filesystem lease.
// In particular, include .tmp rather than the repair protocol's narrower scope.
export async function captureWorkspace(root, { timeoutMs = 30000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Workspace timeout must be positive");
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error("Workspace root must be an existing canonical absolute directory");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const git = args => new Promise((accept, reject) => execFile("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd: root, env, signal: controller.signal, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
  }, (error, stdout) => error ? reject(new Error("Workspace Git inspection failed")) : accept(stdout)));
  const paths = buffer => utf8(buffer).split("\0").filter(Boolean);
  const entries = buffer => paths(buffer).map(value => {
    const tab = value.indexOf("\t"), fields = value.slice(0, tab).split(" ");
    if (tab < 0 || fields.length !== 3 || !/^100(?:644|755)$|^120000$/.test(fields[0]) || fields[2] !== "0") throw new Error("Workspace submodules, conflicts or unsupported index entries require reconciliation");
    return { path: value.slice(tab + 1), mode: fields[0], oid: fields[1] };
  });
  try {
    if (utf8(await git(["rev-parse", "--show-toplevel"])).trimEnd() !== root) throw new Error("Workspace root must be the Git working tree root");
    const observe = async () => {
      const head = utf8(await git(["rev-parse", "--verify", "HEAD"])).trim();
      if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(head)) throw new Error("Workspace needs a committed Git identity");
      const index = entries(await git(["ls-files", "--stage", "-z", "--", "."]));
      const tree = paths(await git(["ls-tree", "-r", "-z", "HEAD"])).map(value => {
        const tab = value.indexOf("\t"), [mode, type, oid] = value.slice(0, tab).split(" ");
        if (tab < 0 || type !== "blob") throw new Error("Workspace submodules require reconciliation");
        return { path: value.slice(tab + 1), mode, oid };
      });
      const untracked = paths(await git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]));
      // Include paths deleted from the index too: a staged deletion may still
      // have working bytes (including ignored bytes) which must not disappear.
      const included = [...new Set([...index.map(row => row.path), ...tree.map(row => row.path), ...untracked])].sort();
      if (included.length > 100000) throw new Error("Workspace exceeds 100000 content paths");
      const files = [];
      for (const path of included) {
        controller.signal.throwIfAborted();
        if (!path || isAbsolute(path) || path.split("/").some(part => ["", ".", ".."].includes(part))) throw new Error("Workspace path escapes its root");
        const absolute = join(root, path);
        let before;
        try { before = await lstat(absolute); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          files.push({ path, kind: "deleted" }); continue;
        }
        const parent = await realpath(join(absolute, "..")), relation = relative(root, parent);
        if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) throw new Error("Workspace path escapes its root");
        const sha = createHash("sha256"), blob = createHash(head.length === 40 ? "sha1" : "sha256");
        let kind, link = null;
        if (before.isSymbolicLink()) {
          kind = "symlink"; link = await readlink(absolute, { encoding: "buffer" });
          sha.update(link); blob.update(`blob ${link.length}\0`).update(link);
        } else if (before.isFile()) {
          kind = "file"; blob.update(`blob ${before.size}\0`);
          for await (const chunk of createReadStream(absolute, { signal: controller.signal })) { sha.update(chunk); blob.update(chunk); }
        } else throw new Error("Workspace contains an unsupported source object");
        const after = await lstat(absolute);
        if (!sameFile(before, after) || link && !link.equals(await readlink(absolute, { encoding: "buffer" }))) throw new Error("Workspace changed while reading content");
        files.push({ path, kind, mode: before.mode & 0o777, size: before.size, hash: sha.digest("hex"), git_oid: blob.digest("hex") });
      }
      const byPath = new Map(index.map(row => [row.path, row]));
      const dirty = digest(index) !== digest(tree) || files.some(file => {
        const staged = byPath.get(file.path);
        const mode = file.kind === "symlink" ? "120000" : file.mode & 0o111 ? "100755" : "100644";
        return !staged || file.kind === "deleted" || file.git_oid !== staged.oid || mode !== staged.mode;
      });
      return { root, head, index, tree, files, dirty, untracked_count: untracked.length, deleted_count: files.filter(row => row.kind === "deleted").length };
    };
    const first = await observe(), second = await observe();
    if (digest(first) !== digest(second) || await realpath(root) !== root) throw new Error("Workspace changed during baseline capture");
    return { format: "loopwork-workspace-content-v1", ...first, exclusions: ["Git metadata and ignored paths not present in HEAD or the index are excluded.", "Symlink target bytes and external file/image references are not captured.", "This digest is not a backup, execution permission, source ownership or a code-verification verdict."], execution_authorized: false };
  } finally { clearTimeout(timer); controller.abort(); }
}
