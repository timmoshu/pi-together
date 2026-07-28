import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OAUTH2_PROXY_RELEASE, renderDeploymentTemplates, renderNginxChallengeSite, renderNginxFunnelEdge } from "../deployment/templates.js";
import { renderAppService, renderFunnelEdgeService, renderFunnelService, renderOauth2ProxyService, renderRenewalHook } from "../deployment/service-templates.js";
import { buildInstallManifest, renderInstallManifest } from "./install-manifest.js";
import { resolveGitHubLogin, type GitHubPrincipalMapping } from "../server/github-principals.js";
import type { DiscoveryReport } from "./discovery.js";
import type { SetupAnswers } from "./setup-answers.js";
import { isLocalListenerPort } from "../shared/local-listener.js";
import { AppConfigSchema } from "../server/config.js";
import { inspectInstalledCertificate } from "./certificate-inventory.js";
import type { CertificateInspection } from "../shared/certificate-protocol.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const AbsolutePath = z.string().regex(/^\/[A-Za-z0-9._+@/-]+$/)
  .refine((path) => path !== "/" && !path.endsWith("/") && !path.includes("//") && path.split("/").every((part) => part !== "." && part !== ".."));
const Mode = z.string().regex(/^0[0-7]{3}$/);
const Account = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);
const Domain = z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const PosixMetadata = { mode: z.number().int().min(0).max(0o7777), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() };
const FileStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("file"), sha256: SHA256, ...PosixMetadata }).strict(),
  z.object({ kind: z.literal("directory"), ...PosixMetadata }).strict(),
  z.object({ kind: z.literal("symlink"), target: z.string().min(1).max(4096), uid: PosixMetadata.uid, gid: PosixMetadata.gid }).strict(),
  z.object({ kind: z.literal("other") }).strict(),
]);
export type FileState = z.infer<typeof FileStateSchema>;

const RollbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove-created") }).strict(),
  z.object({ kind: z.literal("restore-backup"), backupPath: AbsolutePath, sourceSha256: SHA256 }).strict(),
  z.object({ kind: z.literal("service-action"), action: z.enum(["stop", "disable", "disable-stop", "reload", "none"]) }).strict(),
  z.object({ kind: z.literal("delete-certificate"), domain: Domain }).strict(),
  z.object({ kind: z.literal("remove-installed-packages"), packages: z.array(z.enum(["nginx", "certbot"])).min(1) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
const Common = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  target: AbsolutePath,
  rollback: RollbackSchema,
};
export const SetupOperationSchema = z.discriminatedUnion("kind", [
  z.object({ ...Common, kind: z.literal("ensure-directory"), mode: Mode, owner: Account, group: Account }).strict(),
  z.object({ ...Common, kind: z.literal("install-apt"), packages: z.array(z.enum(["nginx", "certbot"])).min(1) }).strict(),
  z.object({ ...Common, kind: z.literal("copy-release"), version: Version, manifestSha256: SHA256 }).strict(),
  z.object({ ...Common, kind: z.literal("download"), url: z.string().url(), expectedSha256: SHA256, mode: Mode }).strict(),
  z.object({ ...Common, kind: z.literal("extract-oauth2-proxy"), archive: AbsolutePath, archiveSha256: SHA256, mode: z.literal("0755") }).strict(),
  z.object({ ...Common, kind: z.literal("write-file"), mode: Mode, owner: Account, group: Account, contentTemplate: z.string(), secretIds: z.array(z.enum(["proxy-secret"])), expectedTemplateSha256: SHA256 }).strict(),
  z.object({ ...Common, kind: z.literal("write-secret-file"), mode: z.literal("0600"), owner: Account, group: Account, secretId: z.enum(["oauth-client-secret", "oauth-cookie-secret"]), source: z.enum(["answer", "generated-at-apply"]), expectedSha256: SHA256.optional() }).strict(),
  z.object({ ...Common, kind: z.literal("symlink"), linkTarget: AbsolutePath }).strict(),
  z.object({ ...Common, kind: z.literal("certificate"), domain: Domain, email: z.string().email(), webroot: AbsolutePath }).strict(),
  z.object({ ...Common, kind: z.literal("reuse-certificate"), domain: Domain }).strict(),
  z.object({ ...Common, kind: z.literal("service"), unit: z.enum(["pi-together.service", "pi-together-oauth2-proxy.service", "pi-together-edge.service", "pi-together-funnel.service", "nginx.service", "certbot.timer"]), action: z.enum(["start", "enable", "enable-start", "reload"])}).strict(),
]);
export type SetupOperation = z.infer<typeof SetupOperationSchema>;
type WithoutRollback<T> = T extends unknown ? Omit<T, "rollback"> : never;
type SetupOperationInput = WithoutRollback<SetupOperation>;

const PreconditionSchema = z.object({ path: AbsolutePath, expected: FileStateSchema }).strict();
const SecretInputSchema = z.object({
  id: z.enum(["proxy-secret", "oauth-client-secret", "oauth-cookie-secret"]),
  source: z.enum(["answer", "generated-at-apply"]),
  encoding: z.enum(["utf8", "base64url"]),
  bytes: z.number().int().min(16).max(4096),
  expectedSha256: SHA256.optional(),
}).strict();
const PlanCoreBaseSchema = z.object({
  schemaVersion: z.literal(1),
  producer: z.object({ name: z.literal("pi-together"), version: Version }).strict(),
  mode: z.enum(["local", "reverse-proxy", "tailscale-funnel"]),
  platform: z.literal("linux"),
  distro: z.object({ id: z.enum(["debian", "ubuntu"]), version: z.enum(["12", "22.04", "24.04"]) }).strict(),
  arch: z.enum(["x64", "arm64"]),
  observedAt: z.string().datetime(),
  invokingUser: z.object({ uid: z.number().int().positive(), username: Account, group: Account }).strict(),
  secretInputs: z.array(SecretInputSchema),
  preconditions: z.array(PreconditionSchema),
  operations: z.array(SetupOperationSchema),
}).strict();
function validatePlanCore(plan: z.infer<typeof PlanCoreBaseSchema>, context: z.RefinementCtx): void {
  const declaredSecrets = new Set(plan.secretInputs.map((secret) => secret.id));
  const expectedSecrets = plan.mode === "local" ? [] : ["proxy-secret", "oauth-client-secret", "oauth-cookie-secret"];
  if (JSON.stringify([...declaredSecrets].sort()) !== JSON.stringify(expectedSecrets.sort())) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["secretInputs"], message: "secret declarations do not match mode" });
  }
  const ids = new Set<string>();
  for (const [index, operation] of plan.operations.entries()) {
    if (ids.has(operation.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "id"], message: "duplicate operation id" });
    ids.add(operation.id);
    if (operation.kind === "write-file") {
      const placeholders = [...operation.contentTemplate.matchAll(/\{\{secret:([a-z0-9-]+)\}\}/g)].map((match) => match[1]);
      if (operation.secretIds.length > 0 && operation.mode !== "0600") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "mode"], message: "secret-bearing templates require mode 0600" });
      }
      if (operation.secretIds.some((id) => !declaredSecrets.has(id)) || JSON.stringify([...new Set(placeholders)]) !== JSON.stringify(operation.secretIds)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "secretIds"], message: "secret placeholders do not match declarations" });
      }
    }
    if (operation.kind === "write-secret-file" && !declaredSecrets.has(operation.secretId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["operations", index, "secretId"], message: "secret file uses an undeclared secret" });
    }
  }
}
const PlanCoreSchema = PlanCoreBaseSchema.superRefine(validatePlanCore);
export const SetupPlanSchema = PlanCoreBaseSchema.extend({ planDigest: SHA256 }).strict().superRefine((plan, context) => {
  const { planDigest: _digest, ...core } = plan;
  validatePlanCore(core, context);
  if (sha256(canonical(core)) !== plan.planDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["planDigest"], message: "plan digest does not match content" });
  }
});
export type SetupPlan = z.infer<typeof SetupPlanSchema>;

export interface NginxInventoryEntry { path: string; state: FileState; contentPath: string; contentState: FileState; content: string }
const NginxInventoryEntrySchema = z.object({
  path: AbsolutePath,
  state: FileStateSchema,
  contentPath: AbsolutePath,
  contentState: FileStateSchema,
  content: z.string().max(1024 * 1024),
}).strict();
export interface PlanIo {
  inspect(path: string): Promise<FileState>;
  inspectExecutable?(path: string): Promise<FileState>;
  inspectCertificate?(domain: string): Promise<CertificateInspection>;
  existingConfigMode?(expectedSha256: string): Promise<"local" | "reverse-proxy" | "tailscale-funnel">;
  nginxInventory(): Promise<NginxInventoryEntry[]>;
  resolvePrincipal(login: string, observedAt: string): Promise<GitHubPrincipalMapping>;
  releaseManifest(): Promise<{ version: string; sha256: string }>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const MANAGED_FILE_LIMIT = 16 * 1024 * 1024;
export const RUNTIME_EXECUTABLE_LIMIT = 256 * 1024 * 1024;

async function hashHandle(handle: FileHandle, maximumBytes: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: maximumBytes })) hash.update(chunk);
  return hash.digest("hex");
}

async function inspect(path: string, maximumBytes = MANAGED_FILE_LIMIT): Promise<FileState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(path), uid: info.uid, gid: info.gid };
    if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
    if (!info.isFile()) return { kind: "other" };
    if (info.size > maximumBytes) throw new Error(`managed file is too large to inventory: ${path}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maximumBytes) {
        throw new Error(`managed file changed during inventory: ${path}`);
      }
      const digest = await hashHandle(handle, maximumBytes);
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw new Error(`managed file changed during inventory: ${path}`);
      }
      return { kind: "file", sha256: digest, mode: after.mode & 0o7777, uid: after.uid, gid: after.gid };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

async function nginxInventory(): Promise<NginxInventoryEntry[]> {
  let names: string[];
  try {
    names = (await readdir("/etc/nginx/sites-enabled")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("unable to inventory existing nginx sites");
  }
  if (names.length > 256) throw new Error("too many enabled nginx sites to inventory safely");
  const entries: NginxInventoryEntry[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("unsafe nginx inventory entry name");
    const path = join("/etc/nginx/sites-enabled", name);
    const contentPath = await realpath(path);
    const content = await readFile(contentPath, "utf8");
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error(`nginx site is too large to inventory: ${path}`);
    entries.push({ path, state: await inspect(path), contentPath, contentState: await inspect(contentPath), content });
  }
  return entries;
}

export const nodePlanIo: PlanIo = {
  inspect,
  inspectExecutable: (path) => inspect(path, RUNTIME_EXECUTABLE_LIMIT),
  inspectCertificate: (domain) => inspectInstalledCertificate(domain),
  existingConfigMode: async (expectedSha256) => {
    const handle = await open("/etc/pi-together/config.json", constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024) throw new Error("preserved app config is not a bounded regular file");
      const bytes = await handle.readFile();
      if (sha256(bytes) !== expectedSha256) throw new Error("preserved app config changed during planning");
      return AppConfigSchema.parse(JSON.parse(bytes.toString("utf8"))).mode;
    } finally { await handle.close(); }
  },
  nginxInventory,
  resolvePrincipal: async (login, observedAt) => (await resolveGitHubLogin(login, { now: () => new Date(observedAt) })).mapping,
  releaseManifest: async () => {
    const data = await readFile(new URL("../release/manifest.json", import.meta.url));
    const parsed = z.object({ schemaVersion: z.literal(1), package: z.object({ name: z.literal("pi-together"), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }) }).passthrough().parse(JSON.parse(data.toString("utf8")));
    return { version: parsed.package.version, sha256: sha256(data) };
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function backupFor(path: string, sourceSha256: string): string {
  return `/var/lib/pi-together/backups/setup/${sha256(path).slice(0, 16)}-${sourceSha256.slice(0, 16)}`;
}

function rollbackFor(path: string, state: FileState): z.infer<typeof RollbackSchema> {
  return state.kind === "file"
    ? { kind: "restore-backup", backupPath: backupFor(path, state.sha256), sourceSha256: state.sha256 }
    : state.kind === "absent" ? { kind: "remove-created" } : { kind: "none" };
}

function assertInventorySafe(entries: NginxInventoryEntry[], domain: string): NginxInventoryEntry[] {
  const validated = entries.map((entry) => {
    const parsed = NginxInventoryEntrySchema.parse(entry);
    if (parsed.contentState.kind !== "file" || sha256(parsed.content) !== parsed.contentState.sha256) throw new Error("nginx inventory content hash mismatch");
    return parsed;
  });
  const owned = new Set(["/etc/nginx/sites-enabled/pi-together.conf", "/etc/nginx/sites-available/pi-together.conf"]);
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const domainPattern = new RegExp(`(^|\\s)server_name\\s+[^;]*\\b${escaped}\\b[^;]*;`, "m");
  for (const entry of validated) {
    if (!owned.has(entry.path) && domainPattern.test(entry.content)) {
      throw new Error(`nginx domain collision in ${entry.path}`);
    }
    if (!owned.has(entry.path) && entry.content.includes("/run/pi-together/app.sock")) {
      throw new Error(`nginx listener collision in ${entry.path}`);
    }
  }
  return validated;
}

export async function buildSetupPlan(
  answers: SetupAnswers,
  discovery: DiscoveryReport,
  io: PlanIo = nodePlanIo,
): Promise<SetupPlan> {
  if (!discovery.safeToPlan) throw new Error("host discovery failed; refusing to build an operation plan");
  if (discovery.facts.existingInstall) throw new Error("an existing Pi Together installation requires the upgrade command");
  if (!discovery.facts.piPath) throw new Error("Pi path is unavailable in discovery facts");
  if (answers.mode === "tailscale-funnel" && discovery.facts.arch !== "x64") throw new Error("Tailscale Funnel is supported only on amd64");

  const plannedRoots = answers.sharedRepositoryFolders.map((root) => {
    const canonicalRoot = discovery.facts.sharedRepositoryFolders[root];
    if (!canonicalRoot) throw new Error(`workspace root is missing from discovery facts: ${root}`);
    return canonicalRoot;
  });
  const workspaceStates = await Promise.all(plannedRoots.map(async (path) => ({ path, state: FileStateSchema.parse(await io.inspect(path)) })));
  if (workspaceStates.some(({ state }) => state.kind !== "directory")) throw new Error("canonical workspace roots must remain existing directories");
  const release = await io.releaseManifest();
  const inspectExecutable = io.inspectExecutable ?? io.inspect;
  const nodeState = FileStateSchema.parse(await inspectExecutable(discovery.facts.node.path));
  const piState = FileStateSchema.parse(await inspectExecutable(discovery.facts.piPath));
  if (nodeState.kind !== "file" || piState.kind !== "file") throw new Error("Node and Pi executables must be regular files");
  const tailscaleState = answers.mode === "tailscale-funnel" ? FileStateSchema.parse(await inspectExecutable("/usr/bin/tailscale")) : undefined;
  if (tailscaleState && (tailscaleState.kind !== "file" || tailscaleState.uid !== 0 || (tailscaleState.mode & 0o022) !== 0)) throw new Error("Tailscale executable metadata is unsafe");
  const operations: SetupOperation[] = [];
  const preconditions: Array<{ path: string; expected: FileState }> = [
    { path: discovery.facts.node.path, expected: nodeState },
    { path: discovery.facts.piPath, expected: piState },
    ...(tailscaleState ? [{ path: "/usr/bin/tailscale", expected: tailscaleState }] : []),
    ...workspaceStates.map(({ path, state }) => ({ path, expected: state })),
  ];
  const states = new Map<string, FileState>();
  states.set("/etc/pi-together/config.json", FileStateSchema.parse(await io.inspect("/etc/pi-together/config.json")));
  const preservedConfig = states.get("/etc/pi-together/config.json");
  const preservedMode = preservedConfig?.kind === "file"
    ? await (io.existingConfigMode?.(preservedConfig.sha256) ?? Promise.resolve(answers.mode))
    : undefined;
  const stateFor = async (path: string) => {
    if (states.has(path)) return states.get(path)!;
    const stateRoot = states.get("/var/lib/pi-together");
    if ([
      "/var/lib/pi-together/backups",
      "/var/lib/pi-together/backups/setup",
      "/var/lib/pi-together/downloads",
      "/var/lib/pi-together/acme",
    ].includes(path)) {
      if (stateRoot?.kind === "absent") {
        states.set(path, { kind: "absent" });
        return states.get(path)!;
      }
      if (stateRoot?.kind !== "directory" || stateRoot.mode !== 0o750 || stateRoot.uid !== 0 || stateRoot.gid !== 0) {
        throw new Error("protected state directory does not have canonical metadata");
      }
      const preservedInstall = preservedMode !== undefined;
      const preparedFunnelDirectory = path === "/var/lib/pi-together/downloads" && !preservedInstall;
      const preservedDirectory = preservedInstall && (path.startsWith("/var/lib/pi-together/backups")
        || (path === "/var/lib/pi-together/downloads" && preservedMode !== "local")
        || (path === "/var/lib/pi-together/acme" && preservedMode === "reverse-proxy"));
      states.set(path, preparedFunnelDirectory || preservedDirectory
        ? { kind: "directory", mode: path === "/var/lib/pi-together/acme" ? 0o755 : 0o700, uid: 0, gid: 0 }
        : { kind: "absent" });
      return states.get(path)!;
    }
    if (path.startsWith("/var/lib/pi-together/downloads/oauth2-proxy-") && !discovery.facts.existingInstall) {
      states.set(path, { kind: "absent" });
      return states.get(path)!;
    }
    if (path === "/var/lib/pi-together/install-manifest.json"
      && states.get("/opt/pi-together/current")?.kind === "absent"
      && states.get("/etc/systemd/system/pi-together.service")?.kind === "absent") {
      // Both accessible markers are created before the manifest. The root helper independently
      // requires and rechecks an absent manifest before any installation mutation.
      states.set(path, { kind: "absent" });
      return states.get(path)!;
    }
    try {
      states.set(path, FileStateSchema.parse(await io.inspect(path)));
    } catch (error) {
      const recoverableProtectedTarget = [
        "/etc/pi-together/oauth-client.secret",
        "/etc/pi-together/oauth-cookie.secret",
        "/etc/pi-together/nginx-funnel.conf",
      ].includes(path) || (answers.mode === "reverse-proxy"
        && path.startsWith(`/etc/letsencrypt/live/${answers.domain}/`));
      if ((error as NodeJS.ErrnoException).code !== "EACCES" || discovery.facts.existingInstall || !recoverableProtectedTarget) throw error;
      // The privileged helper rolls back any interrupted apply before it independently rechecks this
      // exact absent precondition. Existing root-owned content without a valid journal therefore fails
      // closed before mutation rather than being read or overwritten by unprivileged planning.
      states.set(path, { kind: "absent" });
    }
    return states.get(path)!;
  };
  const addTarget = async (operation: SetupOperationInput) => {
    const state = await stateFor(operation.target);
    if ((state.kind === "symlink" && operation.kind !== "reuse-certificate") || state.kind === "other") throw new Error(`unsafe existing target type: ${operation.target}`);
    if (operation.kind === "ensure-directory" && state.kind !== "absent" && state.kind !== "directory") {
      throw new Error(`directory target has the wrong existing type: ${operation.target}`);
    }
    if (operation.kind === "copy-release" && state.kind !== "absent") {
      throw new Error(`immutable release destination already exists: ${operation.target}`);
    }
    if (["write-file", "write-secret-file", "download", "extract-oauth2-proxy", "symlink"].includes(operation.kind) && state.kind === "directory") {
      throw new Error(`file target is an existing directory: ${operation.target}`);
    }
    preconditions.push({ path: operation.target, expected: state });
    const rollback = operation.kind === "service"
      ? { kind: "service-action" as const, action: operation.action === "enable-start" ? "disable-stop" as const : operation.action === "enable" ? "disable" as const : operation.action === "start" ? "stop" as const : operation.action === "reload" ? "reload" as const : "none" as const }
      : operation.kind === "certificate" ? { kind: "delete-certificate" as const, domain: operation.domain }
      : operation.kind === "install-apt" ? { kind: "remove-installed-packages" as const, packages: operation.packages }
      : rollbackFor(operation.target, state);
    operations.push(SetupOperationSchema.parse({ ...operation, rollback }));
  };
  const write = async (id: string, target: string, contentTemplate: string, mode: string, owner: string, group: string) =>
    addTarget({ id, kind: "write-file", target, mode, owner, group, contentTemplate, secretIds: contentTemplate.includes("{{secret:proxy-secret}}") ? ["proxy-secret"] : [], expectedTemplateSha256: sha256(contentTemplate) } as SetupOperationInput);

  for (const [id, target, mode, owner, group] of [
    ["config-directory", "/etc/pi-together", "0750", "root", discovery.facts.user.group],
    ["runtime-directory", "/run/pi-together", "0750", discovery.facts.user.username, discovery.facts.user.group],
    ["state-directory", "/var/lib/pi-together", "0750", "root", "root"],
    ["install-directory", "/opt/pi-together", "0755", "root", "root"],
    ["release-directory", "/opt/pi-together/releases", "0755", "root", "root"],
    ["backup-root-directory", "/var/lib/pi-together/backups", "0700", "root", "root"],
    ["backup-directory", "/var/lib/pi-together/backups/setup", "0700", "root", "root"],
  ] as const) await addTarget({ id, kind: "ensure-directory", target, mode, owner, group } as SetupOperationInput);

  await addTarget({ id: "release", kind: "copy-release", target: `/opt/pi-together/releases/${release.version}`, version: release.version, manifestSha256: release.sha256 } as SetupOperationInput);
  await addTarget({ id: "current-release", kind: "symlink", target: "/opt/pi-together/current", linkTarget: `/opt/pi-together/releases/${release.version}` } as SetupOperationInput);

  let appConfig: string;
  let installedOauthArchive: string | undefined;
  if (answers.mode === "local") {
    if (discovery.facts.localPort === undefined || !isLocalListenerPort(discovery.facts.localPort)) {
      throw new Error("discovery did not select an allowed available local port");
    }
    appConfig = `${JSON.stringify({ version: 2, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: discovery.facts.localPort }, sharedRepositoryFolders: plannedRoots }, null, 2)}\n`;
  } else {
    if (answers.mode === "tailscale-funnel") {
      const principals = await Promise.all(answers.githubLogins.map(async (login) => {
        const mapping = await io.resolvePrincipal(login, discovery.facts.observedAt);
        if (mapping.login !== login || mapping.provider !== "github" || mapping.verification !== "verified" || !/^[1-9]\d*$/.test(mapping.subject)) throw new Error(`GitHub principal verification failed for ${login}`);
        return { provider: "github" as const, subject: mapping.subject, login, verifiedAt: discovery.facts.observedAt, verification: "verified" as const };
      }));
      appConfig = `${JSON.stringify({
        version: 2, mode: "tailscale-funnel", listener: { kind: "unix", path: "/run/pi-together/app.sock" },
        publicOrigin: `https://${answers.tailscaleDnsName}`, tailscaleDnsName: answers.tailscaleDnsName,
        proxySecret: "{{secret:proxy-secret}}", principals, sharedRepositoryFolders: plannedRoots,
      }, null, 2)}\n`;
      const appSecretPlaceholder = "PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______";
      const deploymentInput = {
        domain: answers.tailscaleDnsName, listener: { kind: "unix" as const, path: "/run/pi-together/app.sock" },
        oauth2ProxyPort: 4180, proxySecret: appSecretPlaceholder, githubLogins: answers.githubLogins,
        oauthClientId: answers.oauthClientId,
        oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
        cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
        tlsCertificate: "/unused/funnel/fullchain.pem", tlsCertificateKey: "/unused/funnel/privkey.pem", acmeWebroot: "/unused/funnel/acme",
      };
      for (const [id, target, mode, owner, group] of [
        ["oauth-helper-directory", "/opt/pi-together/helpers", "0755", "root", "root"],
        ["download-directory", "/var/lib/pi-together/downloads", "0700", "root", "root"],
      ] as const) await addTarget({ id, kind: "ensure-directory", target, mode, owner, group } as SetupOperationInput);
      if (!discovery.facts.nginxPath) await addTarget({ id: "apt-funnel-edge", kind: "install-apt", target: "/usr/bin/apt-get", packages: ["nginx"] } as SetupOperationInput);
      const asset = OAUTH2_PROXY_RELEASE.assets[discovery.facts.arch === "x64" ? "linux-x64" : "linux-arm64"];
      const oauthArchive = `/var/lib/pi-together/downloads/${asset.archive}`;
      installedOauthArchive = oauthArchive;
      await addTarget({ id: "oauth2-proxy-archive", kind: "download", target: oauthArchive, url: `${OAUTH2_PROXY_RELEASE.baseUrl}/${asset.archive}`, expectedSha256: asset.sha256, mode: "0600" } as SetupOperationInput);
      await addTarget({ id: "oauth2-proxy", kind: "extract-oauth2-proxy", target: "/opt/pi-together/helpers/oauth2-proxy", archive: oauthArchive, archiveSha256: asset.sha256, mode: "0755" } as SetupOperationInput);
      await addTarget({ id: "oauth-client-secret", kind: "write-secret-file", target: "/etc/pi-together/oauth-client.secret", mode: "0600", owner: "root", group: "root", secretId: "oauth-client-secret", source: "answer", expectedSha256: sha256(answers.oauthClientSecret) } as SetupOperationInput);
      await addTarget({ id: "oauth-cookie-secret", kind: "write-secret-file", target: "/etc/pi-together/oauth-cookie.secret", mode: "0600", owner: "root", group: "root", secretId: "oauth-cookie-secret", source: "generated-at-apply" } as SetupOperationInput);
      await write("oauth-config", "/etc/pi-together/oauth2-proxy.cfg", renderDeploymentTemplates(deploymentInput).oauth2ProxyConfig, "0644", "root", "root");
      await write("funnel-edge-config", "/etc/pi-together/nginx-funnel.conf", renderNginxFunnelEdge(deploymentInput, { serviceUser: discovery.facts.user.username }).replaceAll(appSecretPlaceholder, "{{secret:proxy-secret}}"), "0600", "root", "root");
      await write("oauth-service", "/etc/systemd/system/pi-together-oauth2-proxy.service", renderOauth2ProxyService(), "0644", "root", "root");
      await write("funnel-edge-service", "/etc/systemd/system/pi-together-edge.service", renderFunnelEdgeService(), "0644", "root", "root");
      await write("funnel-service", "/etc/systemd/system/pi-together-funnel.service", renderFunnelService(), "0644", "root", "root");
    } else {
    const inventory = assertInventorySafe(await io.nginxInventory(), answers.domain);
    for (const entry of inventory) {
      preconditions.push({ path: entry.path, expected: entry.state });
      if (entry.contentPath !== entry.path) preconditions.push({ path: entry.contentPath, expected: entry.contentState });
    }
    if (discovery.facts.occupiedPorts.length && !discovery.facts.nginxPath) {
      throw new Error(`ports required for nginx are occupied: ${discovery.facts.occupiedPorts.join(", ")}`);
    }
    const principals = await Promise.all(answers.githubLogins.map(async (login) => {
      const mapping = await io.resolvePrincipal(login, discovery.facts.observedAt);
      if (mapping.login !== login || mapping.provider !== "github" || mapping.verification !== "verified" || !/^[1-9]\d*$/.test(mapping.subject)) {
        throw new Error(`GitHub principal verification failed for ${login}`);
      }
      return { provider: "github" as const, subject: mapping.subject, login, verifiedAt: discovery.facts.observedAt, verification: "verified" as const };
    }));
    const appSecretPlaceholder = "PI_TOGETHER_PROXY_SECRET_PLACEHOLDER_______";
    appConfig = `${JSON.stringify({
      version: 2,
      mode: "reverse-proxy",
      listener: { kind: "unix", path: "/run/pi-together/app.sock" },
      publicOrigin: `https://${answers.domain}`,
      proxySecret: "{{secret:proxy-secret}}",
      principals: principals.map(({ provider, subject, login, verifiedAt, verification }) => ({ provider, subject, login, verifiedAt, verification })),
      sharedRepositoryFolders: plannedRoots,
    }, null, 2)}\n`;
    const deployment = renderDeploymentTemplates({
      domain: answers.domain,
      listener: { kind: "unix", path: "/run/pi-together/app.sock" },
      oauth2ProxyPort: 4180,
      proxySecret: appSecretPlaceholder,
      githubLogins: answers.githubLogins,
      oauthClientId: answers.oauthClientId,
      oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
      cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
      tlsCertificate: `/etc/letsencrypt/live/${answers.domain}/fullchain.pem`,
      tlsCertificateKey: `/etc/letsencrypt/live/${answers.domain}/privkey.pem`,
      acmeWebroot: "/var/lib/pi-together/acme",
    });
    const nginxTemplate = deployment.nginxSite.replaceAll(appSecretPlaceholder, "{{secret:proxy-secret}}");
    for (const [id, target, mode, owner, group] of [
      ["acme-directory", "/var/lib/pi-together/acme", "0755", "root", "root"],
      ["oauth-helper-directory", "/opt/pi-together/helpers", "0755", "root", "root"],
      ["download-directory", "/var/lib/pi-together/downloads", "0700", "root", "root"],
    ] as const) await addTarget({ id, kind: "ensure-directory", target, mode, owner, group } as SetupOperationInput);
    await addTarget({ id: "apt-web-stack", kind: "install-apt", target: "/usr/bin/apt-get", packages: discovery.facts.nginxPath ? ["certbot"] : ["nginx", "certbot"] } as SetupOperationInput);
    const asset = OAUTH2_PROXY_RELEASE.assets[discovery.facts.arch === "x64" ? "linux-x64" : "linux-arm64"];
    const oauthArchive = `/var/lib/pi-together/downloads/${asset.archive}`;
    installedOauthArchive = oauthArchive;
    await addTarget({ id: "oauth2-proxy-archive", kind: "download", target: oauthArchive, url: `${OAUTH2_PROXY_RELEASE.baseUrl}/${asset.archive}`, expectedSha256: asset.sha256, mode: "0600" } as SetupOperationInput);
    await addTarget({ id: "oauth2-proxy", kind: "extract-oauth2-proxy", target: "/opt/pi-together/helpers/oauth2-proxy", archive: oauthArchive, archiveSha256: asset.sha256, mode: "0755" } as SetupOperationInput);
    await addTarget({ id: "oauth-client-secret", kind: "write-secret-file", target: "/etc/pi-together/oauth-client.secret", mode: "0600", owner: "root", group: "root", secretId: "oauth-client-secret", source: "answer", expectedSha256: sha256(answers.oauthClientSecret) } as SetupOperationInput);
    await addTarget({ id: "oauth-cookie-secret", kind: "write-secret-file", target: "/etc/pi-together/oauth-cookie.secret", mode: "0600", owner: "root", group: "root", secretId: "oauth-cookie-secret", source: "generated-at-apply" } as SetupOperationInput);
    await write("oauth-config", "/etc/pi-together/oauth2-proxy.cfg", deployment.oauth2ProxyConfig, "0644", "root", "root");
    await write("nginx-challenge-site", "/etc/nginx/sites-available/pi-together.conf", renderNginxChallengeSite(answers.domain, "/var/lib/pi-together/acme"), "0644", "root", "root");
    await addTarget({ id: "nginx-enable", kind: "symlink", target: "/etc/nginx/sites-enabled/pi-together.conf", linkTarget: "/etc/nginx/sites-available/pi-together.conf" } as SetupOperationInput);
    await addTarget({ id: "nginx-challenge-action", kind: "service", target: discovery.facts.nginxPath ? "/lib/systemd/system/nginx.service" : "/usr/sbin/nginx", unit: "nginx.service", action: discovery.facts.nginxPath ? "reload" : "start" } as SetupOperationInput);
    const certificatePath = `/etc/letsencrypt/live/${answers.domain}/fullchain.pem`;
    const certificateKey = `/etc/letsencrypt/live/${answers.domain}/privkey.pem`;
    const certificateInspection = io.inspectCertificate ? await io.inspectCertificate(answers.domain) : undefined;
    if (certificateInspection?.status === "existing") {
      if (!answers.reuseExistingCertificate) throw new Error("an existing certificate lineage was found but reuse was not approved");
      states.set(certificatePath, FileStateSchema.parse(certificateInspection.fullchainState));
      await addTarget({ id: "certificate", kind: "reuse-certificate", target: certificatePath, domain: answers.domain } as SetupOperationInput);
    } else {
      if (certificateInspection?.status === "absent") {
        states.set(certificatePath, { kind: "absent" });
        states.set(certificateKey, { kind: "absent" });
      }
      const [certificateState, certificateKeyState] = await Promise.all([stateFor(certificatePath), stateFor(certificateKey)]);
      if (certificateState.kind !== "absent" || certificateKeyState.kind !== "absent") {
        throw new Error("an existing certificate lineage requires explicit approved reuse");
      }
      preconditions.push({ path: certificateKey, expected: certificateKeyState });
      await addTarget({ id: "certificate", kind: "certificate", target: certificatePath, domain: answers.domain, email: answers.certificateEmail, webroot: "/var/lib/pi-together/acme" } as SetupOperationInput);
    }
    await write("nginx-final-site", "/etc/nginx/sites-available/pi-together.conf", nginxTemplate, "0600", "root", "root");
    await addTarget({ id: "nginx-final-reload", kind: "service", target: "/lib/systemd/system/nginx.service", unit: "nginx.service", action: "reload" } as SetupOperationInput);
    await write("oauth-service", "/etc/systemd/system/pi-together-oauth2-proxy.service", renderOauth2ProxyService(), "0644", "root", "root");
    await write("renewal-hook", "/etc/letsencrypt/renewal-hooks/deploy/pi-together", renderRenewalHook(), "0755", "root", "root");
    await addTarget({ id: "certbot-renewal-action", kind: "service", target: "/lib/systemd/system/certbot.timer", unit: "certbot.timer", action: "enable-start" } as SetupOperationInput);
    if (answers.startNow || answers.enableBootService) {
      const action = answers.startNow && answers.enableBootService ? "enable-start" : answers.startNow ? "start" : "enable";
      await addTarget({ id: "oauth-service-action", kind: "service", target: "/etc/systemd/system/pi-together-oauth2-proxy.service", unit: "pi-together-oauth2-proxy.service", action } as SetupOperationInput);
    }
    }
  }

  await write("app-config", "/etc/pi-together/config.json", appConfig, "0600", discovery.facts.user.username, discovery.facts.user.group);
  await write("app-service", "/etc/systemd/system/pi-together.service", renderAppService({ nodePath: discovery.facts.node.path, piPath: discovery.facts.piPath, serviceUser: discovery.facts.user.username, publicMode: answers.mode !== "local" }), "0644", "root", "root");
  await write("install-manifest", "/var/lib/pi-together/install-manifest.json", renderInstallManifest(buildInstallManifest(answers.mode, release.version, installedOauthArchive)), "0644", "root", "root");
  if (answers.startNow || answers.enableBootService) {
    const action = answers.startNow && answers.enableBootService ? "enable-start" : answers.startNow ? "start" : "enable";
    await addTarget({ id: "app-service-action", kind: "service", target: "/etc/systemd/system/pi-together.service", unit: "pi-together.service", action } as SetupOperationInput);
    if (answers.mode === "tailscale-funnel") {
      await addTarget({ id: "oauth-service-action", kind: "service", target: "/etc/systemd/system/pi-together-oauth2-proxy.service", unit: "pi-together-oauth2-proxy.service", action } as SetupOperationInput);
      await addTarget({ id: "funnel-edge-service-action", kind: "service", target: "/etc/systemd/system/pi-together-edge.service", unit: "pi-together-edge.service", action } as SetupOperationInput);
      await addTarget({ id: "funnel-service-action", kind: "service", target: "/etc/systemd/system/pi-together-funnel.service", unit: "pi-together-funnel.service", action } as SetupOperationInput);
    }
  }

  const uniquePreconditions = [...new Map(preconditions.map((item) => [item.path, item])).values()];
  const core = PlanCoreSchema.parse({
    schemaVersion: 1,
    producer: { name: "pi-together", version: release.version },
    mode: answers.mode,
    platform: discovery.facts.platform,
    distro: discovery.facts.distro,
    arch: discovery.facts.arch,
    observedAt: discovery.facts.observedAt,
    invokingUser: { uid: discovery.facts.user.uid, username: discovery.facts.user.username, group: discovery.facts.user.group },
    secretInputs: answers.mode !== "local" ? [
      { id: "proxy-secret", source: "generated-at-apply", encoding: "base64url", bytes: 32 },
      { id: "oauth-client-secret", source: "answer", encoding: "utf8", bytes: Buffer.byteLength(answers.oauthClientSecret), expectedSha256: sha256(answers.oauthClientSecret) },
      { id: "oauth-cookie-secret", source: "generated-at-apply", encoding: "base64url", bytes: 32 },
    ] : [],
    preconditions: uniquePreconditions,
    operations,
  });
  return SetupPlanSchema.parse({ ...core, planDigest: sha256(canonical(core)) });
}

export function renderSetupPlan(planValue: SetupPlan): string {
  const plan = SetupPlanSchema.parse(planValue);
  const lines = [
    `Plan ${plan.planDigest}`,
    `Target: ${plan.distro.id} ${plan.distro.version} ${plan.arch} (${plan.mode})`,
    `Preconditions: ${plan.preconditions.length}; operations: ${plan.operations.length}`,
    "",
  ];
  for (const operation of plan.operations) {
    const detail = operation.kind === "install-apt" ? ` [${operation.packages.join(", ")}]`
      : operation.kind === "certificate" ? ` [issue with ACME webroot for ${operation.domain}]`
        : operation.kind === "reuse-certificate" ? " [reuse privileged-validated exact-domain lineage]"
      : operation.kind === "write-secret-file" ? ` [${operation.source}; content redacted]`
      : "";
    lines.push(`${operation.id}: ${operation.kind} ${operation.target}${detail}`);
  }
  lines.push("", "No commands have been run and no files, packages, services, or certificates have been changed.");
  return lines.join("\n");
}
