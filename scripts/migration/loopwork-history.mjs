import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createArchive,verifyArchive,readArchiveRecord,browseArchive } from "./loopwork-history-lib.mjs";
export { createArchive,verifyArchive,readArchiveRecord,copyDatabase } from "./loopwork-history-lib.mjs";
const json=(value)=>JSON.stringify(value,(_key,item)=>typeof item==="bigint"?{sqlite_integer:String(item)}:item instanceof Uint8Array?{sqlite_blob:Buffer.from(item).toString("base64")}:item);
async function main(args) {
  const [command, ...rest] = args, options = {};
  for (let index = 0; index < rest.length; index += 2) { const name = rest[index]; if (!name?.startsWith("--") || !rest[index + 1] || Object.hasOwn(options, name)) throw new Error("Use distinct --option value pairs"); options[name] = rest[index + 1]; }
  const allowed = command === "capture" ? ["--source-root", "--data-root", "--output"] : command === "verify" ? ["--archive"] : command === "record" ? ["--archive", "--table", "--id"] : command === "packet" ? ["--archive","--expected-hash","--task"] : [];
  if (!allowed.length || Object.keys(options).length !== allowed.length || allowed.some((key) => !options[key])) throw new Error("Usage: capture --source-root /source --data-root /data --output /archive | verify --archive /archive | record --archive /archive --table tasks --id original-id | packet --archive /archive --expected-hash sha256 --task original-id");
  if (command === "capture") return createArchive({ sourceRoot: options["--source-root"], dataRoot: options["--data-root"], output: options["--output"] });
  if (command === "verify") { const manifest = await verifyArchive(options["--archive"]); return { hash: manifest.hash, verified: true, databases: manifest.databases.map((entry) => ({ role: entry.role, tables: entry.summary.tables.length })), historical_only: true }; }
  if (command === "packet") return browseArchive(options["--archive"],options["--expected-hash"],{action:"packet",task_id:options["--task"]});
  return readArchiveRecord(options["--archive"], options["--table"], options["--id"]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((result) => process.stdout.write(`${json(result)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
