import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { uninstallValidated, validateUninstallRequest, type UninstallIo, type UninstallOperation } from "../privileged/uninstall-core.js";

function request(mode: "local" | "reverse-proxy" | "tailscale-funnel" = "local", purgeConfig = false) {
  const manifest = buildInstallManifest(mode, "0.1.0", mode !== "local" ? "/var/lib/pi-together/downloads/oauth2-proxy-v7.15.3.linux-amd64.tar.gz" : undefined);
  const bytes = renderInstallManifest(manifest);
  return { protocolVersion: 1 as const, action: "uninstall" as const, invokingUid: process.getuid?.() ?? 1000, manifest, manifestSha256: createHash("sha256").update(bytes).digest("hex"), purgeConfig };
}
class FakeIo implements UninstallIo {
  executed: string[] = [];
  recorded: string[] = [];
  recovered = new Set<string>();
  fail?: string;
  verified = 0;
  finished = 0;
  async verifyManifest(): Promise<void> { this.verified++; }
  async recover(): Promise<Set<string>> { return this.recovered; }
  async execute(operation: UninstallOperation): Promise<void> { if (operation.id === this.fail) throw new Error("synthetic interruption"); this.executed.push(operation.id); }
  async record(id: string): Promise<void> { this.recorded.push(id); }
  async finish(): Promise<void> { this.finished++; }
}

describe("uninstall lifecycle core", () => {
  it("derives one exact public removal sequence while preserving config and backups", () => {
    const validated = validateUninstallRequest(request("reverse-proxy"));
    expect(validated.operations.map((operation) => operation.id)).toMatchSnapshot();
    expect(validated.operations.some((operation) => operation.target === "/etc/pi-together/config.json")).toBe(false);
    expect(validated.operations.every((operation) => !operation.target.includes("/.pi/") && !operation.target.includes("workspace") && !operation.target.includes("backups"))).toBe(true);
  });

  it("stops and removes only owned Funnel integration while preserving Tailscale", () => {
    const validated = validateUninstallRequest(request("tailscale-funnel"));
    const targets = validated.operations.map((operation) => operation.target);
    expect(validated.operations.slice(0, 3).map((operation) => operation.id)).toEqual(["stop-funnel", "stop-edge", "stop-oauth"]);
    expect(targets).toContain("/etc/systemd/system/pi-together-funnel.service");
    expect(targets.every((target) => !target.includes("/var/lib/tailscale") && target !== "tailscaled.service")).toBe(true);
  });

  it("accepts a canonical stable release inventory", () => {
    const value = request();
    value.manifest = buildInstallManifest("local", "0.1.0");
    value.manifestSha256 = createHash("sha256").update(renderInstallManifest(value.manifest)).digest("hex");
    const validated = validateUninstallRequest(value);
    expect(validated.operations).toContainEqual(expect.objectContaining({ target: "/opt/pi-together/releases/0.1.0" }));
  });

  it("adds only the exact config file for explicit purge and never backups", () => {
    const validated = validateUninstallRequest(request("local", true));
    expect(validated.operations.find((operation) => operation.id === "purge-config")).toMatchObject({ target: "/etc/pi-together/config.json", kind: "remove-file" });
    expect(validated.operations.some((operation) => operation.target.includes("backups"))).toBe(false);
  });

  it("rejects recomputed arbitrary paths, version drift, and digest changes", () => {
    const malicious = request();
    malicious.manifest.entries.push({ path: "/home/example/.pi/agent/sessions", kind: "directory", uninstall: "remove" });
    malicious.manifestSha256 = createHash("sha256").update(renderInstallManifest(malicious.manifest)).digest("hex");
    expect(() => validateUninstallRequest(malicious)).toThrow(/canonical/);
    const changed = request();
    changed.manifestSha256 = "a".repeat(64);
    expect(() => validateUninstallRequest(changed)).toThrow(/digest/);
    const version = request();
    version.manifest.version = "9.9.9";
    version.manifestSha256 = createHash("sha256").update(renderInstallManifest(version.manifest)).digest("hex");
    expect(() => validateUninstallRequest(version)).toThrow(/version/);
  });

  it("resumes only after recorded operations and leaves interruptions unfinished", async () => {
    const value = request();
    const validated = validateUninstallRequest(value);
    const io = new FakeIo();
    io.recovered.add(validated.operations[0]!.id);
    io.fail = validated.operations[2]!.id;
    await expect(uninstallValidated(value, io)).rejects.toThrow(/interruption/);
    expect(io.executed).toEqual([validated.operations[1]!.id]);
    expect(io.recorded).toEqual([validated.operations[1]!.id]);
    expect(io.finished).toBe(0);
  });
});
