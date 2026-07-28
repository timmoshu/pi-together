import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { buildInstallManifest, InstallManifestSchema, packageVersionForRelease, renderInstallManifest, type InstallManifest } from "../cli/install-manifest.js";
import { parseConfig, type AppConfig } from "../server/config.js";
import { resolveGitHubLogin, type GitHubPrincipalMapping } from "../server/github-principals.js";
import type {
  CurrentUserManagementState,
  UserManagementChange,
  UserManagementIo,
  UserManagementRequest,
} from "./users-core.js";
import { resolvePrivilegedPath } from "./root-path.js";
import { verifyPrivateHealth } from "./private-health.js";

declare const __PI_TOGETHER_VERSION__: string;
const VERSION = typeof __PI_TOGETHER_VERSION__ === "string" ? __PI_TOGETHER_VERSION__ : "0.1.0";
const exec = promisify(execFile);
const APP_CONFIG = "/etc/pi-together/config.json";
const OAUTH_CONFIG = "/etc/pi-together/oauth2-proxy.cfg";
const MANIFEST = "/var/lib/pi-together/install-manifest.json";
const JOURNAL = "/var/lib/pi-together/user-management-journal.json";
const APP_SERVICE = "pi-together.service";
const OAUTH_SERVICE = "pi-together-oauth2-proxy.service";

const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.enum(["add", "remove"]),
  ownerPid: z.number().int().positive(),
  invokingUid: z.number().int().positive(),
  appGid: z.number().int().nonnegative(),
  appConfig: z.string().max(256 * 1024),
  oauthConfig: z.string().max(256 * 1024),
  appWasActive: z.boolean(),
  oauthWasActive: z.boolean(),
}).strict();
type Journal = z.infer<typeof JournalSchema>;

interface ServiceIo {
  isActive(unit: string): Promise<boolean>;
  restart(unit: string): Promise<void>;
}

interface RootUsersOptions {
  request: Pick<UserManagementRequest, "invokingUid">;
  root?: string;
  rootIdentity?: { uid: number; gid: number };
  requireRoot?: boolean;
  sudoUid?: number;
  resolveLogin?: (login: string) => Promise<GitHubPrincipalMapping>;
  services?: ServiceIo;
  validateOauth?: (configPath: string) => Promise<void>;
  health?: (config: AppConfig) => Promise<void>;
}

function archivePath(manifest: InstallManifest): string | undefined {
  return manifest.entries.find((entry) => entry.path.startsWith("/var/lib/pi-together/downloads/oauth2-proxy-v"))?.path;
}
function previousVersion(manifest: InstallManifest): string | undefined {
  return manifest.entries.find((entry) => entry.kind === "directory" && entry.path.startsWith("/opt/pi-together/releases/") && !entry.path.endsWith(`/${manifest.version}`))?.path.split("/").at(-1);
}

export class RootUsersIo implements UserManagementIo {
  private readonly root: string;
  private readonly rootIdentity: { uid: number; gid: number };
  private readonly services: ServiceIo;
  private appGid?: number;

  constructor(private readonly options: RootUsersOptions) {
    this.root = resolve(options.root ?? "/");
    this.rootIdentity = options.rootIdentity ?? { uid: 0, gid: 0 };
    const requireRoot = options.requireRoot ?? true;
    if (requireRoot && process.getuid?.() !== 0) throw new Error("privileged user management must run as root");
    const sudoUid = options.sudoUid ?? Number(process.env.SUDO_UID);
    if (requireRoot && sudoUid !== options.request.invokingUid) throw new Error("user-management identity does not match sudo provenance");
    this.services = options.services ?? {
      isActive: async (unit) => {
        try {
          await exec("/bin/systemctl", ["is-active", "--quiet", unit], { timeout: 10_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
          return true;
        } catch (error) {
          if ((error as { code?: number }).code === 3) return false;
          throw error;
        }
      },
      restart: async (unit) => {
        await exec("/bin/systemctl", ["restart", unit], { timeout: 30_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
        if (!await this.services.isActive(unit)) throw new Error(`${unit} did not become active after restart`);
      },
    };
  }

  private path(logical: string): string {
    return resolvePrivilegedPath(this.root, logical, "user-management");
  }

  private async verifyBoundary(): Promise<void> {
    for (const logical of ["/etc/pi-together", "/var/lib/pi-together"]) {
      const info = await lstat(this.path(logical));
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.rootIdentity.uid || (info.mode & 0o022) !== 0) {
        throw new Error(`${logical} is not a root-owned non-writable directory`);
      }
    }
    if (!this.options.validateOauth) {
      const helper = await lstat(this.path("/opt/pi-together/helpers/oauth2-proxy"));
      if (!helper.isFile() || helper.isSymbolicLink() || helper.uid !== this.rootIdentity.uid || (helper.mode & 0o022) !== 0) {
        throw new Error("oauth2-proxy helper metadata is unsafe");
      }
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async readSafe(
    logical: string,
    expected: { uid: number; gid?: number; mode: number; maximum: number },
  ): Promise<{ bytes: string; gid: number }> {
    const handle = await open(this.path(logical), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== expected.uid || (expected.gid !== undefined && info.gid !== expected.gid)
        || (info.mode & 0o777) !== expected.mode || info.size > expected.maximum) {
        throw new Error(`${logical} has unsafe privileged metadata`);
      }
      return { bytes: await handle.readFile("utf8"), gid: info.gid };
    } finally { await handle.close(); }
  }

  private async atomicWrite(logical: string, contents: string, mode: number, uid: number, gid: number): Promise<void> {
    const target = this.path(logical);
    const temporary = `${target}.users-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await chmod(temporary, mode);
      await chown(temporary, uid, gid);
      await rename(temporary, target);
      await this.syncDirectory(target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async createJournal(journal: Journal): Promise<void> {
    const path = this.path(JOURNAL);
    const bytes = `${JSON.stringify(JournalSchema.parse(journal))}\n`;
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(path, 0o600);
    await chown(path, this.rootIdentity.uid, this.rootIdentity.gid);
    await this.syncDirectory(path);
    const persisted = await this.readSafe(JOURNAL, { ...this.rootIdentity, mode: 0o600, maximum: 2 * 1024 * 1024 });
    if (persisted.bytes !== bytes) throw new Error("user-management recovery journal failed durable read-back");
  }

  private async removeJournal(): Promise<void> {
    try { await unlink(this.path(JOURNAL)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.syncDirectory(this.path(JOURNAL));
  }

  private async readJournal(): Promise<Journal | null> {
    try {
      const file = await this.readSafe(JOURNAL, { ...this.rootIdentity, mode: 0o600, maximum: 2 * 1024 * 1024 });
      return JournalSchema.parse(JSON.parse(file.bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async restartOriginallyActive(journal: Journal): Promise<void> {
    for (const [unit, active] of [[APP_SERVICE, journal.appWasActive], [OAUTH_SERVICE, journal.oauthWasActive]] as const) {
      if (active) await this.services.restart(unit);
    }
  }

  private async recover(): Promise<void> {
    const journal = await this.readJournal();
    if (!journal) return;
    if (journal.ownerPid !== process.pid) {
      try {
        process.kill(journal.ownerPid, 0);
        throw new Error("another user-management operation is still in progress");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (journal.invokingUid !== this.options.request.invokingUid) throw new Error("user-management recovery journal belongs to another service user");
    await this.atomicWrite(APP_CONFIG, journal.appConfig, 0o600, journal.invokingUid, journal.appGid);
    await this.atomicWrite(OAUTH_CONFIG, journal.oauthConfig, 0o644, this.rootIdentity.uid, this.rootIdentity.gid);
    await this.restartOriginallyActive(journal);
    await this.removeJournal();
  }

  async recoverPending(): Promise<void> {
    await this.verifyBoundary();
    await this.recover();
  }

  async loadCurrent(request: UserManagementRequest): Promise<CurrentUserManagementState> {
    if (request.invokingUid !== this.options.request.invokingUid) throw new Error("user-management request identity changed");
    await this.recoverPending();
    const [app, oauth, manifestFile] = await Promise.all([
      this.readSafe(APP_CONFIG, { uid: request.invokingUid, mode: 0o600, maximum: 256 * 1024 }),
      this.readSafe(OAUTH_CONFIG, { ...this.rootIdentity, mode: 0o644, maximum: 256 * 1024 }),
      this.readSafe(MANIFEST, { ...this.rootIdentity, mode: 0o644, maximum: 1024 * 1024 }),
    ]);
    this.appGid = app.gid;
    const manifest = InstallManifestSchema.parse(JSON.parse(manifestFile.bytes));
    const previous = previousVersion(manifest);
    if (packageVersionForRelease(manifest.version) !== VERSION
      || renderInstallManifest(buildInstallManifest(manifest.mode, manifest.version, archivePath(manifest), previous)) !== manifestFile.bytes) {
      throw new Error("installed manifest is not canonical for this privileged helper");
    }
    return { appConfig: app.bytes, oauthConfig: oauth.bytes, manifest: manifestFile.bytes, appConfigOwnerUid: request.invokingUid };
  }

  async resolveLogin(login: string): Promise<GitHubPrincipalMapping> {
    const result = await (this.options.resolveLogin ?? (async (value) => (await resolveGitHubLogin(value)).mapping))(login);
    return result;
  }

  private async validateOauth(contents: string): Promise<void> {
    const temporary = `${this.path(OAUTH_CONFIG)}.validate-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try {
      if (this.options.validateOauth) await this.options.validateOauth(temporary);
      else await exec(this.path("/opt/pi-together/helpers/oauth2-proxy"), ["--config", temporary, "--config-test"], {
        timeout: 30_000,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } finally { await rm(temporary, { force: true }); }
  }

  private async health(config: AppConfig): Promise<void> {
    if (this.options.health) return this.options.health(config);
    if (config.mode === "local") throw new Error("user-management health requires public mode");
    await verifyPrivateHealth(config, (logical) => this.path(logical), "user-management health");
  }

  private async unchanged(previous: CurrentUserManagementState): Promise<boolean> {
    const [app, oauth] = await Promise.all([
      this.readSafe(APP_CONFIG, { uid: previous.appConfigOwnerUid, mode: 0o600, maximum: 256 * 1024 }),
      this.readSafe(OAUTH_CONFIG, { ...this.rootIdentity, mode: 0o644, maximum: 256 * 1024 }),
    ]);
    return app.bytes === previous.appConfig && oauth.bytes === previous.oauthConfig;
  }

  async commit(change: UserManagementChange): Promise<void> {
    if (this.appGid === undefined || change.invokingUid !== this.options.request.invokingUid) throw new Error("user-management state was not securely loaded");
    await this.validateOauth(change.oauthConfig);
    const journal: Journal = {
      schemaVersion: 1,
      operation: change.kind,
      ownerPid: process.pid,
      invokingUid: change.invokingUid,
      appGid: this.appGid,
      appConfig: change.previous.appConfig,
      oauthConfig: change.previous.oauthConfig,
      appWasActive: await this.services.isActive(APP_SERVICE),
      oauthWasActive: await this.services.isActive(OAUTH_SERVICE),
    };
    await this.createJournal(journal);
    if (!await this.unchanged(change.previous)) {
      await this.removeJournal();
      throw new Error("user-management configuration changed before privileged commit");
    }
    try {
      const app = () => this.atomicWrite(APP_CONFIG, change.appConfig, 0o600, change.invokingUid, this.appGid!);
      const oauth = () => this.atomicWrite(OAUTH_CONFIG, change.oauthConfig, 0o644, this.rootIdentity.uid, this.rootIdentity.gid);
      if (change.kind === "add") { await app(); await oauth(); }
      else { await oauth(); await app(); }
      if (!await this.unchanged({ ...change.previous, appConfig: change.appConfig, oauthConfig: change.oauthConfig })) {
        throw new Error("user-management configuration failed durable read-back");
      }
      const order = change.kind === "add"
        ? [[APP_SERVICE, journal.appWasActive], [OAUTH_SERVICE, journal.oauthWasActive]] as const
        : [[OAUTH_SERVICE, journal.oauthWasActive], [APP_SERVICE, journal.appWasActive]] as const;
      for (const [unit, active] of order) if (active) await this.services.restart(unit);
      if (journal.appWasActive) await this.health(parseConfig(JSON.parse(change.appConfig)));
      await this.removeJournal();
    } catch (error) {
      try { await this.recover(); }
      catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "user-management change failed and rollback remains journaled");
      }
      throw error;
    }
  }
}
