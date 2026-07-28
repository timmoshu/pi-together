import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import type { UpgradeRequest } from "../privileged/upgrade-request.js";
import type { SignedRelease } from "../cli/upgrade-core.js";
import { RootUpgradeIo } from "../privileged/upgrade-io.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture(options: { from?: string; mode?: "local" | "tailscale-funnel" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-together-upgrade-root-"));
  const packageRoot = await mkdtemp(join(tmpdir(), "pi-together-upgrade-package-"));
  roots.push(root, packageRoot);
  const from = options.from ?? "0.0.9";
  const mode = options.mode ?? "local";
  const sourceCommit = "a".repeat(40);
  const releaseId = "0.1.0";
  for (const path of [`opt/pi-together/releases/${from}/server`, "var/lib/pi-together/backups", "etc/pi-together", "run/pi-together", "package/dist/server", "package/dist/release"]) await mkdir(join(path.startsWith("package/") ? packageRoot : root, path), { recursive: true });
  await writeFile(join(root, `opt/pi-together/releases/${from}/server/index.js`), "old-release");
  await symlink(`/opt/pi-together/releases/${from}`, join(root, "opt/pi-together/current"));
  const config = mode === "local"
    ? { version: 2, mode, listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, sharedRepositoryFolders: ["/srv/work"] }
    : { version: 2, mode, listener: { kind: "unix", path: "/run/pi-together/app.sock" }, publicOrigin: "https://fixture.test.ts.net", proxySecret: "fixture-proxy-secret-00000000000000000000000", principals: [{ provider: "github", subject: "1", login: "fixture", verifiedAt: "2026-07-28T00:00:00.000Z", verification: "verified" }], tailscaleDnsName: "fixture.test.ts.net", sharedRepositoryFolders: ["/srv/work"] };
  const oauthArchive = mode === "tailscale-funnel" ? "/var/lib/pi-together/downloads/oauth2-proxy-v7.12.0.linux-amd64.tar.gz" : undefined;
  await writeFile(join(root, "etc/pi-together/config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await writeFile(join(root, "var/lib/pi-together/install-manifest.json"), renderInstallManifest(buildInstallManifest(mode, from, oauthArchive)), { mode: 0o644 });
  const artifact = Buffer.from("new-release");
  for (const path of ["package", "package/dist", "package/dist/server", "package/dist/release"]) await chmod(join(packageRoot, path), 0o755);
  await writeFile(join(packageRoot, "package/dist/server/index.js"), artifact, { mode: 0o644 });
  const manifest = Buffer.from(`${JSON.stringify({ package: { version: "0.1.0" }, artifacts: [{ path: "dist/server/index.js", bytes: artifact.length, sha256: createHash("sha256").update(artifact).digest("hex") }] })}\n`);
  await writeFile(join(packageRoot, "package/dist/release/manifest.json"), manifest, { mode: 0o644 });
  const archive = join(packageRoot, "candidate.tgz");
  await run("/bin/tar", ["-czf", archive, "-C", packageRoot, "package"]);
  const archiveBytes = await readFile(archive);
  const metadata: SignedRelease["metadata"] = {
    schemaVersion: 1, channel: "stable", version: "0.1.0", packageSha256: createHash("sha256").update(archiveBytes).digest("hex"),
    releaseManifestSha256: createHash("sha256").update(manifest).digest("hex"), sourceCommit,
    sourceRef: "refs/tags/v0.1.0", builder: "github-actions", createdAt: "2026-07-28T00:00:00.000Z",
  };
  const candidate: SignedRelease = { metadata, keyId: "fixture", signature: "fixture" };
  const request = { protocolVersion: 1, action: "upgrade", candidate, archivePath: archive, invokingUid: process.getuid?.() ?? 1000 } as UpgradeRequest;
  return { root, candidate, request, from, releaseId };
}

describe("root upgrade adapter", () => {
  it("stages an immutable release, switches current/previous, and retains migration backups", async () => {
    const { root, candidate, request } = await fixture();
    const commands: Array<[string, string[]]> = [];
    const io = new RootUpgradeIo({ root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async (file, args) => {
      if (file === "/bin/tar") await run(file, args);
      else commands.push([file, args]);
    }, health: async () => undefined });
    expect(await io.recover(candidate)).toBe("clean");
    await io.stage(candidate);
    await io.migrateConfig("0.0.9", "0.1.0");
    await io.activate("0.0.9", "0.1.0");
    await io.restart();
    await io.health();
    await io.commit();
    expect(await readlink(join(root, "opt/pi-together/current"))).toBe("/opt/pi-together/releases/0.1.0");
    expect(await readlink(join(root, "opt/pi-together/previous"))).toBe("/opt/pi-together/releases/0.0.9");
    expect(await readFile(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), "utf8")).toBe("new-release");
    expect(JSON.parse(await readFile(join(root, "var/lib/pi-together/install-manifest.json"), "utf8"))).toMatchObject({ version: "0.1.0" });
    expect(commands).toContainEqual(["/bin/systemctl", ["start", "pi-together.service"]]);
    expect(await readFile(join(root, "var/lib/pi-together/backups/upgrade-0.0.9-to-0.1.0.config.json"), "utf8")).toContain('"version":2');
  });

  it("restarts and verifies every Funnel service instead of leaving failed units inactive", async () => {
    const { root, request } = await fixture({ mode: "tailscale-funnel" });
    const commands: Array<[string, string[]]> = [];
    const io = new RootUpgradeIo({
      root,
      request,
      requireRoot: false,
      rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      command: async (file, args) => { commands.push([file, args]); },
      health: async () => undefined,
    });
    await io.migrateConfig("0.0.9", "0.1.0");
    await io.restart();
    await io.health();
    expect(commands).toEqual([
      ["/bin/systemctl", ["stop", "pi-together-funnel.service", "pi-together-edge.service", "pi-together.service", "pi-together-oauth2-proxy.service"]],
      ["/bin/systemctl", ["reset-failed", "pi-together.service", "pi-together-oauth2-proxy.service", "pi-together-edge.service", "pi-together-funnel.service"]],
      ["/bin/systemctl", ["start", "pi-together-oauth2-proxy.service"]],
      ["/bin/systemctl", ["start", "pi-together.service"]],
      ["/bin/systemctl", ["start", "pi-together-edge.service"]],
      ["/bin/systemctl", ["start", "pi-together-funnel.service"]],
      ["/bin/systemctl", ["is-active", "--quiet", "pi-together-oauth2-proxy.service"]],
      ["/bin/systemctl", ["is-active", "--quiet", "pi-together-edge.service"]],
      ["/bin/systemctl", ["is-active", "--quiet", "pi-together-funnel.service"]],
    ]);
  });

  it("explicitly migrates legacy workspace roots without broadening and retains the rollback source", async () => {
    const { root, request } = await fixture();
    const legacy = `${JSON.stringify({ version: 1, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, workspaceRoots: ["/srv/work"] })}\n`;
    await writeFile(join(root, "etc/pi-together/config.json"), legacy, { mode: 0o600 });
    const io = new RootUpgradeIo({ root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async () => undefined, health: async () => undefined });
    await io.migrateConfig("0.0.9", "0.1.0");
    expect(JSON.parse(await readFile(join(root, "etc/pi-together/config.json"), "utf8"))).toMatchObject({ version: 2, sharedRepositoryFolders: ["/srv/work"] });
    expect(await readFile(join(root, "var/lib/pi-together/backups/upgrade-0.0.9-to-0.1.0.config.json"), "utf8")).toBe(legacy);
  });

  it("recovers pre-activation interruption and reuses exact durable backups on retry", async () => {
    const { root, candidate, request } = await fixture();
    const options = { root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async (file: string, args: string[]) => { if (file === "/bin/tar") await run(file, args); }, health: async () => undefined };
    const interrupted = new RootUpgradeIo(options);
    await interrupted.stage(candidate); await interrupted.migrateConfig("0.0.9", "0.1.0");
    const resumed = new RootUpgradeIo(options);
    expect(await resumed.recover(candidate)).toBe("rolled-back");
    await resumed.stage(candidate);
    await expect(resumed.migrateConfig("0.0.9", "0.1.0")).resolves.toBeUndefined();
  });

  it("recovers an interrupted activated upgrade by rolling back before retry", async () => {
    const { root, candidate, request } = await fixture();
    const options = { root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async (file: string, args: string[]) => { if (file === "/bin/tar") await run(file, args); }, health: async () => undefined };
    const interrupted = new RootUpgradeIo(options);
    await interrupted.stage(candidate); await interrupted.migrateConfig("0.0.9", "0.1.0"); await interrupted.activate("0.0.9", "0.1.0");
    const resumed = new RootUpgradeIo(options);
    expect(await resumed.recover(candidate)).toBe("rolled-back");
    expect(await readlink(join(root, "opt/pi-together/current"))).toBe("/opt/pi-together/releases/0.0.9");
    await expect(readFile(join(root, "var/lib/pi-together/upgrade-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores an older previous rollback release when a later upgrade rolls back", async () => {
    const { root, candidate, request } = await fixture();
    await mkdir(join(root, "opt/pi-together/releases/0.0.8/server"), { recursive: true });
    await chmod(join(root, "opt/pi-together/releases/0.0.8"), 0o755);
    await writeFile(join(root, "opt/pi-together/releases/0.0.8/server/index.js"), "older-release", { mode: 0o644 });
    await symlink("/opt/pi-together/releases/0.0.8", join(root, "opt/pi-together/previous"));
    await writeFile(join(root, "var/lib/pi-together/install-manifest.json"), renderInstallManifest(buildInstallManifest("local", "0.0.9", undefined, "0.0.8")), { mode: 0o644 });
    const io = new RootUpgradeIo({ root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async (file, args) => { if (file === "/bin/tar") await run(file, args); }, health: async () => undefined });
    await io.stage(candidate); await io.migrateConfig("0.0.9", "0.1.0"); await io.activate("0.0.9", "0.1.0"); await io.rollback("0.0.9", "0.1.0");
    expect(await readlink(join(root, "opt/pi-together/previous"))).toBe("/opt/pi-together/releases/0.0.8");
    expect(JSON.parse(await readFile(join(root, "var/lib/pi-together/install-manifest.json"), "utf8"))).toMatchObject({ version: "0.0.9" });
  });

  it("restores the old current symlink, config, and inventory on rollback", async () => {
    const { root, candidate, request } = await fixture();
    const io = new RootUpgradeIo({ root, request, requireRoot: false, rootIdentity: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }, command: async (file, args) => { if (file === "/bin/tar") await run(file, args); }, health: async () => undefined });
    await io.stage(candidate); await io.migrateConfig("0.0.9", "0.1.0"); await io.activate("0.0.9", "0.1.0");
    await io.rollback("0.0.9", "0.1.0");
    expect(await readlink(join(root, "opt/pi-together/current"))).toBe("/opt/pi-together/releases/0.0.9");
    expect(JSON.parse(await readFile(join(root, "var/lib/pi-together/install-manifest.json"), "utf8"))).toMatchObject({ version: "0.0.9" });
    await expect(readFile(join(root, "opt/pi-together/releases/0.1.0/server/index.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
