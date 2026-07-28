import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { uninstallValidated, validateUninstallRequest } from "../privileged/uninstall-core.js";
import { RootUninstallIo } from "../privileged/uninstall-io.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-uninstall-"));
  roots.push(root);
  for (const path of ["var/lib/pi-together/backups", "etc/pi-together", "etc/systemd/system", "opt/pi-together/releases/0.1.0/server"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  await chmod(join(root, "opt/pi-together/releases/0.1.0"), 0o755);
  await writeFile(join(root, "etc/pi-together/config.json"), "preserve-config\n", { mode: 0o600 });
  await writeFile(join(root, "var/lib/pi-together/backups/keep"), "preserve-backup\n");
  await writeFile(join(root, "var/lib/pi-together/policy-journal.json"), "owned-policy-journal\n", { mode: 0o600 });
  await writeFile(join(root, "etc/systemd/system/unrelated.service"), "preserve-unrelated\n");
  await writeFile(join(root, "etc/systemd/system/pi-together.service"), "owned-unit\n");
  await writeFile(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), "owned-release\n", { mode: 0o644 });
  await chmod(join(root, "opt/pi-together/releases/0.1.0/server"), 0o755);
  await symlink("/opt/pi-together/releases/0.1.0", join(root, "opt/pi-together/current"));
  const manifest = buildInstallManifest("local", "0.1.0");
  const bytes = renderInstallManifest(manifest);
  await writeFile(join(root, "var/lib/pi-together/install-manifest.json"), bytes, { mode: 0o644 });
  const request = { protocolVersion: 1 as const, action: "uninstall" as const, invokingUid: process.getuid?.() ?? 1000, manifest, manifestSha256: createHash("sha256").update(bytes).digest("hex"), purgeConfig: false };
  return { root, request };
}

describe("root uninstall adapter", () => {
  it("rejects uninstall when sudo provenance does not match the invoking owner", async () => {
    const { root, request } = await fixture();
    expect(() => new RootUninstallIo({
      root, requireRoot: false, invokingUid: request.invokingUid, sudoUid: request.invokingUid + 1,
    })).toThrow(/sudo provenance/);
  });

  it("removes only canonical inventory and preserves Pi/config/backups/unrelated files", async () => {
    const { root, request } = await fixture();
    // Compatibility with releases created by the initial installer before it normalized root-group modes.
    await chmod(join(root, "opt/pi-together/releases/0.1.0"), 0o775);
    await chmod(join(root, "opt/pi-together/releases/0.1.0/server"), 0o775);
    await chmod(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), 0o664);
    const commands: Array<[string, string[]]> = [];
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async (file, args) => { commands.push([file, args]); } });
    await uninstallValidated(request, io);
    expect(await readFile(join(root, "etc/pi-together/config.json"), "utf8")).toBe("preserve-config\n");
    expect(await readFile(join(root, "var/lib/pi-together/backups/keep"), "utf8")).toBe("preserve-backup\n");
    expect(await readFile(join(root, "etc/systemd/system/unrelated.service"), "utf8")).toBe("preserve-unrelated\n");
    await expect(lstat(join(root, "etc/systemd/system/pi-together.service"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "var/lib/pi-together/policy-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "opt/pi-together/current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "opt/pi-together/releases/0.1.0"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(commands).toContainEqual(["/bin/systemctl", ["disable", "--now", "pi-together.service"]]);
    expect(commands).toContainEqual(["/bin/systemctl", ["daemon-reload"]]);
    expect(commands.some(([, args]) => args.includes("unrelated.service"))).toBe(false);
  });

  it("resumes the exact prefix journal written by the initial failed uninstall", async () => {
    const { root, request } = await fixture();
    const completed = ["stop-app", "remove-app-service", "daemon-reload", "remove-current"];
    await writeFile(join(root, "var/lib/pi-together/uninstall-journal.json"), `${JSON.stringify({
      schemaVersion: 1, manifestSha256: request.manifestSha256, purgeConfig: false, completed,
    })}\n`, { mode: 0o600 });
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    await expect(io.recover(validateUninstallRequest(request))).resolves.toEqual(new Set(completed));
  });

  it("resumes a legacy completed journal after the old finalizer already removed the manifest", async () => {
    const { root, request } = await fixture();
    const validated = validateUninstallRequest(request);
    await writeFile(join(root, "var/lib/pi-together/uninstall-journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      manifestSha256: request.manifestSha256,
      purgeConfig: false,
      completed: validated.operations.map((operation) => operation.id),
    })}\n`, { mode: 0o600 });
    await rm(join(root, "var/lib/pi-together/install-manifest.json"));
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    await expect(uninstallValidated(request, io)).resolves.toBeUndefined();
    await expect(lstat(join(root, "var/lib/pi-together/uninstall-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes restart-complete journals containing the exact inventory and invoking identity", async () => {
    const { root, request } = await fixture();
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    await io.recover(validateUninstallRequest(request));
    expect(JSON.parse(await readFile(join(root, "var/lib/pi-together/uninstall-journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      manifestSha256: request.manifestSha256,
      manifest: request.manifest,
      invokingUid: request.invokingUid,
      completed: [],
    });
  });

  it("removes the recovery journal before the final manifest so an interrupted finish can restart", async () => {
    const { root, request } = await fixture();
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    const validated = validateUninstallRequest(request);
    await io.recover(validated);
    const manifestPath = join(root, "var/lib/pi-together/install-manifest.json");
    await rm(manifestPath);
    await mkdir(manifestPath);
    await expect(io.finish()).rejects.toThrow(/target type changed/);
    await expect(lstat(join(root, "var/lib/pi-together/uninstall-journal.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await rm(manifestPath, { recursive: true });
    await writeFile(manifestPath, renderInstallManifest(request.manifest), { mode: 0o644 });
    await uninstallValidated(request, new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined }));
  });

  it("still rejects a world-writable release tree", async () => {
    const { root, request } = await fixture();
    await chmod(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), 0o666);
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    await expect(uninstallValidated(request, io)).rejects.toThrow(/release tree is unsafe/);
    expect(await readFile(join(root, "opt/pi-together/releases/0.1.0/server/index.js"), "utf8")).toBe("owned-release\n");
  });

  it("refuses deletion when an owned service cannot be proven inactive", async () => {
    const { root, request } = await fixture();
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "active", command: async () => { throw new Error("synthetic stop failure"); } });
    await expect(uninstallValidated(request, io)).rejects.toThrow(/could not be stopped/);
    expect(await readFile(join(root, "etc/systemd/system/pi-together.service"), "utf8")).toBe("owned-unit\n");
  });

  it("rejects a swapped release symlink without deleting its destination", async () => {
    const { root, request } = await fixture();
    await rm(join(root, "opt/pi-together/current"));
    await symlink("/srv/work", join(root, "opt/pi-together/current"));
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const io = new RootUninstallIo({ root, requireRoot: false, rootIdentity: identity, serviceState: async () => "inactive", command: async () => undefined });
    await expect(uninstallValidated(request, io)).rejects.toThrow(/symlink target changed/);
    expect((await lstat(join(root, "opt/pi-together/current"))).isSymbolicLink()).toBe(true);
  });
});
