import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { InstallManifestSchema, buildInstallManifest, renderInstallManifest, type InstallManifest } from "../cli/install-manifest.js";
import { readBoundedRegular } from "./bounded-file.js";

export const UninstallInventoryRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("inspect-uninstall"),
  invokingUid: z.number().int().positive(),
}).strict();

export interface InstalledManifestInventory {
  manifest: InstallManifest;
  manifestSha256: string;
  recovery?: "journal";
}
export interface AbsentInstallationInventory { absent: true }
export type InstallationInventory = InstalledManifestInventory | AbsentInstallationInventory;

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadInstalledManifest(
  path = "/var/lib/pi-together/install-manifest.json",
  expectedRoot = { uid: 0, gid: 0 },
): Promise<InstalledManifestInventory> {
  const { bytes, info } = await readBoundedRegular(path, 1024 * 1024, "installed ownership manifest is not a bounded stable regular file");
  if ((info.mode & 0o777) !== 0o644 || info.uid !== expectedRoot.uid || info.gid !== expectedRoot.gid) {
    throw new Error("installed ownership manifest has unsafe metadata");
  }
  const source = bytes.toString("utf8");
  const manifest = InstallManifestSchema.parse(JSON.parse(source));
  if (renderInstallManifest(manifest) !== source) throw new Error("installed ownership manifest is not canonical");
  return { manifest, manifestSha256: digest(bytes) };
}

export async function loadUninstallRecoveryManifest(
  version: string,
  path = "/var/lib/pi-together/uninstall-journal.json",
  expectedRoot = { uid: 0, gid: 0 },
): Promise<InstalledManifestInventory> {
  const { bytes, info } = await readBoundedRegular(path, 1024 * 1024, "uninstall recovery journal is not a bounded stable regular file");
  if ((info.mode & 0o777) !== 0o600 || info.uid !== expectedRoot.uid || info.gid !== expectedRoot.gid) {
    throw new Error("uninstall recovery journal has unsafe metadata");
  }
  const value = JSON.parse(bytes.toString("utf8")) as {
    schemaVersion?: unknown;
    manifestSha256?: unknown;
    manifest?: unknown;
  };
  if (![1, 2].includes(value.schemaVersion as number) || typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) {
    throw new Error("uninstall recovery journal is invalid");
  }
  let manifest: InstallManifest;
  if (value.schemaVersion === 2) {
    manifest = InstallManifestSchema.parse(value.manifest);
  } else {
    // Version-1 journals predate embedded inventory. The local inventory is fully deterministic,
    // and the root-owned journal digest independently proves whether this exact candidate matches.
    manifest = buildInstallManifest("local", version);
  }
  const canonical = renderInstallManifest(manifest);
  if (digest(canonical) !== value.manifestSha256) throw new Error("uninstall recovery journal cannot reconstruct the exact inventory");
  return { manifest, manifestSha256: value.manifestSha256, recovery: "journal" };
}

export async function canonicalInstallationIsAbsent(root = "/"): Promise<boolean> {
  const physical = (logical: string) => resolve(root, `.${logical}`);
  const fixedMarkers = [
    "/opt/pi-together/current", "/opt/pi-together/previous", "/opt/pi-together/helpers/oauth2-proxy",
    "/etc/systemd/system/pi-together.service", "/etc/systemd/system/pi-together-oauth2-proxy.service",
    "/etc/systemd/system/pi-together-edge.service", "/etc/systemd/system/pi-together-funnel.service",
    "/etc/pi-together/oauth2-proxy.cfg", "/etc/pi-together/oauth-client.secret", "/etc/pi-together/oauth-cookie.secret",
    "/etc/pi-together/nginx-funnel.conf", "/etc/nginx/sites-available/pi-together.conf",
    "/etc/nginx/sites-enabled/pi-together.conf", "/etc/letsencrypt/renewal-hooks/deploy/pi-together",
    "/var/lib/pi-together/policy-journal.json", "/var/lib/pi-together/user-management-journal.json",
    "/var/lib/pi-together/share-journal.json", "/var/lib/pi-together/upgrade-journal.json",
  ];
  for (const marker of fixedMarkers) {
    try { await lstat(physical(marker)); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const [logical, ownedName] of [["/opt/pi-together/releases", () => true], ["/var/lib/pi-together/downloads", (name: string) => name.startsWith("oauth2-proxy-")]] as const) {
    let names: string[];
    try { names = await readdir(physical(logical)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (names.length > 10_000) throw new Error("managed installation marker directory is unexpectedly large");
    if (names.some((name) => ownedName(name))) return false;
  }
  return true;
}

export async function loadInstalledOrRecoveryManifest(
  version: string,
  manifestPath = "/var/lib/pi-together/install-manifest.json",
  journalPath = "/var/lib/pi-together/uninstall-journal.json",
  expectedRoot = { uid: 0, gid: 0 },
): Promise<InstallationInventory> {
  try {
    return await loadInstalledManifest(manifestPath, expectedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { return await loadUninstallRecoveryManifest(version, journalPath, expectedRoot); }
    catch (recoveryError) {
      if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
      if (manifestPath === "/var/lib/pi-together/install-manifest.json" && journalPath === "/var/lib/pi-together/uninstall-journal.json") {
        if (await canonicalInstallationIsAbsent()) return { absent: true };
        throw new Error("installation inventory is absent but canonical managed integration markers remain; refusing inventory-free deletion");
      }
      throw recoveryError;
    }
  }
}
