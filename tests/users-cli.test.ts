import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runUsersCommand, type UsersCommandOptions } from "../cli/users.js";
import type { CurrentUserManagementState, UserManagementRequest } from "../privileged/users-core.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
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
const current: CurrentUserManagementState = {
  appConfig,
  oauthConfig: 'provider = "github"\ngithub_users = ["alice","bob"]\n',
  manifest: '{"fixture":true}\n',
  appConfigOwnerUid: 1000,
};

function options(confirm = true) {
  const output: string[] = [];
  const requests: UserManagementRequest[] = [];
  const value: UsersCommandOptions = {
    uid: 1000,
    loadCurrent: async () => current,
    resolveLogin: async (login) => ({
      kind: "verified",
      mapping: { provider: "github", subject: "3", login, verifiedAt: "2026-01-02T00:00:00.000Z", verification: "verified" },
    }),
    confirm: async () => confirm,
    write: (message) => { output.push(message); },
    invoke: async (request) => { requests.push(request); },
  };
  return { value, output, requests };
}

describe("users CLI", () => {
  it("lists canonical allowed users without sudo", async () => {
    const target = options();
    expect(await runUsersCommand(["list"], target.value)).toBe(true);
    expect(target.output.join("")).toContain("alice  GitHub ID 1");
    expect(target.output.join("")).toContain("bob  GitHub ID 2");
    expect(target.requests).toEqual([]);
  });

  it("verifies, reviews, and invokes an add request", async () => {
    const target = options();
    expect(await runUsersCommand(["add", "Carol"], target.value)).toBe(true);
    expect(target.requests[0]).toMatchObject({
      protocolVersion: 1, action: "manage-users", invokingUid: 1000,
      operation: { kind: "add", login: "carol", subject: "3" },
      expected: {
        appConfigSha256: sha256(current.appConfig),
        oauthConfigSha256: sha256(current.oauthConfig),
        manifestSha256: sha256(current.manifest),
      },
    });
    expect(target.output.join("")).toContain("independently reverified");
  });

  it("supports reviewed removal and cancellation without privileged invocation", async () => {
    const remove = options();
    expect(await runUsersCommand(["remove", "bob", "--yes"], remove.value)).toBe(true);
    expect(remove.requests[0]?.operation).toEqual({ kind: "remove", login: "bob" });

    const cancelled = options(false);
    expect(await runUsersCommand(["remove", "bob"], cancelled.value)).toBe(false);
    expect(cancelled.requests).toEqual([]);
  });

  it("rejects root, invalid shapes, duplicates, unknown removals, and removing the final user before sudo", async () => {
    const root = options();
    root.value.uid = 0;
    await expect(runUsersCommand(["list"], root.value)).rejects.toThrow(/non-root/);
    await expect(runUsersCommand(["add"], options().value)).rejects.toThrow(/Usage/);
    await expect(runUsersCommand(["list", "extra"], options().value)).rejects.toThrow(/Usage/);
    await expect(runUsersCommand(["add", "alice"], options().value)).rejects.toThrow(/already allowed/);
    await expect(runUsersCommand(["remove", "mallory"], options().value)).rejects.toThrow(/not currently allowed/);

    const one = options();
    one.value.loadCurrent = async () => ({
      ...current,
      appConfig: `${JSON.stringify({ ...JSON.parse(appConfig), principals: [JSON.parse(appConfig).principals[0]] }, null, 2)}\n`,
      oauthConfig: 'github_users = ["alice"]\n',
    });
    await expect(runUsersCommand(["remove", "alice"], one.value)).rejects.toThrow(/last allowed/);
  });
});
