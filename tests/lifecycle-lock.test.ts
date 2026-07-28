import { chmod, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { interruptedActionBlocking, pendingPrivilegedActions, PrivilegedLifecycleLock } from "../privileged/lifecycle-lock.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-lock-"));
  roots.push(root);
  const lockPath = join(root, "lifecycle.lock");
  const identity = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
  return { root, lockPath, identity };
}

describe("privileged lifecycle lock", () => {
  it("serializes live operations and permits the owner to release", async () => {
    const value = await fixture();
    const first = new PrivilegedLifecycleLock({ path: value.lockPath, rootIdentity: value.identity, requireRoot: false });
    await first.acquire("manage-users");
    const second = new PrivilegedLifecycleLock({ path: value.lockPath, rootIdentity: value.identity, requireRoot: false, processAlive: () => true });
    await expect(second.acquire("upgrade")).rejects.toThrow(/still running/);
    await first.release();
    await expect(stat(value.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims a dead owner's lock without weakening journal recovery", async () => {
    const value = await fixture();
    await writeFile(value.lockPath, `${JSON.stringify({ schemaVersion: 1, action: "upgrade", ownerPid: 999999 })}\n`, { mode: 0o600 });
    await chmod(value.lockPath, 0o600);
    const lock = new PrivilegedLifecycleLock({ path: value.lockPath, rootIdentity: value.identity, requireRoot: false, processAlive: () => false });
    await lock.acquire("manage-users");
    await lock.release();
  });

  it("requires explicit recovery even before rerunning the same action, except exact uninstall resumption", () => {
    expect(interruptedActionBlocking("apply", new Set(["apply"]))).toBe("apply");
    expect(interruptedActionBlocking("manage-users", new Set(["manage-users"]))).toBe("manage-users");
    expect(interruptedActionBlocking("recover", new Set(["apply"]))).toBeUndefined();
    expect(interruptedActionBlocking("uninstall", new Set(["uninstall"]))).toBeUndefined();
    expect(interruptedActionBlocking("uninstall", new Set(["uninstall", "apply"]))).toBeDefined();
  });

  it("detects root-owned recovery journals across lifecycle actions", async () => {
    const value = await fixture();
    for (const directory of ["var/lib/pi-together", "var/tmp"]) await mkdir(join(value.root, directory), { recursive: true });
    const journal = join(value.root, "var/lib/pi-together/upgrade-journal.json");
    await writeFile(journal, "{}\n", { mode: 0o600 });
    await chmod(journal, 0o600);
    const apply = join(value.root, `var/tmp/pi-together-apply-${"a".repeat(64)}.json`);
    await writeFile(apply, "{}\n", { mode: 0o600 });
    await chmod(apply, 0o600);
    expect(await pendingPrivilegedActions(value.root, value.identity)).toEqual(new Set(["upgrade", "apply"]));
  });
});
