import { describe, expect, it } from "vitest";
import { InstallManifestSchema, buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";

describe("installation ownership manifest", () => {
  it("inventories only exact generated integration while preserving config and backups", () => {
    const manifest = buildInstallManifest("reverse-proxy", "0.1.0", "/var/lib/pi-together/downloads/oauth2-proxy-v7.15.3.linux-amd64.tar.gz");
    expect(InstallManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.entries.filter((entry) => entry.uninstall === "preserve")).toEqual([
      { path: "/etc/pi-together/config.json", kind: "file", uninstall: "preserve" },
      { path: "/var/lib/pi-together/backups", kind: "directory", uninstall: "preserve" },
    ]);
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("/var/lib/pi-together/user-management-journal.json");
    expect(manifest.entries.find((entry) => entry.path.endsWith("user-management-journal.json"))?.uninstall).toBe("remove");
    expect(paths).not.toContain("/etc/pi-together");
    expect(paths).not.toContain("/var/lib/pi-together");
    expect(paths.every((path) => !path.includes("/.pi/") && !path.includes("workspace") && !path.includes("credentials"))).toBe(true);
    expect(renderInstallManifest(manifest)).not.toContain("{{secret:");
    expect(renderInstallManifest(manifest)).not.toContain("proxySecret");
  });

  it("inventories only Pi Together-owned Funnel integration and preserves Tailscale itself", () => {
    const funnel = buildInstallManifest("tailscale-funnel", "0.1.0", "/var/lib/pi-together/downloads/oauth2-proxy-v7.15.3.linux-amd64.tar.gz");
    const paths = funnel.entries.map((entry) => entry.path);
    expect(paths).toContain("/etc/systemd/system/pi-together-funnel.service");
    expect(paths).toContain("/etc/pi-together/nginx-funnel.conf");
    expect(paths).not.toContain("/usr/bin/tailscale");
    expect(paths).not.toContain("/var/lib/tailscale");
    expect(paths).not.toContain("/etc/systemd/system/tailscaled.service");
  });

  it("keeps local inventory minimal and rejects arbitrary or duplicate paths", () => {
    const local = buildInstallManifest("local", "0.1.0");
    expect(local.entries.some((entry) => entry.path.includes("nginx"))).toBe(false);
    const duplicate = structuredClone(local);
    duplicate.entries.push(duplicate.entries[0]!);
    expect(() => InstallManifestSchema.parse(duplicate)).toThrow(/duplicate/);
    expect(() => buildInstallManifest("reverse-proxy", "0.1.0", "/tmp/attacker.tar.gz")).toThrow(/pinned oauth archive/);
  });
});
