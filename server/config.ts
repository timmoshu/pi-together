import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalizeGitHubLogin, isGitHubSubject, type GitHubPrincipalMapping } from "./github-principals.js";
import type { GitHubPrincipal, SecurityConfig } from "./security.js";
import { canonicalSharedFolders } from "./workspace-policy.js";

const TcpListenerSchema = z.object({
  kind: z.literal("tcp"),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1024).max(65535),
}).strict();

const ReverseProxyListenerSchema = z.union([
  z.object({
    kind: z.literal("unix"),
    path: z.string().min(1).max(100).refine((path) => path.startsWith("/") && !path.split("/").includes(".."), "socket path must be absolute and normalized"),
  }).strict(),
  TcpListenerSchema.extend({ fallback: z.literal(true) }).strict(),
]);

const SharedFolderSchema = z.string().min(1).max(4096)
  .refine((path) => {
    try { canonicalSharedFolders([path]); return true; } catch { return false; }
  }, "shared repository folder must be canonical, absolute, and non-root");
const SharedFoldersSchema = z.array(SharedFolderSchema).min(1).max(16).transform((folders, context) => {
  try { return canonicalSharedFolders(folders); }
  catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

export const GitHubPrincipalMappingSchema = z.object({
  provider: z.literal("github"),
  subject: z.string().refine(isGitHubSubject, "subject must be a decimal GitHub numeric ID"),
  login: z.string().refine((login) => {
    try {
      return canonicalizeGitHubLogin(login) === login;
    } catch {
      return false;
    }
  }, "login must be canonical lowercase GitHub login"),
  verifiedAt: z.string().datetime().optional(),
  verification: z.enum(["verified", "pending", "disabled"]),
  etag: z.string().min(1).max(512).optional(),
}).strict().superRefine((mapping, context) => {
  if (mapping.verification === "verified" && !mapping.verifiedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["verifiedAt"], message: "verified mapping needs verifiedAt" });
  }
});

const BaseConfig = {
  version: z.literal(2),
  sharedRepositoryFolders: SharedFoldersSchema,
};

const LocalConfigSchema = z.object({
  ...BaseConfig,
  mode: z.literal("local"),
  listener: TcpListenerSchema,
}).strict();

const PublicConfigFields = {
  ...BaseConfig,
  listener: ReverseProxyListenerSchema,
  publicOrigin: z.string().refine((input) => {
    try {
      const url = new URL(input);
      return url.protocol === "https:" && url.origin === input && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "publicOrigin must be one canonical HTTPS origin"),
  proxySecret: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/, "proxySecret must be base64url"),
  principals: z.array(GitHubPrincipalMappingSchema).min(1),
};

const publicConfigRefinement = (config: { principals: Array<{ login: string; subject: string }> }, context: z.RefinementCtx) => {
  const logins = new Set<string>();
  const subjects = new Set<string>();
  config.principals.forEach((principal, index) => {
    if (logins.has(principal.login)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["principals", index, "login"], message: "duplicate login" });
    if (subjects.has(principal.subject)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["principals", index, "subject"], message: "duplicate subject" });
    logins.add(principal.login); subjects.add(principal.subject);
  });
};

const ReverseProxyConfigSchema = z.object({
  ...PublicConfigFields,
  mode: z.literal("reverse-proxy"),
}).strict().superRefine(publicConfigRefinement);

const TailscaleFunnelConfigSchema = z.object({
  ...PublicConfigFields,
  mode: z.literal("tailscale-funnel"),
  tailscaleDnsName: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/),
}).strict().superRefine(publicConfigRefinement);

export const AppConfigSchema = z.union([LocalConfigSchema, ReverseProxyConfigSchema, TailscaleFunnelConfigSchema]);
export type AppConfig = z.infer<typeof AppConfigSchema>;

export type ListenerConfig =
  | { kind: "tcp"; host: "127.0.0.1"; port: number; fallback?: true }
  | { kind: "unix"; path: string };

export interface ResolvedConfig {
  listener: ListenerConfig;
  adapterKind: "real" | "fake";
  security: SecurityConfig;
  origin: string;
  sharedRepositoryFolders: string[];
  gitCommitter: { name: string; email: string };
}

const LegacyConfigSchema = z.object({ version: z.literal(1), workspaceRoots: z.array(SharedFolderSchema).min(1).max(16) }).passthrough()
  .refine((value) => !("sharedRepositoryFolders" in value), "legacy and current workspace fields cannot be mixed");

/** Explicit, non-broadening migration: every legacy root remains the exact shared folder. */
export function migrateLegacyConfig(input: unknown): unknown {
  if (!input || typeof input !== "object" || (input as { version?: unknown }).version !== 1) return input;
  const legacy = LegacyConfigSchema.parse(input);
  const { workspaceRoots, version: _version, ...rest } = legacy;
  return { ...rest, version: 2, sharedRepositoryFolders: canonicalSharedFolders(workspaceRoots) };
}

export function parseConfig(input: unknown): AppConfig {
  return AppConfigSchema.parse(migrateLegacyConfig(input));
}

export function resolveConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const adapterKind = z.enum(["real", "fake"]).parse(env.PI_TOGETHER_ADAPTER ?? "real");
  let security: SecurityConfig;
  let origin: string;
  if (config.mode === "local") {
    security = { mode: "local" };
    origin = `http://${config.listener.host}:${config.listener.port}`;
  } else {
    if (config.principals.some((principal) => principal.verification !== "verified")) {
      throw new Error("reverse-proxy mode requires every principal mapping to be verified");
    }
    const principalsByLogin = new Map<string, GitHubPrincipal>();
    for (const mapping of config.principals as GitHubPrincipalMapping[]) {
      principalsByLogin.set(mapping.login, {
        provider: "github",
        subject: mapping.subject,
        login: mapping.login,
      });
    }
    security = { mode: "reverse-proxy", proxySecret: config.proxySecret, principalsByLogin };
    origin = config.publicOrigin;
  }
  const committerName = z.string().min(1).max(128)
    .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), "Git committer name contains unsafe characters")
    .parse(env.PI_TOGETHER_GIT_COMMITTER_NAME ?? "Pi Together");
  let committerEmail = "";
  const committerLogin = env.PI_TOGETHER_GIT_COMMITTER_GITHUB_LOGIN;
  if (committerLogin !== undefined) {
    if (security.mode !== "reverse-proxy") throw new Error("Git committer GitHub mapping requires authenticated public mode");
    let canonical: string;
    try { canonical = canonicalizeGitHubLogin(committerLogin); }
    catch { throw new Error("Git committer GitHub mapping is invalid"); }
    if (canonical !== committerLogin) throw new Error("Git committer GitHub mapping must use a canonical login");
    const actor = security.principalsByLogin.get(canonical);
    if (!actor) throw new Error("Git committer GitHub mapping is not an allowed verified principal");
    committerEmail = `${actor.subject}+${actor.login}@users.noreply.github.com`;
  }
  return {
    listener: config.listener,
    adapterKind,
    security,
    origin,
    sharedRepositoryFolders: [...config.sharedRepositoryFolders],
    gitCommitter: { name: committerName, email: committerEmail },
  };
}

function defaultLocalConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = env.PORT === undefined ? 43117 : Number(env.PORT);
  const sharedRepositoryFolders = (env.SHARED_REPOSITORY_FOLDERS ?? env.WORKSPACE_ROOTS ?? join(homedir(), "projects")).split(":").map((path) => path.trim()).filter(Boolean);
  return parseConfig({
    version: 2,
    mode: "local",
    listener: { kind: "tcp", host: "127.0.0.1", port },
    sharedRepositoryFolders,
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const path = env.PI_TOGETHER_CONFIG_FILE;
  if (!path) return resolveConfig(defaultLocalConfig(env), env);

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Pi Together config must not be a symbolic link");
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Pi Together config must be a regular file");
    if ((stat.mode & 0o777) !== 0o600) throw new Error("Pi Together config must have mode 0600");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Pi Together config must be owned by the service user");
    }
    return resolveConfig(parseConfig(JSON.parse(readFileSync(descriptor, "utf8"))), env);
  } finally {
    closeSync(descriptor);
  }
}
