import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const tools = [
  { name: "gitleaks", version: "8.30.1", archive: "gitleaks_8.30.1_linux_x64.tar.gz", sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", args: ["dir", ".", "--no-banner", "--redact", "--exit-code", "1"] },
  { name: "trufflehog", version: "3.96.0", archive: "trufflehog_3.96.0_linux_amd64.tar.gz", sha256: "7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0", args: ["filesystem", ".", "--only-verified", "--fail", "--no-update"] },
] as const;
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`secret scanner download failed with HTTP ${response.status}`);
  const maximum = 100 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); throw new Error("secret scanner archive exceeds size limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
const root = await mkdtemp(join(tmpdir(), "pi-together-secret-scanners-"));
try {
  for (const tool of tools) {
    const url = `https://github.com/${tool.name === "gitleaks" ? "gitleaks/gitleaks" : "trufflesecurity/trufflehog"}/releases/download/v${tool.version}/${tool.archive}`;
    const bytes = await download(url);
    if (createHash("sha256").update(bytes).digest("hex") !== tool.sha256) throw new Error(`${tool.name} archive checksum mismatch`);
    const archive = join(root, basename(tool.archive));
    const extract = join(root, `${tool.name}-extract`);
    await mkdir(extract);
    await writeFile(archive, bytes, { mode: 0o600 });
    execFileSync("/bin/tar", ["-xzf", archive, "-C", extract, "--no-same-owner", "--no-same-permissions"]);
    const names = await readdir(extract);
    if (!names.includes(tool.name)) throw new Error(`${tool.name} archive layout is invalid`);
    const binary = join(root, tool.name);
    await copyFile(join(extract, tool.name), binary);
    await chmod(binary, 0o755);
    execFileSync(binary, [...tool.args], { stdio: "inherit", timeout: 5 * 60_000 });
  }
  process.stdout.write(JSON.stringify({ ok: true, scope: "current-filesystem", tools: tools.map(({ name, version }) => ({ name, version })) }) + "\n");
} finally { await rm(root, { recursive: true, force: true }); }
