import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { canonicalInstallationIsAbsent, loadInstalledOrRecoveryManifest } from "../privileged/uninstall-inventory.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-uninstall-inventory-"));
  roots.push(root);
  const state = join(root, "var/lib/pi-together");
  await mkdir(state, { recursive: true });
  const manifest = buildInstallManifest("local", "0.1.0");
  const canonical = renderInstallManifest(manifest);
  const manifestSha256 = createHash("sha256").update(canonical).digest("hex");
  return { root, state, manifest, canonical, manifestSha256 };
}

describe("protected uninstall inventory recovery", () => {
  it("reports already-uninstalled only when bounded canonical managed markers are absent", async () => {
    const { root } = await fixture();
    expect(await canonicalInstallationIsAbsent(root)).toBe(true);
    await mkdir(join(root, "etc/systemd/system"), { recursive: true });
    await writeFile(join(root, "etc/systemd/system/pi-together.service"), "synthetic\n");
    expect(await canonicalInstallationIsAbsent(root)).toBe(false);
  });

  it("reconstructs the exact deterministic local inventory from a legacy root journal", async () => {
    const { state, manifest, manifestSha256 } = await fixture();
    await writeFile(join(state, "uninstall-journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      manifestSha256,
      purgeConfig: false,
      completed: ["stop-app"],
    })}\n`, { mode: 0o600 });
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const loaded = await loadInstalledOrRecoveryManifest(
      "0.1.0",
      join(state, "install-manifest.json"),
      join(state, "uninstall-journal.json"),
      identity,
    );
    expect(loaded).toEqual({ manifest, manifestSha256, recovery: "journal" });
  });

  it("rejects a legacy journal whose digest does not prove the reconstructed inventory", async () => {
    const { state } = await fixture();
    await writeFile(join(state, "uninstall-journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      manifestSha256: "a".repeat(64),
      purgeConfig: false,
      completed: [],
    })}\n`, { mode: 0o600 });
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    await expect(loadInstalledOrRecoveryManifest(
      "0.1.0",
      join(state, "install-manifest.json"),
      join(state, "uninstall-journal.json"),
      identity,
    )).rejects.toThrow(/cannot reconstruct the exact inventory/);
  });

  it("rejects unsafe recovery-journal metadata", async () => {
    const { state, manifestSha256 } = await fixture();
    const journal = join(state, "uninstall-journal.json");
    await writeFile(journal, `${JSON.stringify({ schemaVersion: 1, manifestSha256, completed: [] })}\n`, { mode: 0o600 });
    await chmod(journal, 0o666);
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    await expect(loadInstalledOrRecoveryManifest("0.1.0", join(state, "missing.json"), journal, identity)).rejects.toThrow(/unsafe metadata/);
  });
});
