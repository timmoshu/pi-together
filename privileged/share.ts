import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { renderFunnelService } from "../deployment/service-templates.js";
import { AppConfigSchema } from "../server/config.js";

const exec = promisify(execFile);
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
export const ShareRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("share"),
  operation: z.enum(["enable", "disable"]),
  invokingUid: z.number().int().positive(),
  expected: z.object({ configSha256: SHA256, manifestSha256: SHA256 }).strict(),
}).strict();
export type ShareRequest = z.infer<typeof ShareRequestSchema>;

export interface ShareState {
  config: string;
  manifest: string;
  funnelUnit: string;
  funnelStatus?: string;
  configOwnerUid: number;
}
export interface ShareIo {
  load(request: ShareRequest): Promise<ShareState>;
  setEnabled(enabled: boolean): Promise<void>;
  verify(enabled: boolean, dnsName: string): Promise<void>;
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equalDigest(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export async function applyShare(value: unknown, io: ShareIo): Promise<void> {
  const request = ShareRequestSchema.parse(value);
  const current = await io.load(request);
  if (current.configOwnerUid !== request.invokingUid) throw new Error("Funnel config owner does not match invoking user");
  if (!equalDigest(sha256(current.config), request.expected.configSha256)
    || !equalDigest(sha256(current.manifest), request.expected.manifestSha256)) {
    throw new Error("Funnel configuration changed after review");
  }
  z.object({ mode: z.literal("tailscale-funnel") }).passthrough().parse(JSON.parse(current.manifest));
  const config = AppConfigSchema.parse(JSON.parse(current.config));
  if (config.mode !== "tailscale-funnel" || config.publicOrigin !== `https://${config.tailscaleDnsName}`) {
    throw new Error("sharing requires canonical Funnel config");
  }
  if (current.funnelUnit !== renderFunnelService()) throw new Error("Funnel systemd unit is not canonical");
  const enabled = request.operation === "enable";
  const emptyInventory = current.funnelStatus === undefined
    || current.funnelStatus.trim() === "{}"
    || current.funnelStatus.trim() === '{"funnel":{},"serve":{}}';
  if (enabled && !emptyInventory) throw new Error("an existing Serve/Funnel handler conflicts with Pi Together HTTPS 443 activation");
  await io.setEnabled(enabled);
  await io.verify(enabled, config.tailscaleDnsName);
}

export class RootShareIo implements ShareIo {
  private readonly journal = "/var/lib/pi-together/share-journal.json";
  constructor(request: Pick<ShareRequest, "invokingUid">) {
    if (process.getuid?.() !== 0 || Number(process.env.SUDO_UID) !== request.invokingUid) {
      throw new Error("share operation requires matching sudo provenance");
    }
  }
  private async read(path: string, uid: number, mode: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== mode || info.size > 1024 * 1024) {
        throw new Error(`unsafe share file: ${path}`);
      }
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  async recoverPending(): Promise<void> {
    try {
      const handle = await open(this.journal, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        const value = JSON.parse(await handle.readFile("utf8")) as { schemaVersion?: unknown; operation?: unknown };
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600 || value.schemaVersion !== 1
          || !["enable", "disable"].includes(String(value.operation))) throw new Error("unsafe share recovery journal");
      } finally { await handle.close(); }
      await exec("/bin/systemctl", ["disable", "--now", "pi-together-funnel.service"], { timeout: 30_000 });
      await rm(this.journal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async load(request: ShareRequest): Promise<ShareState> {
    await this.recoverPending();
    const [funnel, serve] = await Promise.all(["funnel", "serve"].map((command) =>
      exec("/usr/bin/tailscale", [command, "status", "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 })));
    return {
      config: await this.read("/etc/pi-together/config.json", request.invokingUid, 0o600),
      manifest: await this.read("/var/lib/pi-together/install-manifest.json", 0, 0o644),
      funnelUnit: await this.read("/etc/systemd/system/pi-together-funnel.service", 0, 0o644),
      funnelStatus: JSON.stringify({ funnel: JSON.parse(funnel.stdout), serve: JSON.parse(serve.stdout) }),
      configOwnerUid: request.invokingUid,
    };
  }
  async setEnabled(enabled: boolean): Promise<void> {
    const handle = await open(this.journal, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, operation: enabled ? "enable" : "disable" })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await exec("/bin/systemctl", enabled
      ? ["enable", "--now", "pi-together-funnel.service"]
      : ["disable", "--now", "pi-together-funnel.service"], {
      timeout: 30_000,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
    });
  }
  async verify(enabled: boolean, dnsName: string): Promise<void> {
    let active = true;
    try { await exec("/bin/systemctl", ["is-active", "--quiet", "pi-together-funnel.service"], { timeout: 10_000 }); }
    catch { active = false; }
    if (active !== enabled) throw new Error("Funnel service state does not match request");
    const result = await exec("/usr/bin/tailscale", ["funnel", "status", "--json"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (enabled && (!result.stdout.includes(dnsName) || !result.stdout.includes("127.0.0.1:43118"))) {
      throw new Error("Funnel route read-back failed");
    }
    await rm(this.journal);
  }
}
