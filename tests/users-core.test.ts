import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyUserManagement,
  oauthUsers,
  replaceOauthUsers,
  type CurrentUserManagementState,
  type UserManagementIo,
  type UserManagementRequest,
} from "../privileged/users-core.js";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const oauthArchive = "/var/lib/pi-together/downloads/oauth2-proxy-v7.15.3.linux-amd64.tar.gz";
const config = (principals = [
  { provider: "github" as const, subject: "1", login: "alice", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" as const },
]) => `${JSON.stringify({
  version: 2,
  mode: "reverse-proxy",
  listener: { kind: "unix", path: "/run/pi-together/app.sock" },
  publicOrigin: "https://pi.example.com",
  proxySecret: "a".repeat(43),
  principals,
  sharedRepositoryFolders: ["/srv/work"],
}, null, 2)}\n`;
const oauth = (users = ["alice"]) => `provider = "github"\ngithub_users = ${JSON.stringify(users)}\nemail_domains = ["*"]\n`;
const manifest = renderInstallManifest(buildInstallManifest("reverse-proxy", "0.1.0", oauthArchive));

function fixture(operation: UserManagementRequest["operation"]): {
  request: UserManagementRequest;
  current: CurrentUserManagementState;
} {
  const appConfig = config();
  const oauthConfig = oauth();
  return {
    request: {
      protocolVersion: 1,
      action: "manage-users",
      invokingUid: 1000,
      operation,
      expected: {
        appConfigSha256: sha256(appConfig),
        oauthConfigSha256: sha256(oauthConfig),
        manifestSha256: sha256(manifest),
      },
    },
    current: { appConfig, oauthConfig, manifest, appConfigOwnerUid: 1000 },
  };
}

function io(current: CurrentUserManagementState, resolvedSubject = "2") {
  const changes: Parameters<UserManagementIo["commit"]>[0][] = [];
  const implementation: UserManagementIo = {
    loadCurrent: async () => current,
    resolveLogin: async (login) => ({
      provider: "github", subject: resolvedSubject, login,
      verifiedAt: "2026-01-02T00:00:00.000Z", verification: "verified",
    }),
    commit: async (change) => { changes.push(change); },
  };
  return { implementation, changes };
}

describe("privileged user management", () => {
  it("parses and deterministically replaces the one oauth allowlist", () => {
    expect(oauthUsers(oauth(["bob", "alice"]))).toEqual(["alice", "bob"]);
    expect(replaceOauthUsers(oauth(["alice"]), ["bob", "alice"])).toContain('github_users = ["alice","bob"]');
    expect(() => oauthUsers("github_users = []\ngithub_users = []\n")).toThrow(/exactly one/);
  });

  it("independently verifies and adds one canonical GitHub principal", async () => {
    const { request, current } = fixture({ kind: "add", login: "bob", subject: "2" });
    const target = io(current);
    await applyUserManagement(request, target.implementation);
    expect(target.changes).toHaveLength(1);
    expect(JSON.parse(target.changes[0]!.appConfig).principals.map((item: { login: string }) => item.login)).toEqual(["alice", "bob"]);
    expect(oauthUsers(target.changes[0]!.oauthConfig)).toEqual(["alice", "bob"]);
    expect(target.changes[0]!.kind).toBe("add");
  });

  it("removes a principal from both independently checked configurations", async () => {
    const principals = [
      { provider: "github" as const, subject: "1", login: "alice", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" as const },
      { provider: "github" as const, subject: "2", login: "bob", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" as const },
    ];
    const base = fixture({ kind: "remove", login: "bob" });
    base.current.appConfig = config(principals);
    base.current.oauthConfig = oauth(["alice", "bob"]);
    base.request.expected.appConfigSha256 = sha256(base.current.appConfig);
    base.request.expected.oauthConfigSha256 = sha256(base.current.oauthConfig);
    const target = io(base.current);
    await applyUserManagement(base.request, target.implementation);
    expect(oauthUsers(target.changes[0]!.oauthConfig)).toEqual(["alice"]);
  });

  it("fails closed on stale input, config drift, identity mismatch, duplicates, and last-user removal", async () => {
    const stale = fixture({ kind: "add", login: "bob", subject: "2" });
    stale.request.expected.appConfigSha256 = "0".repeat(64);
    await expect(applyUserManagement(stale.request, io(stale.current).implementation)).rejects.toThrow(/changed/);

    const drift = fixture({ kind: "add", login: "bob", subject: "2" });
    drift.current.oauthConfig = oauth(["mallory"]);
    drift.request.expected.oauthConfigSha256 = sha256(drift.current.oauthConfig);
    await expect(applyUserManagement(drift.request, io(drift.current).implementation)).rejects.toThrow(/disagree/);

    const mismatch = fixture({ kind: "add", login: "bob", subject: "2" });
    await expect(applyUserManagement(mismatch.request, io(mismatch.current, "3").implementation)).rejects.toThrow(/identity changed/);

    const duplicate = fixture({ kind: "add", login: "alice", subject: "1" });
    await expect(applyUserManagement(duplicate.request, io(duplicate.current, "1").implementation)).rejects.toThrow(/already allowed/);

    const last = fixture({ kind: "remove", login: "alice" });
    await expect(applyUserManagement(last.request, io(last.current).implementation)).rejects.toThrow(/last allowed/);

    const unsafeSocket = fixture({ kind: "add", login: "bob", subject: "2" });
    unsafeSocket.current.appConfig = unsafeSocket.current.appConfig.replace("/run/pi-together/app.sock", "/run/docker.sock");
    unsafeSocket.request.expected.appConfigSha256 = sha256(unsafeSocket.current.appConfig);
    await expect(applyUserManagement(unsafeSocket.request, io(unsafeSocket.current).implementation)).rejects.toThrow(/canonical private application socket/);
  });
});
