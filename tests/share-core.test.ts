import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderFunnelService } from "../deployment/service-templates.js";
import { applyShare, type ShareIo, type ShareRequest } from "../privileged/share.js";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const config = `${JSON.stringify({ version: 2, mode: "tailscale-funnel", listener: { kind: "unix", path: "/run/pi-together/app.sock" }, publicOrigin: "https://node.tailnet.ts.net", tailscaleDnsName: "node.tailnet.ts.net", proxySecret: "p".repeat(43), principals: [{ provider: "github", subject: "1", login: "alice", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" }], sharedRepositoryFolders: ["/srv/work"] }, null, 2)}\n`;
const manifest = '{"mode":"tailscale-funnel"}\n';
function request(operation: "enable" | "disable"): ShareRequest { return { protocolVersion: 1, action: "share", operation, invokingUid: 1000, expected: { configSha256: sha(config), manifestSha256: sha(manifest) } }; }
function io(): { value: ShareIo; calls: string[] } { const calls: string[] = []; return { calls, value: { load: async () => ({ config, manifest, funnelUnit: renderFunnelService(), configOwnerUid: 1000 }), setEnabled: async (enabled) => { calls.push(enabled ? "enable" : "disable"); }, verify: async (enabled, dns) => { calls.push(`verify:${enabled}:${dns}`); } } }; }
describe("share privileged core", () => {
  it("validates exact state before enabling or disabling one owned Funnel unit", async () => { const target = io(); await applyShare(request("enable"), target.value); expect(target.calls).toEqual(["enable", "verify:true:node.tailnet.ts.net"]); });
  it("rejects stale hashes, wrong owners, and altered commands before service mutation", async () => {
    const stale = request("enable"); stale.expected.configSha256 = "0".repeat(64); await expect(applyShare(stale, io().value)).rejects.toThrow(/changed/);
    const owner = io(); owner.value.load = async () => ({ config, manifest, funnelUnit: renderFunnelService(), configOwnerUid: 2000 }); await expect(applyShare(request("enable"), owner.value)).rejects.toThrow(/owner/);
    const altered = io(); altered.value.load = async () => ({ config, manifest, funnelUnit: renderFunnelService().replace("--https=443", "--bg"), configOwnerUid: 1000 }); await expect(applyShare(request("enable"), altered.value)).rejects.toThrow(/unit/);
    const conflict = io(); conflict.value.load = async () => ({ config, manifest, funnelUnit: renderFunnelService(), funnelStatus: '{"existing":true}', configOwnerUid: 1000 }); await expect(applyShare(request("enable"), conflict.value)).rejects.toThrow(/conflicts/);
  });
});
