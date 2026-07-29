import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSetupPlan, type PlanIo } from "../cli/operation-plan.js";
import type { DiscoveryReport } from "../cli/discovery.js";
import type { SetupAnswers } from "../cli/setup-answers.js";
import { applyValidated, validateApplyRequest } from "../privileged/apply-core.js";
import { RootApplyIo, certbotArguments } from "../privileged/apply-io.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture(existingConfig?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-together-root-"));
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-package-"));
  roots.push(root, packageRoot);
  for (const path of ["opt/node/bin", "etc", "run", "var/lib", "opt", "etc/systemd/system", "srv/work"]) await mkdir(join(root, path), { recursive: true });
  await chmod(join(root, "srv/work"), 0o755);
  await writeFile(join(root, "opt/node/bin/node"), "node-binary", { mode: 0o755 });
  await writeFile(join(root, "opt/node/bin/pi"), "pi-binary", { mode: 0o755 });
  if (existingConfig !== undefined) {
    await mkdir(join(root, "etc/pi-together"), { mode: 0o750 });
    await writeFile(join(root, "etc/pi-together/config.json"), existingConfig, { mode: 0o640 });
  }
  await mkdir(join(packageRoot, "dist/server"), { recursive: true });
  const artifact = Buffer.from("synthetic packaged server");
  await writeFile(join(packageRoot, "dist/server/index.js"), artifact);
  await chmod(join(packageRoot, "dist"), 0o775);
  await chmod(join(packageRoot, "dist/server"), 0o775);
  await chmod(join(packageRoot, "dist/server/index.js"), 0o664);
  await mkdir(join(packageRoot, "dist/release"), { recursive: true });
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    package: { name: "pi-together", version: "0.1.0" },
    artifacts: [{ path: "dist/server/index.js", bytes: artifact.length, sha256: digest(artifact) }],
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "dist/release/manifest.json"), manifest);
  await writeFile(join(packageRoot, "dist/release/SHA256SUMS"), `${digest(artifact)}  dist/server/index.js\n`);

  const answers: SetupAnswers = {
    schemaVersion: 2, acceptedHostPermissionRisk: true, mode: "local", sharedRepositoryFolders: ["/srv/work"],
    startNow: true, enableBootService: false,
  };
  const report: DiscoveryReport = {
    schemaVersion: 1, safeToPlan: true, checks: [], facts: {
      observedAt: "2026-07-25T00:00:00.000Z", platform: "linux", distro: { id: "debian", version: "12" },
      arch: "x64", node: { path: "/opt/node/bin/node", version: "v22.19.0" },
      user: { uid: process.getuid?.() ?? 1000, username: "example", group: "example" }, piPath: "/opt/node/bin/pi", occupiedPorts: [], localPort: 43117,
      sharedRepositoryFolders: { "/srv/work": "/srv/work" }, existingInstall: false,
    },
  };
  const planIo: PlanIo = {
    inspect: async (path) => {
      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      if (["/opt/node/bin/node", "/opt/node/bin/pi"].includes(path)) {
        return { kind: "file" as const, sha256: digest(path.endsWith("node") ? "node-binary" : "pi-binary"), mode: 0o755, uid, gid };
      }
      if (path === "/srv/work") return { kind: "directory" as const, mode: 0o755, uid, gid };
      if (existingConfig !== undefined && path === "/etc/pi-together") return { kind: "directory" as const, mode: 0o750, uid, gid };
      if (existingConfig !== undefined && path === "/etc/pi-together/config.json") return { kind: "file" as const, sha256: digest(existingConfig), mode: 0o640, uid, gid };
      return { kind: "absent" as const };
    },
    nginxInventory: async () => [],
    resolvePrincipal: async () => { throw new Error("not used"); },
    releaseManifest: async () => ({ version: "0.1.0", sha256: digest(manifest) }),
  };
  return { root, packageRoot, plan: await buildSetupPlan(answers, report, planIo) };
}

describe("root apply filesystem adapter", () => {
  it("accepts canonical absolute targets when the production filesystem root is slash", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "pi-together-production-root-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-package-"));
    roots.push(targetRoot, packageRoot);
    const target = join(targetRoot, "synthetic-file");
    await writeFile(target, "synthetic");
    const io = new RootApplyIo({ root: "/", packageRoot, requireRoot: false });
    await expect(io.inspect(target)).resolves.toMatchObject({ kind: "file", sha256: digest("synthetic") });
  });

  it("streams large executable preconditions only when the core supplies the explicit larger bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-root-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-package-"));
    roots.push(root, packageRoot);
    const path = join(root, "runtime-node");
    await writeFile(path, "synthetic", { mode: 0o755 });
    await truncate(path, 17 * 1024 * 1024);
    const io = new RootApplyIo({ root, packageRoot, requireRoot: false });
    await expect(io.inspect("/runtime-node")).rejects.toThrow(/limit/i);
    await expect(io.inspect("/runtime-node", 256 * 1024 * 1024)).resolves.toMatchObject({
      kind: "file",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("does not remove a canonical preserved backup directory that this apply did not create", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-root-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-package-"));
    roots.push(root, packageRoot);
    await mkdir(join(root, "var/lib/pi-together/backups"), { recursive: true, mode: 0o700 });
    const io = new RootApplyIo({ root, packageRoot, requireRoot: false });
    await expect(io.rollback({
      id: "backup-root-directory", kind: "ensure-directory", target: "/var/lib/pi-together/backups", mode: "0700", owner: "root", group: "root",
      rollback: { kind: "remove-created" },
    })).resolves.toBeUndefined();
    expect((await lstat(join(root, "var/lib/pi-together/backups"))).isDirectory()).toBe(true);
  });

  it("does not recursively delete unexpected content while rolling back a created directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-root-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-package-"));
    roots.push(root, packageRoot);
    await mkdir(join(root, "run/pi-together"), { recursive: true });
    await writeFile(join(root, "run/pi-together/unexpected"), "preserve");
    const io = new RootApplyIo({ root, packageRoot, requireRoot: false });
    await expect(io.rollback({
      id: "runtime-directory", kind: "ensure-directory", target: "/run/pi-together", mode: "0750", owner: "example", group: "example",
      rollback: { kind: "remove-created" },
    })).resolves.toBeUndefined();
    expect(await readFile(join(root, "run/pi-together/unexpected"), "utf8")).toBe("preserve");
  });

  it("uses a fixed production ACME directory, webroot-only challenge, and exact certificate name", () => {
    const args = certbotArguments({
      id: "certificate", kind: "certificate", target: "/etc/letsencrypt/live/pi.example.com/fullchain.pem",
      domain: "pi.example.com", email: "ops@example.com", webroot: "/var/lib/pi-together/acme",
      rollback: { kind: "delete-certificate", domain: "pi.example.com" },
    }, "/var/lib/pi-together/acme");
    expect(args).toEqual([
      "certonly", "--non-interactive", "--agree-tos", "--no-eff-email", "--keep-until-expiring",
      "--preferred-challenges", "http", "--server", "https://acme-v02.api.letsencrypt.org/directory",
      "--cert-name", "pi.example.com", "--email", "ops@example.com", "--webroot", "-w", "/var/lib/pi-together/acme", "-d", "pi.example.com",
    ]);
    expect(args).not.toContain("--nginx");
  });

  it("installs a local release atomically without invoking npm or a shell", async () => {
    const { root, packageRoot, plan } = await fixture();
    const commands: Array<[string, string[]]> = [];
    let healthyPort: number | undefined;
    const io = new RootApplyIo({
      root,
      packageRoot,
      requireRoot: false,
      identities: {
        example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      },
      command: async (file, args) => { commands.push([file, args]); },
      health: async (config) => { healthyPort = config.listener.kind === "tcp" ? config.listener.port : undefined; },
    });
    await applyValidated({ protocolVersion: 1, plan }, io);

    expect(JSON.parse(await readFile(join(root, "etc/pi-together/config.json"), "utf8"))).toMatchObject({ mode: "local" });
    expect(await readFile(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), "utf8")).toBe("synthetic packaged server");
    expect((await lstat(join(root, "opt/pi-together/releases/0.1.0"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(root, "opt/pi-together/releases/0.1.0/server/index.js"))).mode & 0o777).toBe(0o644);
    expect((await lstat(join(root, "opt/pi-together/current"))).isSymbolicLink()).toBe(true);
    expect(commands.some(([file]) => /(?:npm|npx|sh|bash)$/.test(file))).toBe(false);
    const reload = commands.findIndex(([file, args]) => file === "/bin/systemctl" && args[0] === "daemon-reload");
    const start = commands.findIndex(([file, args]) => file === "/bin/systemctl" && args[0] === "start");
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(reload);
    expect(commands).toContainEqual(["/bin/systemctl", ["is-active", "pi-together.service"]]);
    expect(healthyPort).toBe(43117);
  });

  it("rejects apply when sudo provenance does not match the reviewed invoking user", async () => {
    const { root, packageRoot, plan } = await fixture();
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false, sudoUid: plan.invokingUser.uid + 1,
      identities: { example: { uid: plan.invokingUser.uid, gid: process.getgid?.() ?? 0 } },
    });
    await expect(io.recover(validateApplyRequest({ protocolVersion: 1, plan }))).rejects.toThrow(/sudo provenance/);
  });

  it("rechecks the user-owned app config after daemon reload and before starting the service", async () => {
    const { root, packageRoot, plan } = await fixture();
    const commands: Array<[string, string[]]> = [];
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false,
      identities: {
        example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      },
      command: async (file, args) => {
        commands.push([file, args]);
        if (file === "/bin/systemctl" && args[0] === "daemon-reload") {
          await writeFile(join(root, "etc/pi-together/config.json"), '{"tampered":true}\n');
        }
      },
    });
    await expect(applyValidated({ protocolVersion: 1, plan }, io)).rejects.toThrow(/installed app config/);
    expect(commands).not.toContainEqual(["/bin/systemctl", ["start", "pi-together.service"]]);
  });

  it("recovers a crash journal and backup metadata before reapplying", async () => {
    const original = "{\"beforeCrash\":true}\n";
    const { root, packageRoot, plan } = await fixture(original);
    const options = {
      root, packageRoot, requireRoot: false,
      identities: {
        example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      },
      command: async () => undefined,
    };
    const validated = validateApplyRequest({ protocolVersion: 1, plan });
    const interrupted = new RootApplyIo(options);
    await interrupted.recover(validated);
    for (const precondition of plan.preconditions) expect(await interrupted.inspect(precondition.path)).toEqual(precondition.expected);
    await interrupted.prepare(validated);
    for (const operation of plan.operations) {
      await interrupted.execute(operation, validated.files.get(operation.id));
      if (operation.id === "app-config") {
        // Public setup writes challenge and final nginx content to one reviewed target; exercise the same backup reuse path.
        await interrupted.execute(operation, validated.files.get(operation.id));
        break;
      }
    }
    expect(await readFile(join(root, "etc/pi-together/config.json"), "utf8")).not.toBe(original);

    const resumed = new RootApplyIo(options);
    await resumed.recoverPending();
    expect(await readFile(join(root, "etc/pi-together/config.json"), "utf8")).toBe(original);
    await applyValidated({ protocolVersion: 1, plan }, resumed);
    expect(JSON.parse(await readFile(join(root, "etc/pi-together/config.json"), "utf8"))).toMatchObject({ mode: "local" });
  });

  it("restores existing content, mode, and ownership when final verification fails", async () => {
    const original = "{\"preserved\":true}\n";
    const { root, packageRoot, plan } = await fixture(original);
    const ids = {
      example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    };
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false, identities: ids,
      command: async (file) => { if (file === "/usr/bin/systemd-analyze") throw new Error("synthetic verification failure"); },
    });
    await expect(applyValidated({ protocolVersion: 1, plan }, io)).rejects.toThrow(/verification failure/);
    const path = join(root, "etc/pi-together/config.json");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
    await expect(lstat(join(root, "var/lib/pi-together/backups"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, `var/tmp/pi-together-apply-${plan.planDigest}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks targets after preparation and rejects a symlink swap before first mutation", async () => {
    const { root, packageRoot, plan } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-together-outside-"));
    roots.push(outside);
    const validated = validateApplyRequest({ protocolVersion: 1, plan });
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false,
      identities: { root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } },
      command: async () => undefined,
    });
    await io.recover(validated);
    for (const precondition of plan.preconditions) expect(await io.inspect(precondition.path)).toEqual(precondition.expected);
    await io.prepare(validated);
    await symlink(outside, join(root, "etc/pi-together"));
    await expect(io.execute(plan.operations[0]!)).rejects.toThrow(/changed after preflight/);
    expect((await lstat(join(root, "etc/pi-together"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "opt/node/bin/node"), "utf8")).toBe("node-binary");
    await io.abort(validated);
  });

  it("rejects unreviewed packaged files before creating installation directories", async () => {
    const { root, packageRoot, plan } = await fixture();
    await writeFile(join(packageRoot, "dist/server/unreviewed.js"), "unreviewed");
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false,
      identities: { root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } },
      command: async () => undefined,
    });
    await expect(applyValidated({ protocolVersion: 1, plan }, io)).rejects.toThrow(/unreviewed artifact/);
  });

  it("rejects unreviewed empty package directories before creating installation directories", async () => {
    const { root, packageRoot, plan } = await fixture();
    await mkdir(join(packageRoot, "dist/unreviewed-empty"));
    const io = new RootApplyIo({
      root, packageRoot, requireRoot: false,
      identities: { root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } },
      command: async () => undefined,
    });
    await expect(applyValidated({ protocolVersion: 1, plan }, io)).rejects.toThrow(/unreviewed artifact/);
  });

  it("rejects package artifact changes before creating installation directories", async () => {
    const { root, packageRoot, plan } = await fixture();
    await writeFile(join(packageRoot, "dist/server/index.js"), "tampered");
    const io = new RootApplyIo({ root, packageRoot, requireRoot: false, identities: {
      example: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      root: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    }, command: async () => undefined });
    await expect(applyValidated({ protocolVersion: 1, plan }, io)).rejects.toThrow(/artifact hash mismatch/);
    await expect(lstat(join(root, "etc/pi-together"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
