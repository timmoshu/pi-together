import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, open, readFile, rename, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "../server/config.js";
import { validateSharedFolders } from "../server/workspace-policy.js";
import type { CurrentWorkspaceManagementState, WorkspaceManagementChange, WorkspaceManagementIo, WorkspaceManagementRequest } from "./workspaces-core.js";

const exec = promisify(execFile);
const APP_CONFIG = "/etc/pi-together/config.json";
const MANIFEST = "/var/lib/pi-together/install-manifest.json";
const JOURNAL = "/var/lib/pi-together/policy-journal.json";
const BACKUP = "/var/lib/pi-together/workspace-config.rollback";
const TEMP = "/etc/pi-together/.config.workspace-new";

async function readSafe(path: string, owner: number, mode: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o777) !== mode || info.size > 2 * 1024 * 1024) throw new Error(`${path} has unsafe metadata`);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function durableWrite(path: string, value: string, mode: number, uid: number, gid: number): Promise<void> {
  await rm(path, { force: true });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, mode);
  await chown(path, uid, gid);
  await syncDirectory(dirname(path));
}

async function restartAndCheck(configBody: string): Promise<void> {
  await exec("/bin/systemctl", ["restart", "pi-together.service"], { timeout: 30_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  const config = parseConfig(JSON.parse(configBody));
  const endpoint = config.listener.kind === "unix" ? { socketPath: config.listener.path } : { host: config.listener.host, port: config.listener.port };
  const headers = config.mode === "local" ? {} : {
    host: new URL(config.publicOrigin).hostname,
    "x-pi-together-proxy-secret": config.proxySecret,
    "x-pi-together-login": config.principals[0]!.login,
  };
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({ ...endpoint, path: "/api/health", method: "GET", headers }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error("private health check failed")));
    });
    request.setTimeout(5_000, () => request.destroy(new Error("private health check timed out")));
    request.once("error", reject);
    request.end();
  });
}

export class RootWorkspaceIo implements WorkspaceManagementIo {
  constructor(private readonly boundaryRequest: Pick<WorkspaceManagementRequest, "invokingUid">) {
    if (process.getuid?.() !== 0 || Number(process.env.SUDO_UID) !== boundaryRequest.invokingUid) {
      throw new Error("workspace management requires matching sudo provenance");
    }
  }

  private async recover(request: Pick<WorkspaceManagementRequest, "invokingUid">): Promise<void> {
    let journalBody: string;
    try { journalBody = await readSafe(JOURNAL, 0, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await rm(BACKUP, { force: true });
        return;
      }
      throw error;
    }
    const journal = JSON.parse(journalBody) as Record<string, unknown>;
    if (journal.schemaVersion !== 1 || journal.action !== "manage-workspaces" || journal.config !== APP_CONFIG
      || journal.invokingUid !== request.invokingUid || typeof journal.oldSha256 !== "string" || typeof journal.newSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(journal.oldSha256) || !/^[a-f0-9]{64}$/.test(journal.newSha256)) {
      throw new Error("workspace recovery journal is malformed");
    }
    const backup = await readSafe(BACKUP, 0, 0o600);
    if (sha256(backup) !== journal.oldSha256) throw new Error("workspace rollback backup does not match journal");
    const currentInfo = await stat(APP_CONFIG);
    await durableWrite(TEMP, backup, 0o600, request.invokingUid, currentInfo.gid);
    await rename(TEMP, APP_CONFIG);
    await syncDirectory(dirname(APP_CONFIG));
    await restartAndCheck(backup);
    await rm(JOURNAL);
    await syncDirectory(dirname(JOURNAL));
    await rm(BACKUP, { force: true });
  }

  async recoverPending(request: Pick<WorkspaceManagementRequest, "invokingUid"> = this.boundaryRequest): Promise<void> {
    if (request.invokingUid !== this.boundaryRequest.invokingUid) throw new Error("workspace-management request identity changed");
    await this.recover(request);
  }

  async loadCurrent(request: WorkspaceManagementRequest): Promise<CurrentWorkspaceManagementState> {
    await this.recoverPending(request);
    const appInfo = await stat(APP_CONFIG);
    return {
      appConfig: await readSafe(APP_CONFIG, request.invokingUid, 0o600),
      manifest: await readSafe(MANIFEST, 0, 0o644),
      appConfigOwnerUid: appInfo.uid,
    };
  }

  async validateFolders(folders: string[], invokingUid: number): Promise<void> {
    await validateSharedFolders(folders, invokingUid);
  }

  async commit(change: WorkspaceManagementChange): Promise<void> {
    const currentInfo = await stat(APP_CONFIG);
    await durableWrite(BACKUP, change.previous.appConfig, 0o600, 0, 0);
    let journal;
    try { journal = await open(JOURNAL, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { await rm(BACKUP, { force: true }); throw error; }
    try {
      await journal.writeFile(`${JSON.stringify({ schemaVersion: 1, action: "manage-workspaces", config: APP_CONFIG, invokingUid: change.invokingUid, oldSha256: sha256(change.previous.appConfig), newSha256: sha256(change.appConfig) })}\n`);
      await journal.sync();
    } finally { await journal.close(); }
    await syncDirectory(dirname(JOURNAL));
    try {
      await durableWrite(TEMP, change.appConfig, 0o600, change.invokingUid, currentInfo.gid);
      await rename(TEMP, APP_CONFIG);
      await syncDirectory(dirname(APP_CONFIG));
      if (await readFile(APP_CONFIG, "utf8") !== change.appConfig) throw new Error("workspace config read-back mismatch");
      await restartAndCheck(change.appConfig);
      await rm(JOURNAL);
      await syncDirectory(dirname(JOURNAL));
      await rm(BACKUP, { force: true });
    } catch (error) {
      await durableWrite(TEMP, change.previous.appConfig, 0o600, change.invokingUid, currentInfo.gid).catch(() => undefined);
      await rename(TEMP, APP_CONFIG).catch(() => undefined);
      await syncDirectory(dirname(APP_CONFIG)).catch(() => undefined);
      await restartAndCheck(change.previous.appConfig).catch(() => undefined);
      throw error;
    } finally { await rm(TEMP, { force: true }); }
  }
}
