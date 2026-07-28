import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalReleaseMetadata, RELEASE_SIGNING_KEY_ID, ReleaseMetadataSchema } from "../cli/upgrade-core.js";

const keyPath = process.env.PI_TOGETHER_RELEASE_KEY;
if (!keyPath?.startsWith("/")) throw new Error("PI_TOGETHER_RELEASE_KEY must name an absolute Ed25519 key");
const keyHandle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let keyBytes: Buffer;
try {
  const keyInfo = await keyHandle.stat();
  if (!keyInfo.isFile() || (keyInfo.mode & 0o777) !== 0o600 || keyInfo.uid !== (process.getuid?.() ?? keyInfo.uid) || keyInfo.size > 64 * 1024) {
    throw new Error("release key must be an invoking-user-owned bounded mode-0600 regular file");
  }
  keyBytes = await keyHandle.readFile();
} finally { await keyHandle.close(); }

const pkg = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
if (dirty) throw new Error("release source tree must be clean");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("release source commit is invalid");
const sourceRef = process.env.PI_TOGETHER_RELEASE_SOURCE_REF;
if (sourceRef !== `refs/tags/v${pkg.version}`) throw new Error("release builds require the exact version tag");
const tagCommit = execFileSync("git", ["rev-list", "-n", "1", sourceRef.replace("refs/tags/", "")], { encoding: "utf8" }).trim();
if (tagCommit !== sourceCommit) throw new Error("release tag does not identify HEAD");

const releaseManifest = await readFile("dist/release/manifest.json");
const work = await mkdtemp(join(tmpdir(), "pi-together-release-bundle-"));
const output = join(process.cwd(), "release-bundle");
try {
  const packResult = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })) as Array<{ filename: string }>;
  const packedName = packResult.length === 1 ? packResult[0]?.filename : undefined;
  if (!packedName || basename(packedName) !== packedName || !packedName.endsWith(".tgz")) throw new Error("npm pack returned an unsafe archive name");
  const archiveSource = join(work, packedName);
  const archive = await readFile(archiveSource);
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("SOURCE_DATE_EPOCH is required for release provenance");
  const metadata = ReleaseMetadataSchema.parse({
    schemaVersion: 1,
    channel: "stable",
    version: pkg.version,
    packageSha256: createHash("sha256").update(archive).digest("hex"),
    releaseManifestSha256: createHash("sha256").update(releaseManifest).digest("hex"),
    sourceRef,
    sourceCommit,
    builder: "github-actions",
    createdAt: new Date(epoch * 1000).toISOString(),
  });
  const signature = sign(null, canonicalReleaseMetadata(metadata), createPrivateKey(keyBytes)).toString("base64");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { mode: 0o700 });
  const archiveName = `${pkg.name}-${pkg.version}.tgz`;
  await copyFile(archiveSource, join(output, archiveName));
  await writeFile(join(output, "metadata.json"), canonicalReleaseMetadata(metadata), { mode: 0o600 });
  await writeFile(join(output, "signature.json"), `${JSON.stringify({ keyId: RELEASE_SIGNING_KEY_ID, algorithm: "Ed25519", signature }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, "SHA256SUMS"), `${metadata.packageSha256}  ${archiveName}\n${metadata.releaseManifestSha256}  dist/release/manifest.json\n`, { mode: 0o600 });
  for (const file of [archiveName, "metadata.json", "signature.json", "SHA256SUMS"]) await chmod(join(output, file), 0o600);
  process.stdout.write(`${JSON.stringify({ ok: true, version: pkg.version, sourceCommit, keyId: RELEASE_SIGNING_KEY_ID, output })}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
