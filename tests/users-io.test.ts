import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { applyUserManagement, type UserManagementRequest } from "../privileged/users-core.js";
import { RootUsersIo } from "../privileged/users-io.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(release = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "pi-together-users-"));
  roots.push(root);
  for (const directory of ["etc/pi-together", "var/lib/pi-together", "opt/pi-together/helpers"]) {
    const path = join(root, directory);
    await mkdir(path, { recursive: true });
    await chmod(path, 0o755);
  }
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const appConfig = `${JSON.stringify({
    version: 2,
    mode: "reverse-proxy",
    listener: { kind: "unix", path: "/run/pi-together/app.sock" },
    publicOrigin: "https://pi.example.com",
    proxySecret: "a".repeat(43),
    principals: [
      { provider: "github", subject: "1", login: "alice", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" },
      { provider: "github", subject: "2", login: "bob", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" },
    ],
    sharedRepositoryFolders: ["/srv/work"],
  }, null, 2)}\n`;
  const oauthConfig = 'provider = "github"\ngithub_users = ["alice","bob"]\n';
  const manifest = renderInstallManifest(buildInstallManifest(
    "reverse-proxy", release, "/var/lib/pi-together/downloads/oauth2-proxy-v7.15.3.linux-amd64.tar.gz",
  ));
  await writeFile(join(root, "etc/pi-together/config.json"), appConfig, { mode: 0o600 });
  await writeFile(join(root, "etc/pi-together/oauth2-proxy.cfg"), oauthConfig, { mode: 0o644 });
  await writeFile(join(root, "var/lib/pi-together/install-manifest.json"), manifest, { mode: 0o644 });
  const request: UserManagementRequest = {
    protocolVersion: 1,
    action: "manage-users",
    invokingUid: uid,
    operation: { kind: "remove", login: "bob" },
    expected: {
      appConfigSha256: sha256(appConfig), oauthConfigSha256: sha256(oauthConfig), manifestSha256: sha256(manifest),
    },
  };
  return { root, uid, gid, appConfig, oauthConfig, request };
}

describe("root user-management I/O", () => {
  it("accepts a canonical stable release produced by the same helper package version", async () => {
    const value = await fixture("0.1.0");
    const io = new RootUsersIo({
      request: value.request, root: value.root, rootIdentity: { uid: value.uid, gid: value.gid }, requireRoot: false,
      services: { isActive: async () => true, restart: async () => undefined },
      validateOauth: async () => undefined, health: async () => undefined,
    });
    await expect(io.loadCurrent(value.request)).resolves.toMatchObject({ manifest: expect.stringContaining("0.1.0") });
  });

  it("atomically changes both allowlists, preserves metadata, and restarts removal in fail-closed order", async () => {
    const value = await fixture();
    const restarts: string[] = [];
    const io = new RootUsersIo({
      request: value.request, root: value.root, rootIdentity: { uid: value.uid, gid: value.gid }, requireRoot: false,
      services: { isActive: async () => true, restart: async (unit) => { restarts.push(unit); } },
      validateOauth: async () => undefined,
      health: async () => undefined,
    });
    await applyUserManagement(value.request, io);
    expect(JSON.parse(await readFile(join(value.root, "etc/pi-together/config.json"), "utf8")).principals.map((p: { login: string }) => p.login)).toEqual(["alice"]);
    expect(await readFile(join(value.root, "etc/pi-together/oauth2-proxy.cfg"), "utf8")).toContain('github_users = ["alice"]');
    expect(restarts).toEqual(["pi-together-oauth2-proxy.service", "pi-together.service"]);
    expect((await stat(join(value.root, "etc/pi-together/config.json"))).mode & 0o777).toBe(0o600);
    await expect(stat(join(value.root, "var/lib/pi-together/user-management-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an interrupted dead process before accepting a new reviewed request", async () => {
    const value = await fixture();
    const journal = {
      schemaVersion: 1, operation: "remove", ownerPid: 99999999, invokingUid: value.uid, appGid: value.gid,
      appConfig: value.appConfig, oauthConfig: value.oauthConfig, appWasActive: true, oauthWasActive: true,
    };
    await writeFile(join(value.root, "var/lib/pi-together/user-management-journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await writeFile(join(value.root, "etc/pi-together/config.json"), value.appConfig.replace('"bob"', '"carol"'), { mode: 0o600 });
    await writeFile(join(value.root, "etc/pi-together/oauth2-proxy.cfg"), 'github_users = ["alice","carol"]\n', { mode: 0o644 });
    const restarts: string[] = [];
    const io = new RootUsersIo({
      request: value.request, root: value.root, rootIdentity: { uid: value.uid, gid: value.gid }, requireRoot: false,
      services: { isActive: async () => true, restart: async (unit) => { restarts.push(unit); } },
      validateOauth: async () => undefined, health: async () => undefined,
    });
    const recovered = await io.loadCurrent(value.request);
    expect(recovered.appConfig).toBe(value.appConfig);
    expect(recovered.oauthConfig).toBe(value.oauthConfig);
    expect(restarts).toEqual(["pi-together.service", "pi-together-oauth2-proxy.service"]);
  });

  it("refuses to recover a journal owned by a still-running operation", async () => {
    const value = await fixture();
    const journal = {
      schemaVersion: 1, operation: "add", ownerPid: process.ppid, invokingUid: value.uid, appGid: value.gid,
      appConfig: value.appConfig, oauthConfig: value.oauthConfig, appWasActive: true, oauthWasActive: true,
    };
    await writeFile(join(value.root, "var/lib/pi-together/user-management-journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    const io = new RootUsersIo({
      request: value.request, root: value.root, rootIdentity: { uid: value.uid, gid: value.gid }, requireRoot: false,
      services: { isActive: async () => true, restart: async () => undefined },
      validateOauth: async () => undefined, health: async () => undefined,
    });
    await expect(io.loadCurrent(value.request)).rejects.toThrow(/still in progress/);
  });

  it("rolls both files back and clears the durable journal after a restart fault", async () => {
    const value = await fixture();
    let failed = false;
    const io = new RootUsersIo({
      request: value.request, root: value.root, rootIdentity: { uid: value.uid, gid: value.gid }, requireRoot: false,
      services: {
        isActive: async () => true,
        restart: async (unit) => {
          if (unit === "pi-together.service" && !failed) { failed = true; throw new Error("injected restart fault"); }
        },
      },
      validateOauth: async () => undefined,
      health: async () => undefined,
    });
    await expect(applyUserManagement(value.request, io)).rejects.toThrow(/injected restart fault/);
    expect(await readFile(join(value.root, "etc/pi-together/config.json"), "utf8")).toBe(value.appConfig);
    expect(await readFile(join(value.root, "etc/pi-together/oauth2-proxy.cfg"), "utf8")).toBe(value.oauthConfig);
    await expect(stat(join(value.root, "var/lib/pi-together/user-management-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
