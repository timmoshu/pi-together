import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InstallManifestSchema, renderInstallManifest } from "../cli/install-manifest.js";
import { AppConfigSchema } from "../server/config.js";
import {
  GitHubPrincipalMappingSchema,
} from "../server/config.js";
import { canonicalizeGitHubLogin, type GitHubPrincipalMapping } from "../server/github-principals.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const Login = z.string().transform((value, context) => {
  try { return canonicalizeGitHubLogin(value); }
  catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const Operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), login: Login, subject: z.string().regex(/^[1-9]\d*$/) }).strict(),
  z.object({ kind: z.literal("remove"), login: Login }).strict(),
]);
export const UserManagementRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("manage-users"),
  invokingUid: z.number().int().positive().max(2 ** 31 - 1),
  operation: Operation,
  expected: z.object({
    appConfigSha256: SHA256,
    oauthConfigSha256: SHA256,
    manifestSha256: SHA256,
  }).strict(),
}).strict();
export type UserManagementRequest = z.infer<typeof UserManagementRequestSchema>;

export interface CurrentUserManagementState {
  appConfig: string;
  oauthConfig: string;
  manifest: string;
  appConfigOwnerUid: number;
}

export interface UserManagementChange {
  kind: "add" | "remove";
  login: string;
  appConfig: string;
  oauthConfig: string;
  previous: CurrentUserManagementState;
  invokingUid: number;
}

export interface UserManagementIo {
  loadCurrent(request: UserManagementRequest): Promise<CurrentUserManagementState>;
  resolveLogin(login: string): Promise<GitHubPrincipalMapping>;
  commit(change: UserManagementChange): Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(actual: string, expected: string): boolean {
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function exactOauthLine(value: string): { full: string; encoded: string } {
  const matches = [...value.matchAll(/^github_users = ([^\r\n]+)$/gm)];
  if (matches.length !== 1) throw new Error("oauth2-proxy config must contain exactly one github_users allowlist");
  return { full: matches[0]![0], encoded: matches[0]![1]! };
}

export function oauthUsers(value: string): string[] {
  const { encoded } = exactOauthLine(value);
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { throw new Error("oauth2-proxy github_users allowlist is not canonical JSON-compatible TOML"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) throw new Error("oauth2-proxy github_users allowlist has an invalid size");
  const users = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("oauth2-proxy github_users allowlist contains a non-string");
    return canonicalizeGitHubLogin(item);
  }).sort();
  if (new Set(users).size !== users.length) throw new Error("oauth2-proxy github_users allowlist contains duplicates");
  return users;
}

export function replaceOauthUsers(value: string, usersValue: string[]): string {
  const users = usersValue.map(canonicalizeGitHubLogin).sort();
  if (users.length < 1 || users.length > 32 || new Set(users).size !== users.length) throw new Error("desired GitHub allowlist is invalid");
  const line = exactOauthLine(value);
  return value.replace(line.full, `github_users = ${JSON.stringify(users)}`);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function applyUserManagement(value: unknown, io: UserManagementIo): Promise<void> {
  const request = UserManagementRequestSchema.parse(value);
  const current = await io.loadCurrent(request);
  if (current.appConfigOwnerUid !== request.invokingUid) throw new Error("app config owner does not match the invoking user");
  for (const [label, contents, expected] of [
    ["app config", current.appConfig, request.expected.appConfigSha256],
    ["oauth config", current.oauthConfig, request.expected.oauthConfigSha256],
    ["installation manifest", current.manifest, request.expected.manifestSha256],
  ] as const) {
    if (!equalDigest(sha256(contents), expected)) throw new Error(`${label} changed after the operation was reviewed`);
  }

  const manifest = InstallManifestSchema.parse(JSON.parse(current.manifest));
  if (renderInstallManifest(manifest) !== current.manifest || manifest.mode === "local") {
    throw new Error("user management requires one canonical public installation manifest");
  }
  for (const path of ["/etc/pi-together/config.json", "/etc/pi-together/oauth2-proxy.cfg"]) {
    if (!manifest.entries.some((entry) => entry.path === path && entry.kind === "file")) {
      throw new Error(`installation manifest does not own required user-management path: ${path}`);
    }
  }

  const parsed = AppConfigSchema.parse(JSON.parse(current.appConfig));
  if (parsed.mode === "local") throw new Error("GitHub user management is available only in public mode");
  if (parsed.listener.kind === "unix" && parsed.listener.path !== "/run/pi-together/app.sock") {
    throw new Error("user management requires the canonical private application socket");
  }
  const principals = parsed.principals.map((principal) => GitHubPrincipalMappingSchema.parse(principal));
  if (principals.some((principal) => principal.verification !== "verified")) {
    throw new Error("every existing GitHub principal must be verified before user management");
  }
  const configuredLogins = principals.map((principal) => principal.login).sort();
  if (!sameStrings(configuredLogins, oauthUsers(current.oauthConfig))) {
    throw new Error("app and oauth2-proxy GitHub allowlists disagree");
  }

  let desired: GitHubPrincipalMapping[];
  if (request.operation.kind === "add") {
    if (principals.some((principal) => principal.login === request.operation.login)) throw new Error("GitHub login is already allowed");
    if (principals.length >= 32) throw new Error("GitHub allowlist already contains the maximum 32 users");
    const independentlyVerified = GitHubPrincipalMappingSchema.parse(await io.resolveLogin(request.operation.login));
    if (independentlyVerified.verification !== "verified"
      || independentlyVerified.login !== request.operation.login
      || independentlyVerified.subject !== request.operation.subject) {
      throw new Error("GitHub identity changed or failed independent verification");
    }
    if (principals.some((principal) => principal.subject === independentlyVerified.subject)) {
      throw new Error("GitHub numeric identity is already allowed under another login");
    }
    desired = [...principals, independentlyVerified];
  } else {
    if (!principals.some((principal) => principal.login === request.operation.login)) throw new Error("GitHub login is not currently allowed");
    if (principals.length === 1) throw new Error("cannot remove the last allowed GitHub user");
    desired = principals.filter((principal) => principal.login !== request.operation.login);
  }
  desired.sort((left, right) => left.login.localeCompare(right.login));
  const appConfig = `${JSON.stringify({ ...parsed, principals: desired }, null, 2)}\n`;
  const oauthConfig = replaceOauthUsers(current.oauthConfig, desired.map((principal) => principal.login));
  AppConfigSchema.parse(JSON.parse(appConfig));
  await io.commit({
    kind: request.operation.kind,
    login: request.operation.login,
    appConfig,
    oauthConfig,
    previous: current,
    invokingUid: request.invokingUid,
  });
}
