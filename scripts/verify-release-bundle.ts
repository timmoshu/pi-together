import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { candidateRelease, ReleaseMetadataSchema, validateSignedRelease } from "../cli/upgrade-core.js";

const root = process.argv[2] ?? "release-bundle";
const metadata = ReleaseMetadataSchema.parse(JSON.parse(await readFile(join(root, "metadata.json"), "utf8")));
const signature = JSON.parse(await readFile(join(root, "signature.json"), "utf8")) as { keyId?: string; signature?: string };
const candidate = validateSignedRelease({ metadata, keyId: signature.keyId ?? "", signature: signature.signature ?? "" });
const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
if (archives.length !== 1 || basename(archives[0]!) !== archives[0]) throw new Error("release bundle must contain exactly one package archive");
const archivePath = join(root, archives[0]!);
const archiveInfo = await stat(archivePath);
if (!archiveInfo.isFile() || archiveInfo.size > 256 * 1024 * 1024) throw new Error("release bundle package archive is not a bounded regular file");
const archive = await readFile(archivePath);
if (createHash("sha256").update(archive).digest("hex") !== metadata.packageSha256) throw new Error("release bundle package checksum mismatch");
const listing = execFileSync("/bin/tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim().split("\n");
const types = execFileSync("/bin/tar", ["-tvzf", archivePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim().split("\n");
if (listing.length > 10_000 || listing.some((path) => !path.startsWith("package/") || path.includes("../") || path.includes("//"))
  || types.some((line) => !/^[d-]/.test(line))) throw new Error("release bundle archive paths or types are unsafe");
const work = await mkdtemp(join(tmpdir(), "pi-together-verify-release-"));
try {
  await mkdir(join(work, "extract"));
  execFileSync("/bin/tar", ["-xzf", archivePath, "-C", join(work, "extract"), "--no-same-owner", "--no-same-permissions"]);
  const packageRoot = join(work, "extract/package");
  const releaseManifestBytes = await readFile(join(packageRoot, "dist/release/manifest.json"));
  if (createHash("sha256").update(releaseManifestBytes).digest("hex") !== metadata.releaseManifestSha256) throw new Error("release bundle manifest checksum mismatch");
  const manifest = JSON.parse(releaseManifestBytes.toString("utf8")) as { package?: { version?: string }; artifacts?: Array<{ path: string; bytes: number; sha256: string }> };
  if (manifest.package?.version !== metadata.version || !Array.isArray(manifest.artifacts)) throw new Error("release bundle manifest is invalid");
  for (const artifact of manifest.artifacts) {
    if (!artifact.path.startsWith("dist/") || artifact.path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(artifact.path)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("release bundle artifact metadata is unsafe");
    }
    const bytes = await readFile(join(packageRoot, artifact.path));
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("release bundle artifact checksum mismatch");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, version: candidateRelease(candidate), keyId: signature.keyId, artifacts: manifest.artifacts.length, sourceRef: metadata.sourceRef })}\n`);
} finally { await rm(work, { recursive: true, force: true }); }
