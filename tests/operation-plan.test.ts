import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSetupPlan,
  renderSetupPlan,
  SetupPlanSchema,
  type FileState,
  type NginxInventoryEntry,
  type PlanIo,
} from "../cli/operation-plan.js";
import type { DiscoveryReport } from "../cli/discovery.js";
import type { SetupAnswers } from "../cli/setup-answers.js";

const SECRET = "oauth-client-secret-that-must-never-render";
const local: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "local", sharedRepositoryFolders: ["/srv/work"],
  startNow: true, enableBootService: false,
};
const funnelAnswers: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "tailscale-funnel", sharedRepositoryFolders: ["/srv/work"],
  tailscaleDnsName: "node.tailnet.ts.net", githubLogins: ["alice"], oauthClientId: "client-id",
  oauthClientSecret: SECRET, startNow: true, enableBootService: true,
};
const publicAnswers: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "reverse-proxy", sharedRepositoryFolders: ["/srv/work"],
  domain: "pi.example.com", githubLogins: ["alice", "bob"], oauthClientId: "client-id",
  oauthClientSecret: SECRET, certificateEmail: "ops@example.com", startNow: true, enableBootService: true,
};

function report(overrides: Partial<DiscoveryReport["facts"]> = {}): DiscoveryReport {
  return {
    schemaVersion: 1,
    safeToPlan: true,
    checks: [],
    facts: {
      observedAt: "2026-07-25T00:00:00.000Z",
      platform: "linux",
      distro: { id: "debian", version: "12" },
      arch: "x64",
      node: { path: "/opt/node/bin/node", version: "v22.19.0" },
      user: { uid: 1000, username: "example", group: "example" },
      piPath: "/opt/node/bin/pi",
      nginxPath: "/usr/sbin/nginx",
      occupiedPorts: [],
      localPort: 43117,
      sharedRepositoryFolders: { "/srv/work": "/srv/work" },
      existingInstall: false,
      ...overrides,
    },
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function planIo(options: { states?: Record<string, FileState>; inventory?: NginxInventoryEntry[] } = {}): PlanIo {
  return {
    inspect: async (path) => options.states?.[path] ?? (path === "/usr/bin/tailscale"
      ? { kind: "file", sha256: "f".repeat(64), mode: 0o755, uid: 0, gid: 0 }
      : ["/opt/node/bin/node", "/opt/node/bin/pi", "/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow"].includes(path)
      ? { kind: "file", sha256: "e".repeat(64), mode: 0o755, uid: 1000, gid: 1000 }
      : path === "/srv/work" ? { kind: "directory", mode: 0o750, uid: 1000, gid: 1000 }
      : { kind: "absent" }),
    nginxInventory: async () => options.inventory ?? [],
    resolvePrincipal: async (login, observedAt) => ({
      provider: "github", subject: login === "alice" ? "1001" : "1002", login,
      verifiedAt: observedAt, verification: "verified", etag: `W/\"${login}\"`,
    }),
    releaseManifest: async () => ({ version: "0.1.0", sha256: "d".repeat(64) }),
  };
}

describe("typed setup operation plan", () => {
  it("builds a versioned deterministic local plan with hashes, preconditions, and rollback metadata", async () => {
    const first = await buildSetupPlan(local, report(), planIo());
    const second = await buildSetupPlan(local, report(), planIo());
    expect(SetupPlanSchema.parse(first)).toEqual(first);
    expect(first).toEqual(second);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => SetupPlanSchema.parse({ ...first, observedAt: "2026-07-26T00:00:00.000Z" })).toThrow(/digest/);
    expect(first.operations.every((operation) => operation.rollback.kind !== undefined)).toBe(true);
    expect(first.operations.filter((operation) => operation.kind === "write-file")
      .every((operation) => /^[a-f0-9]{64}$/.test(operation.expectedTemplateSha256))).toBe(true);
    expect(renderSetupPlan(first)).toMatchSnapshot("local redacted operation plan");
  });

  it("uses the bounded available local port selected during discovery", async () => {
    const plan = await buildSetupPlan(local, report({ localPort: 43119 }), planIo());
    const config = plan.operations.find((operation) => operation.id === "app-config");
    expect(config?.kind).toBe("write-file");
    expect(config?.kind === "write-file" ? JSON.parse(config.contentTemplate).listener : undefined)
      .toEqual({ kind: "tcp", host: "127.0.0.1", port: 43119 });
  });

  it("builds a private-local Funnel stack without ACME or public nginx listeners", async () => {
    const plan = await buildSetupPlan(funnelAnswers, report(), planIo());
    expect(plan.mode).toBe("tailscale-funnel");
    const ids = plan.operations.map((operation) => operation.id);
    expect(ids).toContain("funnel-edge-config");
    expect(ids).toContain("funnel-service");
    expect(ids).toContain("funnel-service-action");
    expect(ids).not.toContain("certificate");
    expect(ids).not.toContain("nginx-final-site");
    expect(ids).not.toContain("certbot-renewal-action");
    expect(plan.operations.find((operation) => operation.id === "funnel-edge-service-action")).toBeTruthy();
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it("keeps every secret out of plans, displays, templates, and validation errors", async () => {
    const first = await buildSetupPlan(publicAnswers, report(), planIo());
    const second = await buildSetupPlan(publicAnswers, report(), planIo());
    expect(first.planDigest).toBe(second.planDigest);
    const serialized = JSON.stringify(first);
    const display = renderSetupPlan(first);
    expect(serialized).not.toContain(SECRET);
    expect(display).not.toContain(SECRET);
    expect(serialized).toContain("{{secret:proxy-secret}}");
    expect(first.operations.every((operation) => operation.kind !== "write-file" || operation.secretIds.length === 0 || operation.mode === "0600")).toBe(true);
    expect(first.operations.find((operation) => operation.id === "oauth-config")).toMatchObject({ owner: "root", group: "root", mode: "0644" });
    const ids = first.operations.map((operation) => operation.id);
    expect(ids.indexOf("nginx-challenge-action")).toBeLessThan(ids.indexOf("certificate"));
    expect(ids.indexOf("certificate")).toBeLessThan(ids.indexOf("nginx-final-site"));
    expect(ids.indexOf("renewal-hook")).toBeLessThan(ids.indexOf("certbot-renewal-action"));
    expect(first.preconditions).toContainEqual({ path: "/etc/letsencrypt/live/pi.example.com/privkey.pem", expected: { kind: "absent" } });
    expect(display).toContain("content redacted");
    for (const operation of first.operations) {
      if (operation.kind === "write-file" && operation.mode !== "0600") {
        expect(operation.contentTemplate).not.toContain(SECRET);
      }
    }
    let message = "";
    try {
      await buildSetupPlan(publicAnswers, { ...report(), safeToPlan: false }, planIo());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET);
  });

  it.each([
    ["domain", "server { server_name pi.example.com; }"],
    ["listener", "upstream other { server unix:/run/pi-together/app.sock; }"],
  ])("stops on an existing nginx %s collision while preserving unrelated inventory", async (_kind, content) => {
    const collisionState = { kind: "file" as const, sha256: digest(content), mode: 0o644, uid: 0, gid: 0 };
    const collision = planIo({ inventory: [{ path: "/etc/nginx/sites-enabled/unrelated", state: collisionState, contentPath: "/etc/nginx/sites-enabled/unrelated", contentState: collisionState, content }] });
    await expect(buildSetupPlan(publicAnswers, report(), collision)).rejects.toThrow(/collision/);
    const unrelatedContent = "server_name other.example.com;";
    const unrelatedState = { kind: "file" as const, sha256: digest(unrelatedContent), mode: 0o644, uid: 0, gid: 0 };
    const unrelated = planIo({ inventory: [{ path: "/etc/nginx/sites-enabled/unrelated", state: unrelatedState, contentPath: "/etc/nginx/sites-enabled/unrelated", contentState: unrelatedState, content: unrelatedContent }] });
    await expect(buildSetupPlan(publicAnswers, report(), unrelated)).resolves.toMatchObject({ mode: "reverse-proxy" });
  });

  it("plans safely after uninstall without traversing preserved root-only backup state", async () => {
    const io = planIo({ states: {
      "/var/lib/pi-together": { kind: "directory", mode: 0o750, uid: 0, gid: 0 },
      "/etc/pi-together/config.json": { kind: "file", sha256: "c".repeat(64), mode: 0o600, uid: 1000, gid: 1000 },
    } });
    const inspect = io.inspect;
    io.inspect = async (path) => {
      if ([
        "/var/lib/pi-together/backups",
        "/var/lib/pi-together/backups/setup",
        "/var/lib/pi-together/install-manifest.json",
      ].includes(path)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return inspect(path);
    };
    const plan = await buildSetupPlan(local, report({ localPort: 43119 }), io);
    expect(plan.preconditions).toContainEqual({
      path: "/var/lib/pi-together/backups",
      expected: { kind: "directory", mode: 0o700, uid: 0, gid: 0 },
    });
    expect(plan.preconditions).toContainEqual({
      path: "/var/lib/pi-together/backups/setup",
      expected: { kind: "directory", mode: 0o700, uid: 0, gid: 0 },
    });
    expect(plan.preconditions).toContainEqual({ path: "/var/lib/pi-together/install-manifest.json", expected: { kind: "absent" } });
  });

  it("plans Funnel setup after preparation creates root-only state and downloads directories", async () => {
    const io = planIo({ states: {
      "/var/lib/pi-together": { kind: "directory", mode: 0o750, uid: 0, gid: 0 },
      "/etc/pi-together/config.json": { kind: "absent" },
    } });
    const inspect = io.inspect;
    io.inspect = async (path) => {
      if (path.startsWith("/var/lib/pi-together/") && path !== "/var/lib/pi-together") {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return inspect(path);
    };
    const plan = await buildSetupPlan(funnelAnswers, report(), io);
    expect(plan.preconditions).toContainEqual({ path: "/var/lib/pi-together/backups", expected: { kind: "absent" } });
    expect(plan.preconditions).toContainEqual({ path: "/var/lib/pi-together/backups/setup", expected: { kind: "absent" } });
    expect(plan.preconditions).toContainEqual({
      path: "/var/lib/pi-together/downloads",
      expected: { kind: "directory", mode: 0o700, uid: 0, gid: 0 },
    });
    expect(plan.preconditions).toContainEqual({
      path: expect.stringMatching(/^\/var\/lib\/pi-together\/downloads\/oauth2-proxy-/),
      expected: { kind: "absent" },
    });
  });

  it("defers exact root-only public-file absence checks to interrupted-apply recovery and the root boundary", async () => {
    const funnelIo = planIo();
    const inspectFunnel = funnelIo.inspect;
    funnelIo.inspect = async (path) => [
      "/etc/pi-together/oauth-client.secret",
      "/etc/pi-together/oauth-cookie.secret",
      "/etc/pi-together/nginx-funnel.conf",
    ].includes(path)
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : inspectFunnel(path);
    const funnelPlan = await buildSetupPlan(funnelAnswers, report(), funnelIo);
    for (const path of [
      "/etc/pi-together/oauth-client.secret",
      "/etc/pi-together/oauth-cookie.secret",
      "/etc/pi-together/nginx-funnel.conf",
    ]) expect(funnelPlan.preconditions).toContainEqual({ path, expected: { kind: "absent" } });

    const publicIo = planIo();
    const inspectPublic = publicIo.inspect;
    publicIo.inspect = async (path) => path.startsWith("/etc/letsencrypt/live/pi.example.com/")
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : inspectPublic(path);
    const publicPlan = await buildSetupPlan(publicAnswers, report(), publicIo);
    expect(publicPlan.preconditions).toContainEqual({
      path: "/etc/letsencrypt/live/pi.example.com/fullchain.pem",
      expected: { kind: "absent" },
    });
    expect(publicPlan.preconditions).toContainEqual({
      path: "/etc/letsencrypt/live/pi.example.com/privkey.pem",
      expected: { kind: "absent" },
    });
  });

  it("plans mode changes from the preserved prior config without guessing protected directory state from the requested mode", async () => {
    const fromMode = async (mode: "local" | "tailscale-funnel") => {
      const io = planIo();
      const inspect = io.inspect;
      io.inspect = async (path) => path === "/etc/pi-together/config.json"
        ? { kind: "file", sha256: "c".repeat(64), mode: 0o600, uid: 1000, gid: 1000 }
        : path === "/var/lib/pi-together"
          ? { kind: "directory", mode: 0o750, uid: 0, gid: 0 }
          : inspect(path);
      io.existingConfigMode = async () => mode;
      io.inspectCertificate = async () => ({ status: "absent" });
      return buildSetupPlan(publicAnswers, report(), io);
    };
    const fromLocal = await fromMode("local");
    expect(fromLocal.preconditions).toContainEqual({ path: "/var/lib/pi-together/downloads", expected: { kind: "absent" } });
    const fromFunnel = await fromMode("tailscale-funnel");
    expect(fromFunnel.preconditions).toContainEqual({
      path: "/var/lib/pi-together/downloads",
      expected: { kind: "directory", mode: 0o700, uid: 0, gid: 0 },
    });
  });

  it("plans explicit reuse only for a privileged-validated exact-domain certificate lineage", async () => {
    const io = planIo();
    io.inspectCertificate = async () => ({
      status: "existing",
      fullchainState: { kind: "symlink", target: "../../archive/pi.example.com/fullchain3.pem", uid: 0, gid: 0 },
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const plan = await buildSetupPlan({ ...publicAnswers, reuseExistingCertificate: true }, report(), io);
    expect(plan.operations.find((operation) => operation.id === "certificate")).toMatchObject({
      kind: "reuse-certificate",
      domain: "pi.example.com",
      rollback: { kind: "none" },
    });
    expect(plan.preconditions).toContainEqual({
      path: "/etc/letsencrypt/live/pi.example.com/fullchain.pem",
      expected: { kind: "symlink", target: "../../archive/pi.example.com/fullchain3.pem", uid: 0, gid: 0 },
    });
    await expect(buildSetupPlan({ ...publicAnswers, reuseExistingCertificate: false }, report(), io)).rejects.toThrow(/reuse was not approved/);
  });

  it("records exact existing-file hashes and rejects symlink target preconditions", async () => {
    const existingHash = "c".repeat(64);
    const existing = await buildSetupPlan(local, report(), planIo({ states: {
      "/etc/pi-together/config.json": { kind: "file", sha256: existingHash, mode: 0o600, uid: 1000, gid: 1000 },
    } }));
    expect(existing.preconditions).toContainEqual({ path: "/etc/pi-together/config.json", expected: { kind: "file", sha256: existingHash, mode: 0o600, uid: 1000, gid: 1000 } });
    expect(existing.operations.find((operation) => operation.id === "app-config")?.rollback).toMatchObject({ kind: "restore-backup", sourceSha256: existingHash });

    await expect(buildSetupPlan(local, report(), planIo({ states: {
      "/etc/pi-together/config.json": { kind: "symlink", target: "/tmp/attacker", uid: 1000, gid: 1000 },
    } }))).rejects.toThrow(/unsafe existing target type/);
  });

  it.each([
    ["debian", "12", "x64", "linux-amd64"],
    ["debian", "12", "arm64", "linux-arm64"],
    ["ubuntu", "22.04", "x64", "linux-amd64"],
    ["ubuntu", "22.04", "arm64", "linux-arm64"],
    ["ubuntu", "24.04", "x64", "linux-amd64"],
    ["ubuntu", "24.04", "arm64", "linux-arm64"],
  ] as const)("renders a dry plan for %s %s %s", async (id, version, arch, asset) => {
    const plan = await buildSetupPlan(publicAnswers, report({ distro: { id, version }, arch }), planIo());
    expect(plan.operations.find((operation) => operation.id === "oauth2-proxy-archive")).toMatchObject({ url: expect.stringContaining(asset) });
  });

  it("fails before planning on unsafe discovery, existing installs, certificate lineages, and non-nginx port collisions", async () => {
    await expect(buildSetupPlan(publicAnswers, report(), planIo({ states: {
      "/etc/letsencrypt/live/pi.example.com/privkey.pem": { kind: "file", sha256: "b".repeat(64), mode: 0o600, uid: 0, gid: 0 },
    } }))).rejects.toThrow(/existing certificate lineage/);
    await expect(buildSetupPlan(local, { ...report(), safeToPlan: false }, planIo())).rejects.toThrow(/discovery failed/);
    await expect(buildSetupPlan(local, report({ existingInstall: true }), planIo())).rejects.toThrow(/upgrade command/);
    await expect(buildSetupPlan(publicAnswers, report({ occupiedPorts: [443], nginxPath: undefined }), planIo())).rejects.toThrow(/occupied/);
  });
});
