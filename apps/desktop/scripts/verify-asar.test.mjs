import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import {verifyPackedArchive} from "./verify-asar.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "packed-desktop-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, "app"), archive = join(root, "app.asar");
  const metadata = JSON.stringify({name: "fixture", version: "1.2.3", main: "index.js"});
  const code = 'console.log("controlled fixture");\n';
  await mkdir(source);
  await writeFile(join(source, "package.json"), metadata);
  await writeFile(join(source, "index.js"), code);
  await asar.createPackage(source, archive);
  return {archive, metadata, code};
}

test("accepts the actual entry point, version and every packed file hash", async t => {
  const {archive, metadata, code} = await fixture(t);
  assert.deepEqual(verifyPackedArchive(archive, "1.2.3"), {
    version: "1.2.3", main: "index.js", files: 2,
    bytes: Buffer.byteLength(metadata + code), unpackedFiles: 0,
  });
  assert.throws(() => verifyPackedArchive(archive, "1.2.4"), /version differs/);
});

test("refuses shifted offsets when a build file grows during packaging", async t => {
  const {archive, metadata} = await fixture(t), bytes = await readFile(archive);
  const offset = bytes.indexOf(Buffer.from(metadata));
  assert(offset > 0);
  await writeFile(archive, Buffer.concat([bytes.subarray(0, offset), Buffer.from("changed build file"), bytes.subarray(offset)]));
  assert.throws(() => verifyPackedArchive(archive, "1.2.3"), /package.json is not valid JSON/);
});

test("refuses a modified packed module even when package.json is still valid", async t => {
  const {archive, code} = await fixture(t), bytes = await readFile(archive);
  const offset = bytes.indexOf(Buffer.from(code));
  assert(offset > 0); bytes[offset] ^= 1;
  await writeFile(archive, bytes);
  assert.throws(() => verifyPackedArchive(archive, "1.2.3"), /integrity mismatch: index.js/);
});
