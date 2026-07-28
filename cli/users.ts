import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { inspectInstalledManifest, loadInstalledManifest } from "./uninstall.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";
import { AppConfigSchema } from "../server/config.js";
import { canonicalizeGitHubLogin, resolveGitHubLogin, type GitHubVerificationResult } from "../server/github-principals.js";
import {
  oauthUsers,
  type CurrentUserManagementState,
  type UserManagementRequest,
} from "../privileged/users-core.js";

const APP_CONFIG = "/etc/pi-together/config.json";
const OAUTH_CONFIG = "/etc/pi-together/oauth2-proxy.cfg";
const INSTALL_MANIFEST = "/var/lib/pi-together/install-manifest.json";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readOwnedFile(
  path: string,
  expected: { uid: number; gid?: number; mode: number },
  maximumBytes = 1024 * 1024,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== expected.uid || (expected.gid !== undefined && info.gid !== expected.gid)
      || (info.mode & 0o777) !== expected.mode || info.size > maximumBytes) {
      throw new Error(`${path} has unsafe type, ownership, mode, or size`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export async function loadUserManagementState(
  invokingUid = process.getuid?.(),
  paths?: { appConfig: string; oauthConfig: string; manifest: string },
  root = { uid: 0, gid: 0 },
  inspectManifest?: (uid: number) => ReturnType<typeof inspectInstalledManifest>,
): Promise<CurrentUserManagementState> {
  if (invokingUid === undefined || invokingUid === 0) throw new Error("user management must run as the non-root Pi service user");
  const effectivePaths = paths ?? { appConfig: APP_CONFIG, oauthConfig: OAUTH_CONFIG, manifest: INSTALL_MANIFEST };
  const [appConfig, oauthConfig, loaded] = await Promise.all([
    readOwnedFile(effectivePaths.appConfig, { uid: invokingUid, mode: 0o600 }),
    readOwnedFile(effectivePaths.oauthConfig, { ...root, mode: 0o644 }),
    inspectManifest ? inspectManifest(invokingUid)
      : paths ? loadInstalledManifest(effectivePaths.manifest, root) : inspectInstalledManifest(invokingUid),
  ]);
  if (loaded.manifest.mode === "local") throw new Error("GitHub user management is available only for public installations");
  const parsed = AppConfigSchema.parse(JSON.parse(appConfig));
  if (parsed.mode === "local") throw new Error("GitHub user management is available only in public mode");
  const appUsers = parsed.principals.map((principal) => principal.login).sort();
  const proxyUsers = oauthUsers(oauthConfig);
  if (appUsers.length !== proxyUsers.length || appUsers.some((login, index) => login !== proxyUsers[index])) {
    throw new Error("app and oauth2-proxy GitHub allowlists disagree; restore a reviewed matching configuration before making changes");
  }
  return {
    appConfig,
    oauthConfig,
    manifest: `${JSON.stringify(loaded.manifest, null, 2)}\n`,
    appConfigOwnerUid: invokingUid,
  };
}

export interface UsersCommandOptions {
  uid?: number;
  loadCurrent?: () => Promise<CurrentUserManagementState>;
  resolveLogin?: (login: string) => Promise<GitHubVerificationResult & { kind: "verified" }>;
  confirm?: (message: string) => Promise<boolean>;
  write?: (message: string) => void;
  invoke?: (request: UserManagementRequest) => Promise<void>;
}

function parsedConfig(current: CurrentUserManagementState) {
  const config = AppConfigSchema.parse(JSON.parse(current.appConfig));
  if (config.mode === "local") throw new Error("GitHub user management is available only in public mode");
  const oauthLogins = oauthUsers(current.oauthConfig);
  const configLogins = config.principals.map((principal) => principal.login).sort();
  if (configLogins.length !== oauthLogins.length || configLogins.some((login, index) => login !== oauthLogins[index])) {
    throw new Error("app and oauth2-proxy GitHub allowlists disagree; restore a reviewed matching configuration before making changes");
  }
  return config;
}

async function terminalConfirm(message: string): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return /^(?:y|yes)$/i.test((await prompt.question(`${message} [y/N] `)).trim()); }
  finally { prompt.close(); }
}

function usage(): Error {
  return new Error("Usage: pi-together users list [--json] | add <github-login> [--yes] | remove <github-login> [--yes]");
}

export async function runUsersCommand(args: string[], options: UsersCommandOptions = {}): Promise<boolean> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error("user management must run as the non-root Pi service user");
  const write = options.write ?? ((message: string) => stdout.write(message));
  const loadCurrent = options.loadCurrent ?? (() => loadUserManagementState(uid));
  const current = await loadCurrent();
  const config = parsedConfig(current);
  const [command, loginInput, ...rest] = args;

  if (command === "list") {
    if ((loginInput !== undefined && loginInput !== "--json") || rest.length) throw usage();
    const principals = [...config.principals].sort((left, right) => left.login.localeCompare(right.login));
    if (loginInput === "--json") write(`${JSON.stringify(principals.map(({ login, subject }) => ({ login, subject })))}\n`);
    else {
      write(`Allowed GitHub users (${principals.length})\n`);
      for (const principal of principals) write(`${principal.login}  GitHub ID ${principal.subject}\n`);
    }
    return true;
  }

  if (command !== "add" && command !== "remove") throw usage();
  if (!loginInput || rest.some((arg) => arg !== "--yes") || rest.filter((arg) => arg === "--yes").length > 1) throw usage();
  const login = canonicalizeGitHubLogin(loginInput);
  const existing = config.principals.find((principal) => principal.login === login);
  let operation: UserManagementRequest["operation"];
  if (command === "add") {
    if (existing) throw new Error(`${login} is already allowed`);
    if (config.principals.length >= 32) throw new Error("the GitHub allowlist already contains the maximum 32 users");
    write(`Verifying ${login} with GitHub…\n`);
    const result = await (options.resolveLogin ?? resolveGitHubLogin)(login);
    operation = { kind: "add", login, subject: result.mapping.subject };
    write(`Add ${login} (GitHub ID ${result.mapping.subject}). The identity will be independently reverified inside the privileged boundary.\n`);
  } else {
    if (!existing) throw new Error(`${login} is not currently allowed`);
    if (config.principals.length === 1) throw new Error("cannot remove the last allowed GitHub user");
    operation = { kind: "remove", login };
    write(`Remove ${login} (GitHub ID ${existing.subject}). Existing requests and sessions will be denied by the backend after restart.\n`);
  }

  if (!rest.includes("--yes") && !await (options.confirm ?? terminalConfirm)(`Apply this exact ${command} operation?`)) {
    write("User-management change cancelled; no mutation was attempted.\n");
    return false;
  }
  const request: UserManagementRequest = {
    protocolVersion: 1,
    action: "manage-users",
    invokingUid: uid,
    operation,
    expected: {
      appConfigSha256: sha256(current.appConfig),
      oauthConfigSha256: sha256(current.oauthConfig),
      manifestSha256: sha256(current.manifest),
    },
  };
  await (options.invoke ?? ((value) => runPrivilegedLifecycle(value, "user management")))(request);
  write(`${login} ${command === "add" ? "added to" : "removed from"} the GitHub allowlist.\n`);
  return true;
}
