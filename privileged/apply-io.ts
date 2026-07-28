import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod, chown, cp, lchown, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { SetupPlanSchema, type FileState, type SetupOperation, type SetupPlan } from "../cli/operation-plan.js";
import type { ApplyIo, ValidatedApply } from "./apply-core.js";
import { resolvePrivilegedPath } from "./root-path.js";
import { availableLoopbackPort } from "../shared/local-listener.js";
import { parseConfig, type AppConfig } from "../server/config.js";
import { hashBoundedHandle, readBoundedHandle, readBoundedRegular } from "./bounded-file.js";
import { verifyPrivateHealth } from "./private-health.js";
import { inspectCertificateLineage } from "./certificate-inventory.js";
import { inspectBoundedTree, reviewedDirectoryPaths } from "./bounded-tree.js";
import { syncDirectory, syncFile, writeFileExclusive } from "./fs-durability.js";
import { certbotArguments } from "./certbot.js";

export { certbotArguments } from "./certbot.js";
export interface CommandRunner {
  (file: string, args: string[]): Promise<void>;
}
export interface RootApplyOptions {
  root?: string;
  packageRoot: string;
  command?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  requireRoot?: boolean;
  identities?: Record<string, { uid: number; gid: number }>;
  installedPackages?: ReadonlySet<string>;
  probeLocalPort?: (port: number) => Promise<boolean>;
  health?: (config: AppConfig) => Promise<void>;
  sudoUid?: number;
}
const runFile = promisify(execFile);
const MANAGED_FILE_INSPECTION_LIMIT = 16 * 1024 * 1024;

const defaultCommand: CommandRunner = async (file, args) => {
  await runFile(file, args, {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
  });
};

class BeforeMutationError extends Error {}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sameState(left: FileState, right: FileState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class RootApplyIo implements ApplyIo {
  private readonly root: string;
  private readonly command: CommandRunner;
  private readonly fetcher: typeof globalThis.fetch;
  private validated?: ValidatedApply;
  private readonly touched = new Set<string>();
  private daemonReloaded = true;
  private nginxReloadNeededOnAbort = false;
  private readonly packagesInstalledByApply = new Set<string>();
  private readonly reviewedArtifacts = new Map<string, string>();
  private readonly backupMetadata = new Map<string, { mode: number; uid: number; gid: number }>();
  private journal?: {
    schemaVersion: 1;
    planDigest: string;
    plan: SetupPlan;
    completed: string[];
    inFlight?: string;
    backupMetadata: Record<string, { mode: number; uid: number; gid: number }>;
    packagesInstalledByApply: string[];
    temporaryPaths: string[];
  };

  constructor(private readonly options: RootApplyOptions) {
    this.root = resolve(options.root ?? "/");
    this.command = options.command ?? defaultCommand;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if ((options.requireRoot ?? true) && process.getuid?.() !== 0) throw new Error("privileged apply must run as root");
  }

  private path(logical: string): string {
    return resolvePrivilegedPath(this.root, logical, "apply");
  }

  async localPortAvailable(port: number): Promise<boolean> {
    if (this.options.probeLocalPort) return this.options.probeLocalPort(port);
    if (this.root !== "/") return true;
    return await availableLoopbackPort([port]) === port;
  }

  async inspect(logical: string, maximumBytes = MANAGED_FILE_INSPECTION_LIMIT): Promise<FileState> {
    const path = this.path(logical);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(path), uid: info.uid, gid: info.gid };
      if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
      if (!info.isFile()) return { kind: "other" };
      if (info.size > maximumBytes) throw new Error("managed file exceeds inspection limit");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maximumBytes) {
          throw new Error("managed file changed during inspection");
        }
        const digest = await hashBoundedHandle(handle, maximumBytes);
        const after = await handle.stat();
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new Error("managed file changed during inspection");
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

  private expected(path: string): FileState {
    const expected = this.validated?.plan.preconditions.find((item) => item.path === path)?.expected;
    if (!expected) throw new BeforeMutationError(`operation target has no reviewed precondition: ${path}`);
    return expected;
  }

  private async recheckFirstTouch(path: string): Promise<void> {
    if (this.touched.has(path)) return;
    if (!sameState(await this.inspect(path), this.expected(path))) throw new BeforeMutationError(`target changed after preflight: ${path}`);
    this.touched.add(path);
  }

  private async assertSafeParent(logical: string): Promise<void> {
    const parent = dirname(this.path(logical));
    const relativeParent = relative(this.root, parent);
    let current = this.root;
    for (const segment of relativeParent.split("/").filter(Boolean)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new BeforeMutationError(`unsafe destination parent: ${logical}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    const existing = await realpath(parent).catch(() => null);
    if (!existing || existing !== parent) throw new BeforeMutationError(`destination parent is missing or resolves unexpectedly: ${logical}`);
  }

  private async backup(operation: SetupOperation): Promise<void> {
    if (operation.rollback.kind !== "restore-backup") return;
    const destination = this.path(operation.rollback.backupPath);
    await this.assertSafeParent(operation.rollback.backupPath);
    try {
      const { bytes: existing } = await readBoundedRegular(destination, 16 * 1024 * 1024, "existing backup is not a bounded stable regular file");
      if (sha256(existing) !== operation.rollback.sourceSha256 || !this.backupMetadata.has(operation.rollback.backupPath)) {
        throw new Error(`existing backup does not match reviewed source for ${operation.id}`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const source = await open(this.path(operation.target), constants.O_RDONLY | constants.O_NOFOLLOW);
    let sourceInfo: Stats;
    let sourceBytes: Buffer;
    try {
      const bounded = await readBoundedHandle(source, 16 * 1024 * 1024, `backup source is not a bounded stable regular file for ${operation.id}`);
      sourceInfo = bounded.info;
      sourceBytes = bounded.bytes;
    } finally {
      await source.close();
    }
    if (sha256(sourceBytes) !== operation.rollback.sourceSha256) throw new Error(`backup source changed for ${operation.id}`);
    this.backupMetadata.set(operation.rollback.backupPath, { mode: sourceInfo.mode & 0o777, uid: sourceInfo.uid, gid: sourceInfo.gid });
    await this.saveJournal();
    try { await writeFileExclusive(destination, sourceBytes, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await syncDirectory(dirname(destination));
    const hash = sha256(await readFile(destination));
    if (hash !== operation.rollback.sourceSha256) throw new Error(`backup hash mismatch for ${operation.id}`);
  }

  private async identity(owner: string, group: string): Promise<{ uid: number; gid: number }> {
    const configured = this.options.identities?.[owner];
    if (configured) return configured;
    if (owner === "root" && group === "root") return { uid: 0, gid: 0 };
    const uid = Number((await runFile("/usr/bin/id", ["-u", owner], { encoding: "utf8", timeout: 10_000 })).stdout.trim());
    const groupEntry = (await runFile("/usr/bin/getent", ["group", group], { encoding: "utf8", timeout: 10_000 })).stdout.trim();
    const gid = Number(groupEntry.split(":")[2]);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) throw new Error("unable to resolve reviewed file ownership");
    return { uid, gid };
  }

  private async installedAppConfig(): Promise<AppConfig> {
    if (!this.validated) throw new Error("validated apply state is unavailable");
    const expected = this.validated.files.get("app-config");
    if (!expected) throw new Error("reviewed app config payload is unavailable");
    const path = this.path("/etc/pi-together/config.json");
    const installed = await readBoundedRegular(path, 1024 * 1024, "installed app config is not a bounded stable regular file");
    const owner = await this.identity(this.validated.plan.invokingUser.username, this.validated.plan.invokingUser.group);
    if (!installed.bytes.equals(expected) || (installed.info.mode & 0o777) !== 0o600
      || installed.info.uid !== owner.uid || installed.info.gid !== owner.gid) {
      throw new Error("installed app config changed before activation");
    }
    return parseConfig(JSON.parse(installed.bytes.toString("utf8")));
  }

  private async atomicWrite(operation: SetupOperation & { mode: string; owner?: string; group?: string }, payload: Buffer): Promise<void> {
    await this.recheckFirstTouch(operation.target);
    await this.assertSafeParent(operation.target);
    await this.backup(operation);
    const target = this.path(operation.target);
    const temporary = join(dirname(target), `.pi-together-${process.pid}-${operation.id}.tmp`);
    await this.trackTemporary(temporary, true);
    try {
      const handle = await open(temporary, "wx", Number.parseInt(operation.mode, 8));
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, Number.parseInt(operation.mode, 8));
      if (operation.owner && operation.group) {
        const { uid, gid } = await this.identity(operation.owner, operation.group);
        await chown(temporary, uid, gid);
      }
      await rename(temporary, target);
      await syncDirectory(dirname(target));
      await this.trackTemporary(temporary, false);
    } catch (error) {
      await rm(temporary, { force: true });
      await this.trackTemporary(temporary, false);
      throw error;
    }
  }

  private journalPath(digest: string): string {
    return this.path(`/var/tmp/pi-together-apply-${digest}.json`);
  }

  private async saveJournal(): Promise<void> {
    if (!this.journal) return;
    this.journal.backupMetadata = Object.fromEntries(this.backupMetadata);
    this.journal.packagesInstalledByApply = [...this.packagesInstalledByApply].sort();
    const path = this.journalPath(this.journal.planDigest);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFileExclusive(temp, Buffer.from(`${JSON.stringify(this.journal)}\n`), 0o600);
    const { uid, gid } = await this.identity("root", "root");
    await chown(temp, uid, gid);
    await rename(temp, path);
    await syncDirectory(dirname(path));
  }

  async recoverPending(): Promise<void> {
    let names: string[] = [];
    try { names = await readdir(this.path("/var/tmp")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (names.length > 100_000) throw new Error("apply recovery journal inventory is unexpectedly large");
    for (const name of names.filter((value) => /^pi-together-apply-[a-f0-9]{64}\.json$/.test(value)).sort()) {
      const path = this.path(`/var/tmp/${name}`);
      const rootIdentity = await this.identity("root", "root");
      const journal = await readBoundedRegular(path, 1024 * 1024, "apply recovery journal is not a bounded stable regular file");
      if ((journal.info.mode & 0o777) !== 0o600 || journal.info.uid !== rootIdentity.uid || journal.info.gid !== rootIdentity.gid) {
        throw new Error("unsafe apply recovery journal");
      }
      const value = JSON.parse(journal.bytes.toString("utf8")) as { plan?: unknown; planDigest?: unknown };
      const plan = SetupPlanSchema.parse(value.plan);
      if (value.planDigest !== plan.planDigest || name !== `pi-together-apply-${plan.planDigest}.json`) {
        throw new Error("apply recovery journal plan does not match its path");
      }
      await this.recover({ plan, files: new Map(), secrets: new Map(), runtimeExecutables: new Set() });
    }
  }

  async recover(validated: ValidatedApply): Promise<void> {
    const requireRoot = this.options.requireRoot ?? true;
    const sudoUid = this.options.sudoUid ?? Number(process.env.SUDO_UID);
    if ((requireRoot || this.options.sudoUid !== undefined) && sudoUid !== validated.plan.invokingUser.uid) {
      throw new Error("apply invoking identity does not match sudo provenance");
    }
    const invokingIdentity = await this.identity(validated.plan.invokingUser.username, validated.plan.invokingUser.group);
    if (invokingIdentity.uid !== validated.plan.invokingUser.uid || invokingIdentity.uid === 0) {
      throw new Error("invoking user identity changed or is not eligible for service ownership");
    }
    this.backupMetadata.clear();
    this.packagesInstalledByApply.clear();
    const path = this.journalPath(validated.plan.planDigest);
    let data: Buffer;
    try {
      const info = await lstat(path);
      const rootIdentity = await this.identity("root", "root");
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o777) !== 0o600 || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid) {
        throw new Error("unsafe apply recovery journal");
      }
      data = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(data.toString("utf8")) as typeof this.journal;
    if (!parsed || parsed.schemaVersion !== 1 || parsed.planDigest !== validated.plan.planDigest
      || SetupPlanSchema.parse(parsed.plan).planDigest !== validated.plan.planDigest || !Array.isArray(parsed.completed)
      || !parsed.completed.every((id) => typeof id === "string" && /^[a-z0-9-]+$/.test(id))
      || (parsed.inFlight !== undefined && (typeof parsed.inFlight !== "string" || !/^[a-z0-9-]+$/.test(parsed.inFlight)))
      || !Array.isArray(parsed.packagesInstalledByApply) || parsed.packagesInstalledByApply.some((name) => !["nginx", "certbot"].includes(name))
      || !Array.isArray(parsed.temporaryPaths) || parsed.temporaryPaths.some((path) => typeof path !== "string")
      || !parsed.backupMetadata || typeof parsed.backupMetadata !== "object") {
      throw new Error("apply recovery journal does not match the reviewed plan");
    }
    this.validated = validated;
    this.journal = parsed;
    for (const [key, metadata] of Object.entries(parsed.backupMetadata)) {
      if (!key.startsWith("/var/lib/pi-together/backups/setup/") || !Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o7777
        || !Number.isInteger(metadata.uid) || metadata.uid < 0 || !Number.isInteger(metadata.gid) || metadata.gid < 0) {
        throw new Error("apply recovery journal contains invalid backup metadata");
      }
      this.backupMetadata.set(key, metadata);
    }
    for (const name of parsed.packagesInstalledByApply ?? []) this.packagesInstalledByApply.add(name);
    for (const temporary of parsed.temporaryPaths ?? []) {
      const insideRoot = this.root === "/" ? temporary.startsWith("/") : temporary.startsWith(`${this.root}/`);
      if (!insideRoot || !basename(temporary).startsWith(".pi-together-")) {
        throw new Error("apply recovery journal contains an unsafe temporary path");
      }
      await rm(temporary, { recursive: true, force: true });
    }
    await rm(this.path("/var/lib/pi-together/extract-oauth2-proxy"), { recursive: true, force: true });
    const ids = [...new Set([...(parsed.inFlight ? [parsed.inFlight] : []), ...parsed.completed.slice().reverse()])];
    const operations = new Map(validated.plan.operations.map((operation) => [operation.id, operation]));
    for (const id of ids) {
      const operation = operations.get(id);
      if (!operation) throw new Error("apply recovery journal contains an unknown operation");
      await this.rollback(operation);
    }
    if (this.nginxReloadNeededOnAbort) {
      await this.command("/usr/sbin/nginx", ["-t"]);
      await this.command("/bin/systemctl", ["reload", "nginx.service"]);
      this.nginxReloadNeededOnAbort = false;
    }
    if (!this.daemonReloaded) {
      await this.command("/bin/systemctl", ["daemon-reload"]);
      this.daemonReloaded = true;
    }
    await this.clearJournal(validated.plan.planDigest);
    this.journal = undefined;
    this.touched.clear();
  }

  private async clearJournal(digest: string): Promise<void> {
    const path = this.journalPath(digest);
    await rm(path, { force: true });
    await syncDirectory(dirname(path));
  }

  private async trackTemporary(path: string, present: boolean): Promise<void> {
    if (!this.journal) return;
    const paths = new Set(this.journal.temporaryPaths);
    if (present) paths.add(path); else paths.delete(path);
    this.journal.temporaryPaths = [...paths].sort();
    await this.saveJournal();
  }

  private async packageInstalled(name: string): Promise<boolean> {
    if (this.options.installedPackages) return this.options.installedPackages.has(name);
    try {
      const result = await runFile("/usr/bin/dpkg-query", ["-W", "-f=${Status}", name], { encoding: "utf8", timeout: 10_000 });
      return result.stdout.trim() === "install ok installed";
    } catch {
      return false;
    }
  }

  private async restoreBackup(operation: SetupOperation & { rollback: { kind: "restore-backup"; backupPath: string; sourceSha256: string } }, bytes: Buffer): Promise<void> {
    const metadata = this.backupMetadata.get(operation.rollback.backupPath);
    if (!metadata) throw new Error("rollback backup metadata is unavailable");
    const target = this.path(operation.target);
    await this.assertSafeParent(operation.target);
    const temporary = join(dirname(target), `.pi-together-rollback-${process.pid}-${operation.id}.tmp`);
    await this.trackTemporary(temporary, true);
    await writeFileExclusive(temporary, bytes, metadata.mode);
    await chmod(temporary, metadata.mode);
    await chown(temporary, metadata.uid, metadata.gid);
    await rename(temporary, target);
    await syncDirectory(dirname(target));
    await this.trackTemporary(temporary, false);
  }

  private async verifyIssuedCertificate(domain: string): Promise<void> {
    const rootIdentity = await this.identity("root", "root");
    const archiveRoot = this.path(`/etc/letsencrypt/archive/${domain}`);
    for (const [name, privateKey] of [["fullchain.pem", false], ["privkey.pem", true]] as const) {
      const logical = this.path(`/etc/letsencrypt/live/${domain}/${name}`);
      const link = await lstat(logical);
      if (!link.isSymbolicLink() || link.uid !== rootIdentity.uid || link.gid !== rootIdentity.gid) throw new Error("issued certificate link metadata is unsafe");
      const resolved = await realpath(logical);
      if (!resolved.startsWith(`${archiveRoot}/`)) throw new Error("issued certificate link escapes its lineage archive");
      const info = await lstat(resolved);
      if (!info.isFile() || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid
        || (info.mode & (privateKey ? 0o077 : 0o022)) !== 0) throw new Error("issued certificate file metadata is unsafe");
    }
    const renewal = this.path(`/etc/letsencrypt/renewal/${domain}.conf`);
    const renewalInfo = await lstat(renewal);
    if (!renewalInfo.isFile() || renewalInfo.isSymbolicLink() || renewalInfo.uid !== rootIdentity.uid || renewalInfo.gid !== rootIdentity.gid
      || (renewalInfo.mode & 0o022) !== 0) throw new Error("Certbot renewal metadata is unsafe");
    const fullchain = this.path(`/etc/letsencrypt/live/${domain}/fullchain.pem`);
    await this.command("/usr/bin/openssl", ["x509", "-in", fullchain, "-noout", "-checkend", "86400"]);
    await this.command("/usr/bin/openssl", ["x509", "-in", fullchain, "-noout", "-checkhost", domain]);
  }

  private async boundedDownload(url: string): Promise<Buffer> {
    const response = await this.fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`pinned artifact download failed with HTTP ${response.status}`);
    const maximum = 100 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximum) { await reader.cancel(); throw new Error("pinned artifact exceeds size limit"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  }

  async prepare(validated: ValidatedApply): Promise<void> {
    this.validated = validated;
    this.reviewedArtifacts.clear();
    const invokingIdentity = await this.identity(validated.plan.invokingUser.username, validated.plan.invokingUser.group);
    if (invokingIdentity.uid !== validated.plan.invokingUser.uid || invokingIdentity.uid === 0) {
      throw new Error("invoking user identity changed or is not eligible for service ownership");
    }
    const release = validated.plan.operations.find((operation) => operation.kind === "copy-release");
    if (!release || release.kind !== "copy-release") throw new Error("release operation is missing");
    const { bytes: manifest } = await readBoundedRegular(join(this.options.packageRoot, "dist/release/manifest.json"), 4 * 1024 * 1024, "packaged release manifest is not a bounded stable regular file");
    if (sha256(manifest) !== release.manifestSha256) throw new Error("packaged release manifest hash mismatch");
    this.reviewedArtifacts.set("release/manifest.json", release.manifestSha256);
    const parsed = JSON.parse(manifest.toString("utf8")) as { package?: { name?: string; version?: string }; artifacts?: Array<{ path: string; bytes: number; sha256: string }> };
    if (parsed.package?.name !== "pi-together" || parsed.package.version !== validated.plan.producer.version || !Array.isArray(parsed.artifacts)
      || parsed.artifacts.length > 10_000) {
      throw new Error("packaged release manifest is invalid");
    }
    const reviewedPaths = new Set<string>();
    let totalArtifactBytes = 0;
    for (const artifact of parsed.artifacts) {
      if (!artifact.path.startsWith("dist/") || artifact.path.includes("..") || artifact.path.includes("\\") || artifact.path.includes("//")
        || !/^[A-Za-z0-9._/-]+$/.test(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 64 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new Error("release artifact metadata is invalid");
      }
      totalArtifactBytes += artifact.bytes;
      if (totalArtifactBytes > 256 * 1024 * 1024) throw new Error("release artifacts exceed total size limit");
      if (reviewedPaths.has(artifact.path)) throw new Error("duplicate release artifact metadata");
      reviewedPaths.add(artifact.path);
      this.reviewedArtifacts.set(artifact.path.slice("dist/".length), artifact.sha256);
      const { bytes } = await readBoundedRegular(join(this.options.packageRoot, artifact.path), 64 * 1024 * 1024, "packaged release artifact is not a bounded stable regular file");
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error("packaged release artifact hash mismatch");
    }
    const { bytes: sums } = await readBoundedRegular(join(this.options.packageRoot, "dist/release/SHA256SUMS"), 4 * 1024 * 1024, "packaged release checksums are not a bounded stable regular file");
    const expectedSums = `${parsed.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`;
    if (sums.toString("utf8") !== expectedSums) throw new Error("packaged release checksum inventory mismatch");
    this.reviewedArtifacts.set("release/SHA256SUMS", sha256(sums));
    const distRoot = join(this.options.packageRoot, "dist");
    const actualTree = await inspectBoundedTree(distRoot, "packaged release");
    const expectedPackagePaths = new Set([...reviewedPaths, "dist/release/manifest.json", "dist/release/SHA256SUMS"]);
    const expectedPackageDirectories = reviewedDirectoryPaths(expectedPackagePaths);
    for (const path of actualTree.files) {
      const logical = relative(this.options.packageRoot, path).replaceAll("\\", "/");
      if (!expectedPackagePaths.has(logical)) throw new Error("packaged release contains an unreviewed artifact");
    }
    for (const path of actualTree.directories) {
      const logical = relative(this.options.packageRoot, path).replaceAll("\\", "/");
      if (!expectedPackageDirectories.has(logical)) throw new Error("packaged release contains an unreviewed artifact directory");
    }
    this.journal = {
      schemaVersion: 1,
      planDigest: validated.plan.planDigest,
      plan: validated.plan,
      completed: [],
      backupMetadata: {},
        packagesInstalledByApply: [],
      temporaryPaths: [],
    };
    await this.saveJournal();
  }

  async execute(operation: SetupOperation, payload?: Buffer): Promise<void> {
    if (!this.journal) throw new Error("apply journal is not initialized");
    this.journal.inFlight = operation.id;
    await this.saveJournal();
    try {
      switch (operation.kind) {
      case "ensure-directory": {
        await this.recheckFirstTouch(operation.target);
        const target = this.path(operation.target);
        await this.assertSafeParent(operation.target);
        let created = false;
        try {
          await mkdir(target, { recursive: false, mode: Number.parseInt(operation.mode, 8) });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const { uid, gid } = await this.identity(operation.owner, operation.group);
        if (created) {
          try {
            await chmod(target, Number.parseInt(operation.mode, 8));
            await chown(target, uid, gid);
          } catch (error) {
            try { await rmdir(target); } catch { /* Preserve unexpected concurrent content for recovery. */ }
            throw error;
          }
        } else {
          const info = await lstat(target);
          if ((info.mode & 0o7777) !== Number.parseInt(operation.mode, 8) || info.uid !== uid || info.gid !== gid) {
            throw new Error(`existing directory permissions do not match reviewed plan: ${operation.target}`);
          }
        }
        break;
      }
      case "install-apt":
        await this.recheckFirstTouch(operation.target);
        for (const name of operation.packages) if (!await this.packageInstalled(name)) this.packagesInstalledByApply.add(name);
        await this.saveJournal();
        await this.command("/usr/bin/apt-get", ["update"]);
        await this.command("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", ...operation.packages]);
        break;
      case "copy-release": {
        await this.recheckFirstTouch(operation.target);
        await this.assertSafeParent(operation.target);
        try {
          const destination = this.path(operation.target);
          await cp(join(this.options.packageRoot, "dist"), destination, { recursive: true, errorOnExist: true, force: false });
          const copiedTree = await inspectBoundedTree(destination, "packaged release");
          const copied = copiedTree.files;
          const reviewedDirectories = reviewedDirectoryPaths(this.reviewedArtifacts.keys());
          for (const directory of copiedTree.directories) {
            const logical = relative(destination, directory).replaceAll("\\", "/");
            if (logical && !reviewedDirectories.has(logical)) throw new Error("copied release contains an unreviewed artifact directory");
          }
          const executableArtifacts = new Set(["cli/pi-together.js", "privileged/apply.js", "extension/git-bin/git"]);
          const rootIdentity = await this.identity("root", "root");
          for (const path of copied) {
            const logical = relative(destination, path).replaceAll("\\", "/");
            await chown(path, rootIdentity.uid, rootIdentity.gid);
            await chmod(path, executableArtifacts.has(logical) ? 0o755 : 0o644);
            const expected = this.reviewedArtifacts.get(logical);
            if (!expected || sha256(await readFile(path)) !== expected) throw new Error("copied release failed manifest verification");
          }
          if ([...this.reviewedArtifacts].some(([path]) => !copied.some((file) => relative(destination, file).replaceAll("\\", "/") === path))) {
            throw new Error("copied release is missing a reviewed artifact");
          }
          for (const file of copied) await syncFile(file);
          for (const directory of copiedTree.directories.sort((a, b) => b.length - a.length)) {
            await chown(directory, rootIdentity.uid, rootIdentity.gid);
            await chmod(directory, 0o755);
            await syncDirectory(directory);
          }
          await syncDirectory(dirname(destination));
        } catch (error) {
          await rm(this.path(operation.target), { recursive: true, force: true });
          await syncDirectory(dirname(this.path(operation.target)));
          throw error;
        }
        break;
      }
      case "symlink": {
        await this.recheckFirstTouch(operation.target);
        await this.assertSafeParent(operation.target);
        await this.backup(operation);
        const target = this.path(operation.target);
        const temp = `${target}.pi-together-${process.pid}`;
        await this.trackTemporary(temp, true);
        try {
          await symlink(operation.linkTarget, temp);
          const { uid, gid } = await this.identity("root", "root");
          await lchown(temp, uid, gid);
          await rename(temp, target);
          await syncDirectory(dirname(target));
          await this.trackTemporary(temp, false);
        } catch (error) {
          await rm(temp, { force: true });
          await this.trackTemporary(temp, false);
          throw error;
        }
        break;
      }
      case "download": {
        const bytes = await this.boundedDownload(operation.url);
        if (sha256(bytes) !== operation.expectedSha256) throw new Error(`download checksum mismatch for ${operation.id}`);
        await this.atomicWrite(operation, bytes);
        break;
      }
      case "extract-oauth2-proxy": {
        await this.recheckFirstTouch(operation.target);
        const archive = this.path(operation.archive);
        if (sha256(await readFile(archive)) !== operation.archiveSha256) throw new Error("oauth2-proxy archive changed before extraction");
        const extraction = this.path("/var/lib/pi-together/extract-oauth2-proxy");
        await rm(extraction, { recursive: true, force: true });
        await mkdir(extraction, { recursive: true, mode: 0o700 });
        try {
          await this.command("/bin/tar", ["-xzf", archive, "-C", extraction, "--no-same-owner", "--no-same-permissions"]);
          const candidates = (await inspectBoundedTree(extraction, "oauth2-proxy extraction")).files.filter((path) => basename(path) === "oauth2-proxy");
          if (candidates.length !== 1) throw new Error("oauth2-proxy archive layout is invalid");
          await this.atomicWrite(operation, await readFile(candidates[0]!));
        } finally {
          await rm(extraction, { recursive: true, force: true });
        }
        break;
      }
      case "write-file":
      case "write-secret-file":
        if (!payload) throw new Error(`resolved payload is missing for ${operation.id}`);
        await this.atomicWrite(operation, payload);
        if (operation.kind === "write-file" && operation.target.startsWith("/etc/systemd/system/") && operation.target.endsWith(".service")) {
          this.daemonReloaded = false;
        }
        break;
      case "certificate":
        await this.recheckFirstTouch(operation.target);
        await this.command("/usr/bin/certbot", certbotArguments(operation, this.path(operation.webroot)));
        await this.verifyIssuedCertificate(operation.domain);
        break;
      case "reuse-certificate":
        await this.recheckFirstTouch(operation.target);
        if ((await inspectCertificateLineage(operation.domain, { root: this.root, rootIdentity: await this.identity("root", "root") })).status !== "existing") throw new Error("reviewed certificate lineage is no longer available");
        break;
      case "service": {
        if (operation.id === "app-service-action") {
          await this.installedAppConfig();
          await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together.service")]);
        } else if (operation.id === "oauth-service-action") {
          await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together-oauth2-proxy.service")]);
        } else if (operation.id === "funnel-edge-service-action") {
          await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together-edge.service")]);
        } else if (operation.id === "nginx-challenge-action" || operation.id === "nginx-final-reload") {
          await this.command("/usr/sbin/nginx", ["-t"]);
        } else if (operation.id === "certbot-renewal-action" && (operation.unit !== "certbot.timer" || operation.action !== "enable-start")) {
          throw new Error("invalid Certbot timer activation");
        }
        if (!this.daemonReloaded) {
          await this.command("/bin/systemctl", ["daemon-reload"]);
          this.daemonReloaded = true;
        }
        if (operation.id === "app-service-action") await this.installedAppConfig();
        const verb = operation.action === "enable-start" ? "enable" : operation.action;
        if (operation.action === "enable-start") await this.command("/bin/systemctl", [verb, "--now", operation.unit]);
        else await this.command("/bin/systemctl", [verb, operation.unit]);
        break;
      }
      }
    } catch (error) {
      if (error instanceof BeforeMutationError) {
        if (this.journal.inFlight === operation.id) delete this.journal.inFlight;
        await this.saveJournal();
      } else {
        try { await this.rollback(operation); } catch { /* Recovery journal remains available for the next invocation. */ }
      }
      throw error;
    }
    this.journal.completed.push(operation.id);
    delete this.journal.inFlight;
    await this.saveJournal();
  }

  async rollback(operation: SetupOperation): Promise<void> {
    switch (operation.rollback.kind) {
      case "remove-created":
        if (operation.kind === "ensure-directory") {
          try { await rmdir(this.path(operation.target)); }
          catch (error) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        } else {
          await rm(this.path(operation.target), { recursive: operation.kind === "copy-release", force: true });
        }
        await syncDirectory(dirname(this.path(operation.target)));
        break;
      case "restore-backup": {
        const backup = this.path(operation.rollback.backupPath);
        let bytes: Buffer;
        try { bytes = await readFile(backup); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
        if (sha256(bytes) !== operation.rollback.sourceSha256) throw new Error("rollback backup changed");
        await this.restoreBackup(operation as SetupOperation & { rollback: { kind: "restore-backup"; backupPath: string; sourceSha256: string } }, bytes);
        const restored = await readBoundedRegular(this.path(operation.target), 16 * 1024 * 1024, "restored target is not a bounded stable regular file");
        if (sha256(restored.bytes) !== operation.rollback.sourceSha256) throw new Error("restored target failed durable read-back");
        await rm(backup);
        await syncDirectory(dirname(backup));
        this.backupMetadata.delete(operation.rollback.backupPath);
        break;
      }
      case "service-action":
        if (operation.rollback.action !== "none" && operation.kind === "service") {
          if (operation.rollback.action === "reload" && operation.unit === "nginx.service") {
            const challenge = this.validated?.plan.operations.find((candidate) => candidate.id === "nginx-challenge-action");
            if (challenge?.kind !== "service" || challenge.action !== "start") this.nginxReloadNeededOnAbort = true;
          }
          else if (operation.rollback.action === "disable-stop") await this.command("/bin/systemctl", ["disable", "--now", operation.unit]);
          else await this.command("/bin/systemctl", [operation.rollback.action, operation.unit]);
        }
        break;
      case "delete-certificate":
        if ((await this.inspect(operation.target)).kind !== "absent") {
          await this.command("/usr/bin/certbot", ["delete", "--non-interactive", "--cert-name", operation.rollback.domain]);
        }
        break;
      case "remove-installed-packages": {
        const packages: string[] = [];
        for (const name of operation.rollback.packages) {
          if (this.packagesInstalledByApply.has(name) && await this.packageInstalled(name)) packages.push(name);
        }
        if (packages.length) await this.command("/usr/bin/apt-get", ["remove", "--yes", ...packages]);
        break;
      }
      case "none":
        break;
    }
    if (operation.kind === "write-file" && operation.target.startsWith("/etc/systemd/system/") && operation.target.endsWith(".service")) {
      this.daemonReloaded = false;
    }
    if (this.journal) {
      this.journal.completed = this.journal.completed.filter((id) => id !== operation.id);
      if (this.journal.inFlight === operation.id) delete this.journal.inFlight;
      await this.saveJournal();
    }
  }

  async abort(validated: ValidatedApply): Promise<void> {
    if (this.journal?.inFlight) throw new Error("cannot clear a recovery journal with an unresolved in-flight operation");
    if (this.nginxReloadNeededOnAbort) {
      await this.command("/usr/sbin/nginx", ["-t"]);
      await this.command("/bin/systemctl", ["reload", "nginx.service"]);
      this.nginxReloadNeededOnAbort = false;
    }
    if (!this.daemonReloaded) {
      await this.command("/bin/systemctl", ["daemon-reload"]);
      this.daemonReloaded = true;
    }
    await this.clearJournal(validated.plan.planDigest);
    this.journal = undefined;
  }

  private async verifyHealth(config: AppConfig): Promise<void> {
    if (this.options.health) return this.options.health(config);
    if (this.root === "/") await verifyPrivateHealth(config, (logical) => this.path(logical), "installed private health");
  }

  async verify(validated: ValidatedApply): Promise<void> {
    const config = await this.installedAppConfig();
    await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together.service")]);
    const serviceActions = validated.plan.operations.filter((operation): operation is Extract<SetupOperation, { kind: "service" }> =>
      operation.kind === "service" && operation.unit.startsWith("pi-together"));
    for (const action of serviceActions) {
      if (action.action === "enable" || action.action === "enable-start") {
        await this.command("/bin/systemctl", ["is-enabled", action.unit]);
      }
      if (action.action === "start" || action.action === "enable-start") {
        await this.command("/bin/systemctl", ["is-active", action.unit]);
      }
    }
    const appAction = serviceActions.find((operation) => operation.id === "app-service-action");
    if (appAction && (appAction.action === "start" || appAction.action === "enable-start")) await this.verifyHealth(config);
    if (validated.plan.mode !== "local") {
      await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together-oauth2-proxy.service")]);
      if (validated.plan.mode === "reverse-proxy") {
        await this.command("/usr/sbin/nginx", ["-t"]);
        await this.command("/bin/systemctl", ["is-enabled", "certbot.timer"]);
        await this.command("/bin/systemctl", ["is-active", "certbot.timer"]);
      } else {
        if (config.mode !== "tailscale-funnel") throw new Error("installed app config mode changed before Funnel verification");
        const tailscale = await runFile("/usr/bin/tailscale", ["status", "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
        const status = JSON.parse(tailscale.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
        const expectedDns = new URL(config.publicOrigin).hostname;
        if (status.BackendState !== "Running" || typeof status.Self?.DNSName !== "string" || status.Self.DNSName.replace(/\.$/, "").toLowerCase() !== expectedDns) throw new Error("Tailscale node identity changed before activation");
        await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together-edge.service")]);
        await this.command("/usr/bin/systemd-analyze", ["verify", this.path("/etc/systemd/system/pi-together-funnel.service")]);
      }
    }
  }

  async finish(validated: ValidatedApply): Promise<void> {
    await this.abort(validated);
  }
}
