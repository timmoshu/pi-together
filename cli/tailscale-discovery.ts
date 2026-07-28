import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { supportsTailscaleVersion } from "../deployment/tailscale-release.js";

export type TailscaleProbe =
  | { status: "missing" }
  | { status: "incompatible"; path: string; version: string }
  | { status: "needs-login"; path: string; version: string }
  | { status: "unhealthy" | "expired" | "probe-failed"; path?: string; version?: string }
  | { status: "ready"; path: string; version: string; dnsName: string; keyExpiry: string };

export interface TailscaleProbeIo {
  findExecutable(): Promise<string | null>;
  realpath(path: string): Promise<string>;
  inspectExecutable(path: string): Promise<{ file: boolean; uid: number; mode: number }>;
  exec(file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}
const exec = promisify(execFile);
export const nodeTailscaleProbeIo: TailscaleProbeIo = {
  findExecutable: async () => {
    try { return (await exec("/usr/bin/which", ["tailscale"], { timeout: 5_000 })).stdout.trim() || null; }
    catch { return null; }
  },
  realpath,
  inspectExecutable: async (path) => { const info = await lstat(path); return { file: info.isFile(), uid: info.uid, mode: info.mode & 0o777 }; },
  exec: async (file, args) => {
    const result = await exec(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};
const BaseStatus = z.object({ BackendState: z.string() }).passthrough();
const RunningStatus = z.object({
  BackendState: z.literal("Running"),
  MagicDNSSuffix: z.string().optional(),
  CurrentTailnet: z.object({ MagicDNSEnabled: z.boolean().optional() }).passthrough().optional(),
  Self: z.object({ DNSName: z.string(), KeyExpiry: z.string() }).passthrough().optional(),
  Health: z.array(z.string()).max(64).optional(),
}).passthrough();

export async function probeTailscale(io: TailscaleProbeIo = nodeTailscaleProbeIo, now = new Date()): Promise<TailscaleProbe> {
  const found = await io.findExecutable();
  if (!found) return { status: "missing" };
  let path = found;
  let version: string | undefined;
  try {
    path = await io.realpath(found);
    const info = await io.inspectExecutable(path);
    if (!info.file || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("unsafe executable");
    version = (await io.exec(path, ["version"])).stdout.split(/\r?\n/, 1)[0]!.trim();
    if (!supportsTailscaleVersion(version)) return { status: "incompatible", path, version };
    let raw: string;
    try {
      raw = (await io.exec(path, ["status", "--json"])).stdout;
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout !== "string" || !stdout.trim()) throw error;
      raw = stdout;
    }
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("status too large");
    const parsed = JSON.parse(raw) as unknown;
    const base = BaseStatus.parse(parsed);
    if (base.BackendState !== "Running") return { status: "needs-login", path, version };
    const status = RunningStatus.parse(parsed);
    if (status.Health?.length || status.CurrentTailnet?.MagicDNSEnabled !== true || !status.Self) return { status: "unhealthy", path, version };
    const dnsName = status.Self.DNSName.replace(/\.$/, "").toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/.test(dnsName)) throw new Error("invalid DNS name");
    const expiry = new Date(status.Self.KeyExpiry);
    if (!Number.isFinite(expiry.getTime())) throw new Error("invalid expiry");
    if (expiry.getTime() <= now.getTime()) return { status: "expired", path, version };
    return { status: "ready", path, version, dnsName, keyExpiry: expiry.toISOString() };
  } catch {
    return { status: "probe-failed", path, ...(version ? { version } : {}) };
  }
}
