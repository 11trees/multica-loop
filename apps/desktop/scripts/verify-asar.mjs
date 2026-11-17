import {createHash} from "node:crypto";
import {statSync} from "node:fs";
import asar from "@electron/asar";

export function verifyPackedArchive(archive, expectedVersion) {
  const before = statSync(archive);
  asar.uncache(archive);
  let metadata;
  try {
    metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  } catch {
    throw new Error("Packaged package.json is not valid JSON");
  }
  if (!metadata || typeof metadata.main !== "string" || typeof metadata.version !== "string" ||
    expectedVersion && metadata.version !== expectedVersion) {
    throw new Error("Packaged entry point or version differs from the build");
  }
  asar.statFile(archive, metadata.main.replace(/^\.\//, ""));
  let files = 0, bytes = 0, unpackedFiles = 0;
  const walk = (directory, prefix = "") => {
    for (const [name, entry] of Object.entries(directory.files)) {
      const relative = prefix + name;
      if (entry.files) {walk(entry, `${relative}/`); continue;}
      if (entry.link) continue;
      // Signing can change unpacked native executables after ASAR creation.
      if (entry.unpacked) {unpackedFiles++; continue;}
      if (entry.integrity?.algorithm !== "SHA256" || typeof entry.integrity.hash !== "string") {
        throw new Error(`Packed file has no supported integrity witness: ${relative}`);
      }
      const content = asar.extractFile(archive, relative);
      const digest = createHash("sha256").update(content).digest("hex");
      if (content.length !== entry.size || digest !== entry.integrity.hash) {
        throw new Error(`Packed file integrity mismatch: ${relative}`);
      }
      files++; bytes += content.length;
    }
  };
  walk(asar.getRawHeader(archive).header);
  const after = statSync(archive);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("ASAR changed during integrity verification");
  }
  return {version: metadata.version, main: metadata.main, files, bytes, unpackedFiles};
}
