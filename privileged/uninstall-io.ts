import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readlink, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { UninstallIo, UninstallOperation, ValidatedUninstall } from "./uninstall-core.js";
import { renderInstallManifest, type InstallManifest } from "../cli/install-manifest.js";
import { readBoundedRegular } from "./bounded-file.js";
import { resolvePrivilegedPath } from "./root-path.js";

const exec = promisify(execFile);
export interface UninstallCommand { (file: string, args: string[]): Promise<void> }
export interface RootUninstallOptions { root?: string; command?: UninstallCommand; serviceState?: (unit: string) => Promise<string>; requireRoot?: boolean; rootIdentity?: { uid: number; gid: number }; invokingUid?: number; sudoUid?: number }
const defaultCommand: UninstallCommand = async (file, args) => {
  await exec(file, args, { timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
};
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export class RootUninstallIo implements UninstallIo {
  private readonly root: string;
  private readonly command: UninstallCommand;
  private completed = new Set<string>();
  private readonly serviceState: (unit: string) => Promise<string>;
  private readonly rootIdentity: { uid: number; gid: number };
  private readonly invokingUid?: number;
  constructor(options: RootUninstallOptions = {}) {
    this.root = resolve(options.root ?? "/");
    this.command = options.command ?? defaultCommand;
    this.serviceState = options.serviceState ?? (async (unit) => {
      try { return (await exec("/bin/systemctl", ["show", "--property=ActiveState", "--value", unit], { encoding: "utf8", timeout: 10_000 })).stdout.trim(); }
      catch { return "unknown"; }
    });
    this.rootIdentity = options.rootIdentity ?? { uid: 0, gid: 0 };
    this.invokingUid = options.invokingUid;
    const requireRoot = options.requireRoot ?? true;
    if (requireRoot && process.getuid?.() !== 0) throw new Error("privileged uninstall must run as root");
    const sudoUid = options.sudoUid ?? Number(process.env.SUDO_UID);
    if ((requireRoot || options.sudoUid !== undefined) && options.invokingUid !== undefined && sudoUid !== options.invokingUid) {
      throw new Error("uninstall invoking identity does not match sudo provenance");
    }
  }
  private path(logical: string): string {
    return resolvePrivilegedPath(this.root, logical, "uninstall");
  }
  private journalPath(): string { return this.path("/var/lib/pi-together/uninstall-journal.json"); }
  private async syncParent(path: string): Promise<void> {
    const handle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async safeParents(logical: string): Promise<void> {
    let current = this.root;
    for (const segment of relative(this.root, dirname(this.path(logical))).split("/").filter(Boolean)) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe uninstall parent: ${logical}`);
    }
  }
  private async readJournal(): Promise<{
    schemaVersion?: number;
    manifestSha256?: string;
    purgeConfig?: boolean;
    completed?: unknown[];
    invokingUid?: number;
    manifest?: InstallManifest;
  }> {
    const { bytes, info } = await readBoundedRegular(this.journalPath(), 1024 * 1024, "uninstall recovery journal is not a bounded stable regular file");
    if ((info.mode & 0o777) !== 0o600 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid) {
      throw new Error("unsafe uninstall recovery journal");
    }
    return JSON.parse(bytes.toString("utf8")) as Awaited<ReturnType<RootUninstallIo["readJournal"]>>;
  }
  async verifyManifest(validated: ValidatedUninstall): Promise<void> {
    if (this.invokingUid !== undefined && validated.request.invokingUid !== this.invokingUid) {
      throw new Error("uninstall request identity changed");
    }
    try {
      const { bytes, info } = await readBoundedRegular(this.path("/var/lib/pi-together/install-manifest.json"), 1024 * 1024, "installed ownership manifest is not a bounded stable regular file");
      if ((info.mode & 0o777) !== 0o644 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid
        || sha256(bytes) !== validated.request.manifestSha256) throw new Error("installed ownership manifest failed root-side verification");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const journal = await this.readJournal();
      if (journal.manifestSha256 !== validated.request.manifestSha256) {
        throw new Error("missing ownership manifest is not bound to the uninstall recovery journal");
      }
    }
  }
  private async save(validated: ValidatedUninstall): Promise<void> {
    const path = this.journalPath();
    const temporary = `${path}.${process.pid}.tmp`;
    const body = Buffer.from(`${JSON.stringify({
      schemaVersion: 2,
      manifestSha256: validated.request.manifestSha256,
      manifest: validated.request.manifest,
      invokingUid: validated.request.invokingUid,
      purgeConfig: validated.request.purgeConfig,
      completed: [...this.completed],
    })}\n`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await this.syncParent(path);
  }
  async recover(validated: ValidatedUninstall): Promise<Set<string>> {
    try {
      const value = await this.readJournal();
      const expectedPrefix = validated.operations.slice(0, value.completed?.length ?? 0).map((operation) => operation.id);
      const embeddedManifestMatches = value.schemaVersion === 1 || (value.schemaVersion === 2
        && value.invokingUid === validated.request.invokingUid
        && value.manifest !== undefined
        && renderInstallManifest(value.manifest) === renderInstallManifest(validated.request.manifest));
      if (![1, 2].includes(value.schemaVersion ?? 0) || !embeddedManifestMatches
        || value.manifestSha256 !== validated.request.manifestSha256 || value.purgeConfig !== validated.request.purgeConfig
        || !Array.isArray(value.completed) || value.completed.some((id) => typeof id !== "string")
        || JSON.stringify(value.completed) !== JSON.stringify(expectedPrefix)) throw new Error("uninstall journal does not match the exact operation prefix");
      this.completed = new Set(value.completed as string[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save(validated);
    }
    return new Set(this.completed);
  }
  private async removeFile(logical: string, symlink: boolean): Promise<void> {
    await this.safeParents(logical);
    const path = this.path(logical);
    try {
      const info = await lstat(path);
      if (symlink !== info.isSymbolicLink() || (!symlink && !info.isFile())) throw new Error(`uninstall target type changed: ${logical}`);
      await rm(path);
      await this.syncParent(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async validateRelease(root: string): Promise<void> {
    const top = await lstat(root);
    if (!top.isDirectory() || top.isSymbolicLink() || top.uid !== this.rootIdentity.uid || top.gid !== this.rootIdentity.gid
      || (top.mode & 0o7002) !== 0) throw new Error("immutable release root is unsafe to remove");
    const pending = [root];
    let count = 0;
    let bytes = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        count++;
        bytes += info.size;
        if (count > 10_000 || bytes > 256 * 1024 * 1024 || info.dev !== top.dev || info.isSymbolicLink()
          || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid || (info.mode & 0o7002) !== 0) {
          throw new Error("immutable release tree is unsafe to remove");
        }
        if (info.isDirectory()) pending.push(path);
        else if (!info.isFile()) throw new Error("immutable release contains an unsupported file type");
      }
    }
  }
  async execute(operation: UninstallOperation, validated: ValidatedUninstall): Promise<void> {
    switch (operation.kind) {
      case "disable-service": {
        try { await this.command("/bin/systemctl", ["disable", "--now", operation.target]); } catch { /* Verify state below. */ }
        const state = await this.serviceState(operation.target);
        if (!["inactive", "failed"].includes(state)) throw new Error(`owned service could not be stopped: ${operation.target}`);
        break;
      }
      case "remove-file":
        if (operation.target === "/etc/pi-together/config.json" && !validated.request.purgeConfig) throw new Error("config purge was not explicitly approved");
        await this.removeFile(operation.target, false);
        break;
      case "remove-symlink": {
        const previous = validated.request.manifest.entries.find((entry) => entry.kind === "directory" && entry.path.startsWith("/opt/pi-together/releases/") && !entry.path.endsWith(`/${validated.request.manifest.version}`))?.path;
        const expected = operation.target === "/opt/pi-together/current" ? `/opt/pi-together/releases/${validated.request.manifest.version}`
          : operation.target === "/opt/pi-together/previous" ? previous
          : "/etc/nginx/sites-available/pi-together.conf";
        if (!expected) throw new Error("previous release inventory is missing");
        try {
          if (await readlink(this.path(operation.target)) !== expected) throw new Error(`managed symlink target changed: ${operation.target}`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await this.removeFile(operation.target, true);
        break;
      }
      case "remove-release": {
        const path = this.path(operation.target);
        try {
          await this.validateRelease(path);
          await rm(path, { recursive: true });
          await this.syncParent(path);
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        break;
      }
      case "reload-nginx":
        await this.command("/usr/sbin/nginx", ["-t"]);
        await this.command("/bin/systemctl", ["reload", "nginx.service"]);
        break;
      case "daemon-reload":
        await this.command("/bin/systemctl", ["daemon-reload"]);
        break;
    }
  }
  async record(operationId: string, validated: ValidatedUninstall): Promise<void> {
    this.completed.add(operationId);
    await this.save(validated);
  }
  async finish(): Promise<void> {
    const journal = this.journalPath();
    await rm(journal, { force: true });
    await this.syncParent(journal);
    await this.removeFile("/var/lib/pi-together/install-manifest.json", false);
  }
}
