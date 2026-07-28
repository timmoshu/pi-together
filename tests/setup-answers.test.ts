import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecureAnswers, oauthApplicationUrls, redactAnswers, SetupAnswersSchema } from "../cli/setup-answers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
const local = {
  schemaVersion: 2,
  acceptedHostPermissionRisk: true,
  mode: "local",
  sharedRepositoryFolders: ["/srv/work"],
  startNow: true,
  enableBootService: false,
} as const;

function fixture(value: unknown, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-together-answers-"));
  dirs.push(directory);
  const path = join(directory, "answers.json");
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

describe("secure setup answers", () => {
  it("loads a regular owned 0600 file and validates strict typed answers", async () => {
    await expect(loadSecureAnswers(fixture(local))).resolves.toEqual(local);
    expect(() => SetupAnswersSchema.parse({ ...local, extra: true })).toThrow();
    expect(() => SetupAnswersSchema.parse({ ...local, acceptedHostPermissionRisk: false })).toThrow();
    expect(() => SetupAnswersSchema.parse({ ...local, sharedRepositoryFolders: ["/srv/work/../other"] })).toThrow();
    expect(() => SetupAnswersSchema.parse({ ...local, sharedRepositoryFolders: ["/"] })).toThrow();
  });

  it.each([0o644, 0o640, 0o400, 0o666])("rejects mode %o", async (mode) => {
    await expect(loadSecureAnswers(fixture(local, mode))).rejects.toThrow(/0600/);
  });

  it("rejects symlinks and wrong ownership", async () => {
    const target = fixture(local);
    const link = `${target}.link`;
    symlinkSync(target, link);
    await expect(loadSecureAnswers(link)).rejects.toThrow(/non-symlink/);
    await expect(loadSecureAnswers(target, (process.getuid?.() ?? 0) + 1)).rejects.toThrow(/owned/);
  });

  it("accepts Funnel answers without a user-owned domain or certificate email", () => {
    const answers = SetupAnswersSchema.parse({
      ...local,
      mode: "tailscale-funnel",
      tailscaleDnsName: "example-node.example-tailnet.ts.net",
      githubLogins: ["Alice"],
      oauthClientId: "client-id",
      oauthClientSecret: "secret-value-123456",
    });
    expect(answers.mode).toBe("tailscale-funnel");
    expect("certificateEmail" in answers).toBe(false);
  });

  it("redacts secrets and renders exact OAuth application URLs", () => {
    const publicAnswers = SetupAnswersSchema.parse({
      ...local,
      mode: "reverse-proxy",
      domain: "pi.example.com",
      githubLogins: ["Alice", "alice", "bob"],
      oauthClientId: "client-id",
      oauthClientSecret: "secret-value-123456",
      certificateEmail: "ops@example.com",
    });
    expect(publicAnswers.mode).toBe("reverse-proxy");
    if (publicAnswers.mode !== "reverse-proxy") throw new Error("expected public answers");
    expect(publicAnswers.githubLogins).toEqual(["alice", "bob"]);
    expect(JSON.stringify(redactAnswers(publicAnswers))).not.toContain("secret-value");
    expect(oauthApplicationUrls("pi.example.com")).toEqual({
      homepage: "https://pi.example.com",
      callback: "https://pi.example.com/oauth2/callback",
    });
  });
});
