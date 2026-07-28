import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { z } from "zod";
import { supportsTailscaleVersion, TAILSCALE_RELEASE } from "../deployment/tailscale-release.js";

export const PrepareTailscaleRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("prepare-tailscale"),
  invokingUid: z.number().int().positive(),
  distro: z.enum(["debian", "ubuntu"]),
  acceptedTerms: z.literal(true),
}).strict();
export type PrepareTailscaleRequest = z.infer<typeof PrepareTailscaleRequestSchema>;
export const LoginTailscaleRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("login-tailscale"),
  invokingUid: z.number().int().positive(),
}).strict();
export type LoginTailscaleRequest = z.infer<typeof LoginTailscaleRequestSchema>;
const exec = promisify(execFile);
const journal = "/var/lib/pi-together/tailscale-prepare-journal.json";
const archive = `/var/lib/pi-together/downloads/tailscale_${TAILSCALE_RELEASE.version}_amd64.deb`;

function assertRootInvocation(uid: number, operation: string): void {
  if (process.getuid?.() !== 0 || Number(process.env.SUDO_UID) !== uid) {
    throw new Error(`${operation} requires matching sudo provenance`);
  }
}
async function assertTailscaleExecutable(): Promise<void> {
  const info = await lstat("/usr/bin/tailscale");
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("Tailscale executable metadata is unsafe");
  }
}
export async function loginTailscale(value: unknown): Promise<void> {
  const request = LoginTailscaleRequestSchema.parse(value);
  assertRootInvocation(request.invokingUid, "Tailscale login");
  await assertTailscaleExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/tailscale", ["up", "--timeout=5m"], {
      stdio: "inherit",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tailscale up exited ${code ?? "unknown"}`)));
  });
}
async function downloadExact(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { headers: { "user-agent": "pi-together" }, timeout: 30_000 }, (response) => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume();
        reject(new Error(`Tailscale download returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > TAILSCALE_RELEASE.bytes) request.destroy(new Error("Tailscale package exceeds pinned size"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("Tailscale package download timed out")));
    request.on("error", reject);
    request.end();
  });
}
async function writeOrVerifyJournal(): Promise<void> {
  await mkdir("/var/lib/pi-together", { recursive: true, mode: 0o750 });
  try {
    const handle = await open(journal, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, version: TAILSCALE_RELEASE.version })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const handle = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const parsed = JSON.parse(await handle.readFile("utf8")) as { schemaVersion?: unknown; version?: unknown };
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600
        || parsed.schemaVersion !== 1 || parsed.version !== TAILSCALE_RELEASE.version) {
        throw new Error("unsafe Tailscale preparation journal");
      }
    } finally { await handle.close(); }
  }
}
export async function recoverTailscalePreparation(invokingUid: number): Promise<void> {
  assertRootInvocation(invokingUid, "Tailscale preparation recovery");
  try {
    const handle = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const parsed = JSON.parse(await handle.readFile("utf8")) as { schemaVersion?: unknown; version?: unknown };
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600
        || parsed.schemaVersion !== 1 || parsed.version !== TAILSCALE_RELEASE.version) {
        throw new Error("unsafe Tailscale preparation journal");
      }
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let names: string[] = [];
  try { names = await readdir("/var/lib/pi-together/downloads"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (names.length > 10_000) throw new Error("Tailscale recovery download inventory is unexpectedly large");
  const temporary = names.filter((name) => /^tailscale-[1-9]\d*\.tmp$/.test(name));
  for (const name of temporary) {
    const path = `/var/lib/pi-together/downloads/${name}`;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o777) !== 0o600 || info.size > TAILSCALE_RELEASE.bytes) {
      throw new Error("unsafe Tailscale recovery temporary archive");
    }
  }
  await Promise.all([rm(journal), rm(archive, { force: true }), ...temporary.map((name) => rm(`/var/lib/pi-together/downloads/${name}`))]);
}

export async function prepareTailscale(value: unknown): Promise<void> {
  const request = PrepareTailscaleRequestSchema.parse(value);
  assertRootInvocation(request.invokingUid, "Tailscale preparation");
  if (process.arch !== "x64") throw new Error("Tailscale Funnel preparation is supported only on amd64");
  try {
    await assertTailscaleExecutable();
    const installed = (await exec("/usr/bin/tailscale", ["version"], { timeout: 10_000 })).stdout;
    if (!supportsTailscaleVersion(installed)) throw new Error("existing Tailscale version is outside the qualified line");
    await Promise.all([rm(journal, { force: true }), rm(archive, { force: true })]);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeOrVerifyJournal();
  const bytes = await downloadExact(TAILSCALE_RELEASE.urls[request.distro]);
  if (bytes.length !== TAILSCALE_RELEASE.bytes
    || createHash("sha256").update(bytes).digest("hex") !== TAILSCALE_RELEASE.sha256) {
    throw new Error("Tailscale package size or checksum mismatch");
  }
  await mkdir("/var/lib/pi-together/downloads", { recursive: true, mode: 0o700 });
  const temporary = `/var/lib/pi-together/downloads/tailscale-${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await chmod(temporary, 0o600);
    const fields = (await exec("/usr/bin/dpkg-deb", ["--field", temporary, "Package", "Version", "Architecture", "Depends"], {
      timeout: 30_000, maxBuffer: 64 * 1024,
    })).stdout;
    if (!fields.includes("Package: tailscale") || !fields.includes(`Version: ${TAILSCALE_RELEASE.version}`)
      || !fields.includes("Architecture: amd64") || !fields.includes("Depends: iptables")) {
      throw new Error("Tailscale Debian package metadata mismatch");
    }
    await rename(temporary, archive);
    await exec("/usr/bin/apt-get", ["install", "--yes", archive], {
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
    await assertTailscaleExecutable();
    await exec("/bin/systemctl", ["enable", "--now", "tailscaled.service"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
    if ((await exec("/bin/systemctl", ["is-active", "tailscaled.service"], { timeout: 10_000 })).stdout.trim() !== "active") {
      throw new Error("installed tailscaled service did not become active");
    }
    if (!supportsTailscaleVersion((await exec("/usr/bin/tailscale", ["version"], { timeout: 10_000 })).stdout)) {
      throw new Error("installed Tailscale failed version verification");
    }
    await Promise.all([rm(journal, { force: true }), rm(archive, { force: true })]);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
