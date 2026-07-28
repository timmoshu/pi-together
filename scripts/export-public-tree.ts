import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { classifyExportPaths } from "./public-export-policy.js";

const root = await realpath(process.cwd());
const requested = process.argv[2];
if (!requested || !isAbsolute(requested)) throw new Error("export destination must be an absolute path");
const destination = resolve(requested);
const relation = relative(root, destination);
if (!relation || (!relation.startsWith(`..${sep}`) && relation !== "..")) throw new Error("export destination must be outside the source tree");
await mkdir(destination, { mode: 0o700 });
if ((await readdir(destination)).length) throw new Error("export destination must be empty");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  .split("\0").filter(Boolean);
const classification = classifyExportPaths(tracked);
if (classification.unexpected.length || classification.missingRequired.length) {
  throw new Error(`public export policy failed: ${classification.unexpected.length} unexpected, ${classification.missingRequired.length} missing`);
}
for (const path of classification.included) {
  const source = resolve(root, path);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`public export path is not a regular file: ${path}`);
  const target = resolve(destination, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(source, target);
}
process.stdout.write(`${JSON.stringify({ ok: true, destination, included: classification.included.length, excluded: classification.intentionallyExcluded.length })}\n`);
