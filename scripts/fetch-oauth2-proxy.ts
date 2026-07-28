import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { OAUTH2_PROXY_RELEASE } from "../deployment/templates.js";

type Target = keyof typeof OAUTH2_PROXY_RELEASE.assets;

function findBinary(root: string): string {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === "oauth2-proxy") return path;
    }
  }
  throw new Error("oauth2-proxy archive did not contain the expected binary");
}

interface DownloadOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  timeoutMs?: number;
}

class TransientDownloadError extends Error {}

function isTransientDownloadError(error: unknown): boolean {
  return error instanceof TransientDownloadError
    || error instanceof TypeError
    || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name));
}

export async function downloadBounded(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("oauth2-proxy download retry policy is invalid");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        if ([408, 425, 429].includes(response.status) || response.status >= 500) {
          throw new TransientDownloadError(`oauth2-proxy download failed with HTTP ${response.status}`);
        }
        throw new Error(`oauth2-proxy download failed with HTTP ${response.status}`);
      }
      const maximumBytes = 100 * 1024 * 1024;
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("oauth2-proxy archive exceeds size limit");
      if (!response.body) throw new Error("oauth2-proxy download returned no body");
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new Error("oauth2-proxy archive exceeds size limit");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      lastError = error;
      if (!isTransientDownloadError(error) || attempt === attempts) throw error;
      await sleep(attempt === 1 ? 1_000 : 4_000);
    }
  }
  throw lastError;
}

export async function fetchOauth2Proxy(target: Target, outputPath: string): Promise<void> {
  const asset = OAUTH2_PROXY_RELEASE.assets[target];
  if (!asset) throw new Error(`unsupported oauth2-proxy target: ${target}`);
  const root = mkdtempSync(join(tmpdir(), "pi-together-oauth2-proxy-"));
  try {
    const url = `${OAUTH2_PROXY_RELEASE.baseUrl}/${asset.archive}`;
    const bytes = await downloadBounded(url);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error("oauth2-proxy archive checksum mismatch");

    const archive = join(root, basename(asset.archive));
    writeFileSync(archive, bytes, { mode: 0o600 });
    execFileSync("tar", ["-xzf", archive, "-C", root]);
    const destination = resolve(outputPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(findBinary(root), destination);
    chmodSync(destination, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("fetch-oauth2-proxy.ts")) {
  const target = (process.env.OAUTH2_PROXY_TARGET ?? "linux-x64") as Target;
  const output = process.argv[2];
  if (!output) throw new Error("output path argument is required");
  await fetchOauth2Proxy(target, output);
  process.stdout.write(`${OAUTH2_PROXY_RELEASE.version}\n`);
}
