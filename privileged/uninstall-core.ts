import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InstallManifestSchema, buildInstallManifest, packageVersionForRelease, type InstallManifest } from "../cli/install-manifest.js";

declare const __PI_TOGETHER_VERSION__: string;
const VERSION = typeof __PI_TOGETHER_VERSION__ === "string" ? __PI_TOGETHER_VERSION__ : "0.1.0";
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const RequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("uninstall"),
  invokingUid: z.number().int().positive(),
  manifest: z.unknown(),
  manifestSha256: SHA256,
  purgeConfig: z.boolean(),
}).strict();
export interface UninstallRequest {
  protocolVersion: 1;
  action: "uninstall";
  invokingUid: number;
  manifest: InstallManifest;
  manifestSha256: string;
  purgeConfig: boolean;
}
export interface UninstallOperation {
  id: string;
  kind: "disable-service" | "remove-file" | "remove-symlink" | "remove-release" | "reload-nginx" | "daemon-reload";
  target: string;
}
export interface ValidatedUninstall {
  request: UninstallRequest;
  operations: UninstallOperation[];
}
export interface UninstallIo {
  verifyManifest(validated: ValidatedUninstall): Promise<void>;
  recover(validated: ValidatedUninstall): Promise<Set<string>>;
  execute(operation: UninstallOperation, validated: ValidatedUninstall): Promise<void>;
  record(operationId: string, validated: ValidatedUninstall): Promise<void>;
  finish(validated: ValidatedUninstall): Promise<void>;
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalManifest(manifest: InstallManifest): string { return `${JSON.stringify(manifest, null, 2)}\n`; }
function fixedEqual(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function archivePath(manifest: InstallManifest): string | undefined {
  return manifest.entries.find((entry) => entry.path.startsWith("/var/lib/pi-together/downloads/oauth2-proxy-v"))?.path;
}
function previousVersion(manifest: InstallManifest): string | undefined {
  const releases = manifest.entries.filter((entry) => entry.kind === "directory" && entry.path.startsWith("/opt/pi-together/releases/")).map((entry) => entry.path.split("/").at(-1)!);
  return releases.find((version) => version !== manifest.version);
}
function operationsFor(manifest: InstallManifest, purgeConfig: boolean): UninstallOperation[] {
  const operations: UninstallOperation[] = [];
  if (manifest.mode === "tailscale-funnel") {
    operations.push({ id: "stop-funnel", kind: "disable-service", target: "pi-together-funnel.service" });
    operations.push({ id: "stop-edge", kind: "disable-service", target: "pi-together-edge.service" });
  }
  if (manifest.mode !== "local") operations.push({ id: "stop-oauth", kind: "disable-service", target: "pi-together-oauth2-proxy.service" });
  operations.push({ id: "stop-app", kind: "disable-service", target: "pi-together.service" });
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const add = (id: string, path: string, kind?: UninstallOperation["kind"]) => {
    const entry = byPath.get(path);
    if (!entry || entry.uninstall !== "remove") throw new Error(`required uninstall inventory is missing: ${path}`);
    operations.push({ id, kind: kind ?? (entry.kind === "symlink" ? "remove-symlink" : entry.kind === "directory" ? "remove-release" : "remove-file"), target: path });
  };
  if (manifest.mode !== "local") {
    if (manifest.mode === "reverse-proxy") {
      add("remove-nginx-enable", "/etc/nginx/sites-enabled/pi-together.conf");
      add("remove-nginx-site", "/etc/nginx/sites-available/pi-together.conf");
      operations.push({ id: "reload-nginx", kind: "reload-nginx", target: "nginx.service" });
      add("remove-renewal-hook", "/etc/letsencrypt/renewal-hooks/deploy/pi-together");
    } else {
      add("remove-share-journal", "/var/lib/pi-together/share-journal.json");
      add("remove-funnel-service", "/etc/systemd/system/pi-together-funnel.service");
      add("remove-edge-service", "/etc/systemd/system/pi-together-edge.service");
      add("remove-funnel-edge-config", "/etc/pi-together/nginx-funnel.conf");
    }
    add("remove-oauth-service", "/etc/systemd/system/pi-together-oauth2-proxy.service");
    add("remove-user-management-journal", "/var/lib/pi-together/user-management-journal.json");
    add("remove-oauth-config", "/etc/pi-together/oauth2-proxy.cfg");
    add("remove-oauth-client-secret", "/etc/pi-together/oauth-client.secret");
    add("remove-oauth-cookie-secret", "/etc/pi-together/oauth-cookie.secret");
    add("remove-oauth-helper", "/opt/pi-together/helpers/oauth2-proxy");
    add("remove-oauth-archive", archivePath(manifest)!);
  }
  add("remove-app-service", "/etc/systemd/system/pi-together.service");
  operations.push({ id: "daemon-reload", kind: "daemon-reload", target: "systemd" });
  add("remove-current", "/opt/pi-together/current");
  const previous = previousVersion(manifest);
  if (previous) add("remove-previous", "/opt/pi-together/previous");
  add("remove-release", `/opt/pi-together/releases/${manifest.version}`);
  if (previous) add("remove-previous-release", `/opt/pi-together/releases/${previous}`);
  add("remove-policy-journal", "/var/lib/pi-together/policy-journal.json");
  if (purgeConfig) operations.push({ id: "purge-config", kind: "remove-file", target: "/etc/pi-together/config.json" });
  return operations;
}
export function validateUninstallRequest(value: unknown): ValidatedUninstall {
  const parsed = RequestSchema.parse(value);
  const manifest = InstallManifestSchema.parse(parsed.manifest);
  const bytes = canonicalManifest(manifest);
  if (!fixedEqual(sha256(bytes), parsed.manifestSha256)) throw new Error("uninstall manifest digest mismatch");
  if (packageVersionForRelease(manifest.version) !== VERSION) throw new Error("uninstall helper version does not match the installation");
  const previous = previousVersion(manifest);
  if (!!previous !== manifest.entries.some((entry) => entry.path === "/opt/pi-together/previous")) throw new Error("installation rollback inventory is incomplete");
  const expected = buildInstallManifest(manifest.mode, manifest.version, archivePath(manifest), previous);
  if (canonicalManifest(expected) !== bytes) throw new Error("installation inventory is not canonical");
  const request: UninstallRequest = { ...parsed, manifest };
  return { request, operations: operationsFor(manifest, parsed.purgeConfig) };
}
export async function uninstallValidated(value: unknown, io: UninstallIo): Promise<void> {
  const validated = validateUninstallRequest(value);
  await io.verifyManifest(validated);
  const completed = await io.recover(validated);
  for (const operation of validated.operations) {
    if (completed.has(operation.id)) continue;
    await io.execute(operation, validated);
    await io.record(operation.id, validated);
  }
  await io.finish(validated);
}
