import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { loadCurrentRelease, resolveReleaseBundleRoot, runUpgradeCommand, type UpgradeCommandOptions } from "../cli/upgrade.js";
import { RELEASE_SIGNING_KEY_ID, type SignedRelease } from "../cli/upgrade-core.js";

const candidate: SignedRelease = {
  metadata: {
    schemaVersion: 1, channel: "stable", version: "0.1.0", packageSha256: "c".repeat(64), releaseManifestSha256: "d".repeat(64),
    sourceRef: "refs/tags/v0.1.0", sourceCommit: "a".repeat(40), builder: "github-actions", createdAt: "2026-07-28T00:00:00.000Z",
  },
  keyId: RELEASE_SIGNING_KEY_ID,
  signature: "ME9OcwFR14qQlIwF+NJhDT9l08AsDT59s8d7D+ZS1Kc5bsnhNNiKrUU8sA97OX1AULLLuwl3jlumSNRo80SdDg==",
};
function options(output: string[]): UpgradeCommandOptions {
  return {
    bundleRoot: "/release/bundle",
    loadBundle: async () => ({ candidate, archivePath: "/release/bundle/pi-together-0.1.0.tgz" }),
    loadCurrent: async () => "0.0.9",
    write: (message) => output.push(message),
    uid: 1000,
  };
}
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("upgrade CLI", () => {
  it("reads the public immutable release link without traversing protected inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-upgrade-current-"));
    roots.push(root);
    await mkdir(join(root, "releases", "0.1.0"), { recursive: true });
    await symlink(join(root, "releases", "0.1.0"), join(root, "current"));
    await expect(loadCurrentRelease(root)).resolves.toBe("0.1.0");
    await rm(join(root, "current"));
    await symlink("/tmp/outside-release", join(root, "current"));
    await expect(loadCurrentRelease(root)).rejects.toThrow();
  });

  it("uses an explicit or configured signed release bundle", () => {
    expect(resolveReleaseBundleRoot(undefined, undefined, "/work/pi-together")).toBe("/work/pi-together/release-bundle");
    expect(resolveReleaseBundleRoot(undefined, "/secure/bundle", "/work/pi-together")).toBe("/secure/bundle");
    expect(resolveReleaseBundleRoot("./candidate", "/secure/bundle", "/work/pi-together")).toBe("/work/pi-together/candidate");
  });

  it("keeps signed release dry-run mutation-free", async () => {
    const output: string[] = [];
    let invoked = false;
    expect(await runUpgradeCommand(["latest", "--bundle", "/release/bundle", "--dry-run"], async () => { invoked = true; }, options(output))).toBe(false);
    expect(invoked).toBe(false);
    expect(output.join("")).toContain("Dry-run only");
  });

  it("passes the exact signed request only after confirmation", async () => {
    const output: string[] = [];
    let request: unknown;
    expect(await runUpgradeCommand(["0.1.0"], async (value) => { request = value; }, { ...options(output), confirm: async () => true })).toBe(true);
    expect(request).toMatchObject({ action: "upgrade", invokingUid: 1000, candidate: { metadata: { version: "0.1.0" } } });
    expect(output.join("")).not.toContain(renderInstallManifest(buildInstallManifest("local", "0.0.9")));
  });

  it("rejects branches, conflicting flags, malformed bundle options, and cancellation", async () => {
    const output: string[] = [];
    await expect(runUpgradeCommand(["main"], undefined, options(output))).rejects.toThrow();
    await expect(runUpgradeCommand(["--dry-run", "--yes"], undefined, options(output))).rejects.toThrow(/invalid/);
    await expect(runUpgradeCommand(["--bundle"], undefined, options(output))).rejects.toThrow(/bundle/);
    expect(await runUpgradeCommand([], undefined, { ...options(output), confirm: async () => false })).toBe(false);
  });
});
