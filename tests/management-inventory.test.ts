import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { loadUserManagementState } from "../cli/users.js";
import { loadWorkspaceManagementState } from "../cli/workspaces.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-management-inventory-"));
  roots.push(root);
  await mkdir(join(root, "etc"));
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const appConfig = `${JSON.stringify({
    version: 2,
    mode: "reverse-proxy",
    listener: { kind: "unix", path: "/run/pi-together/app.sock" },
    publicOrigin: "https://pi.example.com",
    proxySecret: "a".repeat(43),
    principals: [{ provider: "github", subject: "1", login: "alice", verifiedAt: "2026-01-01T00:00:00.000Z", verification: "verified" }],
    sharedRepositoryFolders: [root],
  }, null, 2)}\n`;
  const appConfigPath = join(root, "etc/config.json");
  const oauthConfigPath = join(root, "etc/oauth.cfg");
  await writeFile(appConfigPath, appConfig, { mode: 0o600 });
  await writeFile(oauthConfigPath, 'github_users = ["alice"]\n', { mode: 0o644 });
  const manifest = buildInstallManifest(
    "reverse-proxy",
    "0.1.0",
    "/var/lib/pi-together/downloads/oauth2-proxy-v7.12.0.linux-amd64.tar.gz",
  );
  return { root, uid, gid, appConfigPath, oauthConfigPath, manifest };
}

describe("management protected inventory inspection", () => {
  it("loads user and workspace state through the bounded privileged manifest lane", async () => {
    const target = await fixture();
    const inspected: number[] = [];
    const inspect = async (uid: number) => {
      inspected.push(uid);
      return { manifest: target.manifest, manifestSha256: "f".repeat(64) };
    };
    const users = await loadUserManagementState(
      target.uid,
      { appConfig: target.appConfigPath, oauthConfig: target.oauthConfigPath, manifest: join(target.root, "protected-manifest.json") },
      { uid: target.uid, gid: target.gid },
      inspect,
    );
    const workspaces = await loadWorkspaceManagementState(
      target.uid,
      { appConfig: target.appConfigPath, manifest: join(target.root, "protected-manifest.json") },
      inspect,
    );
    expect(users.manifest).toBe(renderInstallManifest(target.manifest));
    expect(workspaces.manifest).toBe(renderInstallManifest(target.manifest));
    expect(inspected).toEqual([target.uid, target.uid]);
  });
});
