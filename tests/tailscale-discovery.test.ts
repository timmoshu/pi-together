import { describe, expect, it } from "vitest";
import { probeTailscale, type TailscaleProbeIo } from "../cli/tailscale-discovery.js";

function io(status: unknown, version = "1.98.8", exists = true): TailscaleProbeIo {
  return {
    findExecutable: async () => exists ? "/usr/bin/tailscale" : null,
    realpath: async (path) => path,
    inspectExecutable: async () => ({ file: true, uid: 0, mode: 0o755 }),
    exec: async (_file, args) => ({ stdout: args[0] === "version" ? version : JSON.stringify(status), stderr: "" }),
  };
}
const ready = {
  BackendState: "Running",
  MagicDNSSuffix: "tail-example.ts.net",
  CurrentTailnet: { MagicDNSEnabled: true },
  Self: { DNSName: "example-node.tail-example.ts.net.", KeyExpiry: "2027-01-01T00:00:00Z" },
  Health: [],
  User: { "1": { LoginName: "private@example.com" } },
  Peer: { secret: { PublicKey: "nodekey:secret", TailscaleIPs: ["100.1.2.3"] } },
};

describe("read-only Tailscale discovery", () => {
  it("returns only minimal normalized facts", async () => {
    const result = await probeTailscale(io(ready), new Date("2026-07-25T00:00:00Z"));
    expect(result).toEqual({ status: "ready", path: "/usr/bin/tailscale", version: "1.98.8", dnsName: "example-node.tail-example.ts.net", keyExpiry: "2027-01-01T00:00:00.000Z" });
    expect(JSON.stringify(result)).not.toMatch(/private|nodekey|100\.1/);
  });
  it("classifies missing, incompatible, logged-out, unhealthy, and expired nodes", async () => {
    await expect(probeTailscale(io(ready, "1.98.7"))).resolves.toMatchObject({ status: "incompatible" });
    await expect(probeTailscale(io({ BackendState: "NeedsLogin", Self: { DNSName: "" }, Health: null }))).resolves.toMatchObject({ status: "needs-login" });
    await expect(probeTailscale(io({ ...ready, Health: ["broken"] }))).resolves.toMatchObject({ status: "unhealthy" });
    await expect(probeTailscale(io({ ...ready, Self: { ...ready.Self, KeyExpiry: "2020-01-01T00:00:00Z" } }))).resolves.toMatchObject({ status: "expired" });
    await expect(probeTailscale(io(ready, "1.98.8", false))).resolves.toEqual({ status: "missing" });
  });
  it("uses bounded JSON output when logged-out status exits nonzero", async () => {
    const loggedOut = io(ready);
    loggedOut.exec = async (_file, args) => {
      if (args[0] === "version") return { stdout: "1.98.8\n", stderr: "" };
      throw Object.assign(new Error("not logged in"), {
        stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" }, Health: null }),
      });
    };
    await expect(probeTailscale(loggedOut)).resolves.toMatchObject({ status: "needs-login" });
  });

  it("fails closed on unsafe executables and malformed or non-ts.net identity", async () => {
    const unsafe = io(ready); unsafe.inspectExecutable = async () => ({ file: true, uid: 1000, mode: 0o755 });
    await expect(probeTailscale(unsafe)).resolves.toMatchObject({ status: "probe-failed" });
    await expect(probeTailscale(io({ ...ready, Self: { ...ready.Self, DNSName: "attacker.example.com" } }))).resolves.toMatchObject({ status: "probe-failed" });
    await expect(probeTailscale(io({ ...ready, CurrentTailnet: { MagicDNSEnabled: false } }))).resolves.toMatchObject({ status: "unhealthy" });
  });
});
