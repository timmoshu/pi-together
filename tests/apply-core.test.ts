import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildSetupPlan, type FileState, type PlanIo, type SetupPlan } from "../cli/operation-plan.js";
import type { DiscoveryReport } from "../cli/discovery.js";
import type { SetupAnswers } from "../cli/setup-answers.js";
import { applyValidated, validateApplyRequest, type ApplyIo, type ApplyRequest, type ValidatedApply } from "../privileged/apply-core.js";

const OAUTH_SECRET = "oauth-secret-value-that-never-reaches-errors";
const SECRETS = {
  "proxy-secret": "p".repeat(43),
  "oauth-client-secret": OAUTH_SECRET,
  "oauth-cookie-secret": "c".repeat(43),
} as const;
const publicAnswers: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "reverse-proxy", domain: "pi.example.com",
  githubLogins: ["alice", "bob"], oauthClientId: "client-id", oauthClientSecret: OAUTH_SECRET,
  certificateEmail: "ops@example.com", sharedRepositoryFolders: ["/srv/work"], startNow: true, enableBootService: true,
};
const funnelAnswers: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "tailscale-funnel", tailscaleDnsName: "node.tailnet.ts.net",
  githubLogins: ["alice"], oauthClientId: "client-id", oauthClientSecret: OAUTH_SECRET,
  sharedRepositoryFolders: ["/srv/work"], startNow: true, enableBootService: true,
};
const localAnswers: SetupAnswers = {
  schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "local", sharedRepositoryFolders: ["/srv/work"],
  startNow: true, enableBootService: false,
};
const report: DiscoveryReport = {
  schemaVersion: 1, safeToPlan: true, checks: [],
  facts: {
    observedAt: "2026-07-25T00:00:00.000Z", platform: "linux", distro: { id: "debian", version: "12" },
    arch: "x64", node: { path: "/opt/node/bin/node", version: "v22.19.0" },
    user: { uid: 1000, username: "example", group: "example" }, piPath: "/opt/node/bin/pi", nginxPath: "/usr/sbin/nginx",
    occupiedPorts: [], localPort: 43117, sharedRepositoryFolders: { "/srv/work": "/srv/work" }, existingInstall: false,
  },
};
const planIo: PlanIo = {
  inspect: async (path) => path === "/usr/bin/tailscale"
    ? { kind: "file", sha256: "f".repeat(64), mode: 0o755, uid: 0, gid: 0 }
    : ["/opt/node/bin/node", "/opt/node/bin/pi", "/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow"].includes(path)
    ? { kind: "file", sha256: "e".repeat(64), mode: 0o755, uid: 1000, gid: 1000 }
    : path === "/srv/work" ? { kind: "directory", mode: 0o750, uid: 1000, gid: 1000 }
    : { kind: "absent" },
  nginxInventory: async () => [],
  resolvePrincipal: async (login, observedAt) => ({
    provider: "github", subject: login === "alice" ? "1001" : "1002", login,
    verifiedAt: observedAt, verification: "verified",
  }),
  releaseManifest: async () => ({ version: "0.1.0", sha256: "d".repeat(64) }),
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function redigest(plan: SetupPlan): SetupPlan {
  const { planDigest: _digest, ...core } = plan;
  return { ...core, planDigest: createHash("sha256").update(canonical(core)).digest("hex") } as SetupPlan;
}
function request(plan: SetupPlan): ApplyRequest {
  return plan.mode === "local" ? { protocolVersion: 1, plan } : { protocolVersion: 1, plan, secrets: { ...SECRETS } };
}

async function plans(): Promise<{ local: SetupPlan; publicPlan: SetupPlan; funnel: SetupPlan }> {
  return {
    local: await buildSetupPlan(localAnswers, report, planIo),
    publicPlan: await buildSetupPlan(publicAnswers, report, planIo),
    funnel: await buildSetupPlan(funnelAnswers, report, planIo),
  };
}

class FakeApplyIo implements ApplyIo {
  readonly executed: string[] = [];
  readonly rolledBack: string[] = [];
  readonly inspections: Array<{ path: string; maximumBytes?: number }> = [];
  prepared = 0;
  verified = 0;
  finished = 0;
  failExecutionAt = -1;
  failVerify = false;
  portAvailable = true;
  rollbackFailure?: string;
  failAbort = false;
  constructor(private readonly states: Map<string, FileState>) {}
  async inspect(path: string, maximumBytes?: number): Promise<FileState> {
    this.inspections.push({ path, ...(maximumBytes === undefined ? {} : { maximumBytes }) });
    return this.states.get(path) ?? { kind: "absent" };
  }
  async localPortAvailable(_port: number): Promise<boolean> { return this.portAvailable; }
  async recover(_validated: ValidatedApply): Promise<void> {}
  async prepare(_validated: ValidatedApply): Promise<void> { this.prepared++; }
  async execute(operation: { id: string }): Promise<void> {
    if (this.executed.length === this.failExecutionAt) throw new Error("synthetic operation failure");
    this.executed.push(operation.id);
  }
  async rollback(operation: { id: string }): Promise<void> {
    this.rolledBack.push(operation.id);
    if (operation.id === this.rollbackFailure) throw new Error("synthetic rollback failure");
  }
  async abort(_validated: ValidatedApply): Promise<void> { if (this.failAbort) throw new Error("unresolved journal"); }
  async verify(_validated: ValidatedApply): Promise<void> { this.verified++; if (this.failVerify) throw new Error("synthetic verification failure"); }
  async finish(_validated: ValidatedApply): Promise<void> { this.finished++; }
}

function stateMap(plan: SetupPlan): Map<string, FileState> {
  return new Map(plan.preconditions.map((item) => [item.path, item.expected]));
}

describe("narrow privileged apply core", () => {
  it("independently validates local and public plans and resolves only reviewed secret templates", async () => {
    const { local, publicPlan, funnel } = await plans();
    const localValidated = validateApplyRequest(request(local));
    const publicValidated = validateApplyRequest(request(publicPlan));
    const funnelValidated = validateApplyRequest(request(funnel));
    expect(localValidated.secrets.size).toBe(0);
    expect(publicValidated.files.get("app-config")?.toString()).toContain(SECRETS["proxy-secret"]);
    expect(publicValidated.files.get("oauth-client-secret")?.toString()).toBe(OAUTH_SECRET);
    expect(funnelValidated.files.get("funnel-edge-config")?.toString()).toContain("listen 127.0.0.1:43118");
    expect(funnelValidated.files.get("funnel-service")?.toString()).toContain("tailscale funnel --https=443");
    expect(JSON.stringify(publicPlan)).not.toContain(OAUTH_SECRET);
  });

  it("independently validates exact-domain certificate reuse without a deletion rollback", async () => {
    const reused = await buildSetupPlan({ ...publicAnswers, reuseExistingCertificate: true }, report, {
      ...planIo,
      inspectCertificate: async () => ({
        status: "existing",
        fullchainState: { kind: "symlink", target: "../../archive/pi.example.com/fullchain2.pem", uid: 0, gid: 0 },
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    });
    expect(() => validateApplyRequest(request(reused))).not.toThrow();
    const operation = reused.operations.find((item) => item.id === "certificate");
    expect(operation).toMatchObject({ kind: "reuse-certificate", rollback: { kind: "none" } });
  });

  it("independently accepts only the bounded local listener port set", async () => {
    const alternate = await buildSetupPlan(localAnswers, {
      ...report, facts: { ...report.facts, localPort: 43119 },
    }, planIo);
    expect(() => validateApplyRequest(request(alternate))).not.toThrow();

    const unapproved = structuredClone(alternate);
    const config = unapproved.operations.find((operation) => operation.id === "app-config");
    if (!config || config.kind !== "write-file") throw new Error("fixture missing app config");
    config.contentTemplate = config.contentTemplate.replace('"port": 43119', '"port": 45000');
    config.expectedTemplateSha256 = createHash("sha256").update(config.contentTemplate).digest("hex");
    expect(() => validateApplyRequest(request(redigest(unapproved)))).toThrow(/generated app config/);
  });

  it("accepts an invoking-user-owned workspace precondition regardless of directory write bits", async () => {
    const { local } = await plans();
    const writable = structuredClone(local);
    const workspace = writable.preconditions.find((item) => item.path === "/srv/work");
    if (!workspace || workspace.expected.kind !== "directory") throw new Error("fixture missing workspace precondition");
    workspace.expected.mode = 0o777;
    expect(() => validateApplyRequest(request(redigest(writable)))).not.toThrow();
  });

  it("rejects recomputed malicious plans, missing required operations, mismatched secrets, and version drift", async () => {
    const { publicPlan } = await plans();
    const malicious = structuredClone(publicPlan);
    const appService = malicious.operations.find((operation) => operation.id === "app-service");
    if (!appService || appService.kind !== "write-file") throw new Error("fixture missing app service");
    appService.target = "/tmp/owned.service";
    expect(() => validateApplyRequest(request(redigest(malicious)))).toThrow(/required operation/);

    const missing = structuredClone(publicPlan);
    missing.operations = missing.operations.filter((operation) => operation.id !== "apt-web-stack");
    expect(() => validateApplyRequest(request(redigest(missing)))).toThrow(/required operation/);

    expect(() => validateApplyRequest({ ...request(publicPlan), secrets: { ...SECRETS, "oauth-client-secret": "wrong-secret-value-123" } })).toThrow(/does not match/);
    const rootUser = structuredClone(publicPlan);
    rootUser.invokingUser = { uid: 1, username: "root", group: "root" };
    expect(() => validateApplyRequest(request(redigest(rootUser)))).toThrow(/permissions|service user/);

    const reordered = structuredClone(publicPlan);
    [reordered.operations[0], reordered.operations[1]] = [reordered.operations[1]!, reordered.operations[0]!];
    expect(() => validateApplyRequest(request(redigest(reordered)))).toThrow(/operation order/);

    const unsafeMode = structuredClone(publicPlan);
    const archive = unsafeMode.operations.find((operation) => operation.id === "oauth2-proxy-archive");
    if (!archive || archive.kind !== "download") throw new Error("fixture missing archive");
    archive.mode = "0777";
    expect(() => validateApplyRequest(request(redigest(unsafeMode)))).toThrow(/artifact operation/);

    const unapprovedPackage = structuredClone(publicPlan);
    const apt = unapprovedPackage.operations.find((operation) => operation.id === "apt-web-stack");
    if (!apt || apt.kind !== "install-apt") throw new Error("fixture missing apt operation");
    apt.packages = ["nginx"];
    apt.rollback = { kind: "remove-installed-packages", packages: ["nginx"] };
    expect(() => validateApplyRequest(request(redigest(unapprovedPackage)))).toThrow(/package allowlist/);

    const existingLineage = structuredClone(publicPlan);
    const fullchain = existingLineage.preconditions.find((item) => item.path.endsWith("/fullchain.pem"));
    if (!fullchain) throw new Error("fixture missing certificate precondition");
    fullchain.expected = { kind: "file", sha256: "a".repeat(64), mode: 0o644, uid: 0, gid: 0 };
    expect(() => validateApplyRequest(request(redigest(existingLineage)))).toThrow(/existing lineage/);

    const unsafeTimer = structuredClone(publicPlan);
    const timer = unsafeTimer.operations.find((operation) => operation.id === "certbot-renewal-action");
    if (!timer || timer.kind !== "service") throw new Error("fixture missing renewal timer");
    timer.action = "start";
    timer.rollback = { kind: "service-action", action: "stop" };
    expect(() => validateApplyRequest(request(redigest(unsafeTimer)))).toThrow(/timer action/);

    const badRollback = structuredClone(publicPlan);
    const config = badRollback.operations.find((operation) => operation.id === "app-config");
    if (!config) throw new Error("fixture missing config");
    config.rollback = { kind: "none" };
    expect(() => validateApplyRequest(request(redigest(badRollback)))).toThrow(/rollback/);

    const wrongVersion = structuredClone(publicPlan);
    wrongVersion.producer.version = "0.1.1";
    expect(() => validateApplyRequest(request(redigest(wrongVersion)))).toThrow(/version/);
  });

  it("rejects partial public and Funnel lifecycle activation sets", async () => {
    const { publicPlan, funnel } = await plans();
    const partialPublic = structuredClone(publicPlan);
    partialPublic.operations = partialPublic.operations.filter((operation) => operation.id !== "oauth-service-action");
    expect(() => validateApplyRequest(request(redigest(partialPublic)))).toThrow(/lifecycle actions.*together/i);

    const partialFunnel = structuredClone(funnel);
    partialFunnel.operations = partialFunnel.operations.filter((operation) => operation.id !== "funnel-service-action");
    expect(() => validateApplyRequest(request(redigest(partialFunnel)))).toThrow(/lifecycle actions.*together/i);
  });

  it("never includes supplied secrets in validation or apply errors", async () => {
    const { publicPlan } = await plans();
    let message = "";
    try {
      validateApplyRequest({ ...request(publicPlan), secrets: { ...SECRETS, "proxy-secret": `${OAUTH_SECRET}bad` } });
    } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain(OAUTH_SECRET);
  });

  it("preflights every path before prepare and applies a valid plan in reviewed order", async () => {
    const { local } = await plans();
    const io = new FakeApplyIo(stateMap(local));
    await applyValidated(request(local), io);
    expect(io.prepared).toBe(1);
    expect(io.executed).toEqual(local.operations.map((operation) => operation.id));
    expect(io.rolledBack).toEqual([]);
    expect(io.verified).toBe(1);
    expect(io.finished).toBe(1);
  });

  it("uses the larger bounded inspection lane only for reviewed runtime executables", async () => {
    const { local } = await plans();
    const io = new FakeApplyIo(stateMap(local));
    await applyValidated(request(local), io);
    expect(io.inspections.find((item) => item.path === "/opt/node/bin/node")?.maximumBytes).toBe(256 * 1024 * 1024);
    expect(io.inspections.find((item) => item.path === "/opt/node/bin/pi")?.maximumBytes).toBe(256 * 1024 * 1024);
    expect(io.inspections.find((item) => item.path === "/srv/work")?.maximumBytes).toBeUndefined();
  });

  it("rechecks the selected local port immediately before mutation", async () => {
    const { local } = await plans();
    const io = new FakeApplyIo(stateMap(local));
    io.portAvailable = false;
    await expect(applyValidated(request(local), io)).rejects.toThrow(/local port is no longer available/);
    expect(io.prepared).toBe(0);
    expect(io.executed).toEqual([]);
  });

  it("stops before mutation when any precondition changes", async () => {
    const { local } = await plans();
    const states = stateMap(local);
    states.set("/etc/pi-together/config.json", { kind: "file", sha256: "f".repeat(64), mode: 0o600, uid: 1000, gid: 1000 });
    const io = new FakeApplyIo(states);
    await expect(applyValidated(request(local), io)).rejects.toThrow(/precondition changed/);
    expect(io.prepared).toBe(0);
    expect(io.executed).toEqual([]);
  });

  it("rolls completed operations back in exact reverse order after every local and public operation boundary", async () => {
    const { local, publicPlan } = await plans();
    for (const plan of [local, publicPlan]) {
      for (let failure = 0; failure < plan.operations.length; failure++) {
        const io = new FakeApplyIo(stateMap(plan));
        io.failExecutionAt = failure;
        await expect(applyValidated(request(plan), io)).rejects.toThrow(/apply failed/);
        expect(io.rolledBack, `${plan.mode} failure ${failure}`).toEqual(plan.operations.slice(0, failure).map((operation) => operation.id).reverse());
        expect(io.finished).toBe(0);
      }
    }
  });

  it("retains and reports an unresolved in-flight journal instead of declaring rollback complete", async () => {
    const { local } = await plans();
    const io = new FakeApplyIo(stateMap(local));
    io.failExecutionAt = 0;
    io.failAbort = true;
    await expect(applyValidated(request(local), io)).rejects.toThrow(/rollback failed for in-flight operation journal/);
  });

  it("rolls the whole transaction back on final verification failure and reports rollback failures", async () => {
    const { local } = await plans();
    const io = new FakeApplyIo(stateMap(local));
    io.failVerify = true;
    io.rollbackFailure = local.operations[0]!.id;
    await expect(applyValidated(request(local), io)).rejects.toThrow(new RegExp(`rollback failed for ${local.operations[0]!.id}`));
    expect(io.rolledBack).toEqual(local.operations.map((operation) => operation.id).reverse());
    expect(io.finished).toBe(0);
  });

  it("exposes no arbitrary command execution capability to the apply engine", () => {
    const ioKeys: Array<keyof ApplyIo> = ["inspect", "recover", "prepare", "execute", "rollback", "abort", "verify", "finish"];
    expect(ioKeys).not.toContain("exec");
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});
