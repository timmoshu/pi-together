import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const release = {
  version: "2.10.1",
  baseUrl: "https://github.com/letsencrypt/pebble/releases/download/v2.10.1",
  assets: {
    "linux-x64": { archive: "pebble-linux-amd64.tar.gz", sha256: "4f2fcb5bca8c85c9cf73ad140fccfc0d2be40bd81ab99879c79b7b8a0b4f70ed" },
    "linux-arm64": { archive: "pebble-linux-arm64.tar.gz", sha256: "b53fd072a69eb7692451de4e8b0667e0bdf5cccd7e36fc51b8eaf2fcc135ed9f" },
  },
} as const;
type Target = keyof typeof release.assets;

async function boundedDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Pebble download failed with HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 100 * 1024 * 1024) { await reader.cancel(); throw new Error("Pebble archive exceeds size limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
function findBinary(root: string): string {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === "pebble") return path;
    }
  }
  throw new Error("Pebble archive did not contain its expected binary");
}

const target = (process.env.PEBBLE_TARGET ?? "linux-x64") as Target;
const asset = release.assets[target];
if (!asset) throw new Error(`unsupported Pebble target: ${target}`);
const output = process.argv[2];
if (!output) throw new Error("output path argument is required");
const root = mkdtempSync(join(tmpdir(), "pi-together-pebble-"));
try {
  const bytes = await boundedDownload(`${release.baseUrl}/${asset.archive}`);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Pebble archive checksum mismatch");
  const archive = join(root, basename(asset.archive));
  writeFileSync(archive, bytes, { mode: 0o600 });
  execFileSync("/bin/tar", ["-xzf", archive, "-C", root, "--no-same-owner", "--no-same-permissions"]);
  const destination = resolve(output);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(findBinary(root), destination);
  chmodSync(destination, 0o755);
  process.stdout.write(`${release.version}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
