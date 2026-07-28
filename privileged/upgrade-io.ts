import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, chown, cp, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseConfig, type AppConfig } from "../server/config.js";
import { InstallManifestSchema, buildInstallManifest, renderInstallManifest, type InstallManifest } from "../cli/install-manifest.js";
import type { UpgradeRequest } from "./upgrade-request.js";
import { candidateRelease, type SignedRelease, type UpgradeIo } from "../cli/upgrade-core.js";
import { UpgradeReleaseIdSchema } from "../cli/release-identity.js";
import { resolvePrivilegedPath } from "./root-path.js";
import { readBoundedHandle, readBoundedRegular } from "./bounded-file.js";
import { verifyPrivateHealth } from "./private-health.js";

const exec = promisify(execFile);
interface Options { request: UpgradeRequest | Pick<UpgradeRequest, "invokingUid">; root?: string; command?: (file: string, args: string[]) => Promise<void>; health?: (config: AppConfig) => Promise<void>; requireRoot?: boolean; rootIdentity?: { uid: number; gid: number } }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export class RootUpgradeIo implements UpgradeIo {
  private readonly root: string;
  private readonly command: (file: string, args: string[]) => Promise<void>;
  private readonly rootIdentity: { uid: number; gid: number };
  private config?: AppConfig;
  private oldManifestBytes?: Buffer;
  private oldManifest?: InstallManifest;
  private displacedPreviousVersion?: string;
  private configBytes?: Buffer;
  constructor(private readonly options: Options) {
    this.root = resolve(options.root ?? "/");
    this.rootIdentity = options.rootIdentity ?? { uid: 0, gid: 0 };
    this.command = options.command ?? (async (file, args) => { await exec(file, args, { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } }); });
    if ((options.requireRoot ?? true) && process.getuid?.() !== 0) throw new Error("privileged upgrade must run as root");
    if ((options.requireRoot ?? true) && Number(process.env.SUDO_UID) !== options.request.invokingUid) throw new Error("upgrade invoking identity does not match sudo provenance");
  }
  private path(logical: string): string {
    return resolvePrivilegedPath(this.root, logical, "upgrade");
  }
  private fullRequest(): UpgradeRequest {
    if (!("candidate" in this.options.request) || !("archivePath" in this.options.request)) throw new Error("full upgrade request is unavailable during recovery");
    return this.options.request;
  }
  private journal(): string { return this.path("/var/lib/pi-together/upgrade-journal.json"); }
  private stageRoot(version: string): string { return this.path(`/var/lib/pi-together/upgrade-stage-${version}`); }
  private async atomicSymlink(target: string, logical: string): Promise<void> {
    const path = this.path(logical); const temporary = `${path}.${process.pid}.tmp`;
    await rm(temporary, { force: true }); await symlink(target, temporary); await rename(temporary, path);
  }
  private async readRootBackup(path: string): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid || info.size > 1024 * 1024) {
        throw new Error("upgrade recovery backup metadata is unsafe");
      }
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  private async writeOrVerifyBackup(path: string, bytes: Buffer): Promise<void> {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      const existing = await handle.readFile();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid || sha256(existing) !== sha256(bytes)) {
        throw new Error("existing upgrade backup does not match the reviewed source");
      }
    } finally { await handle.close(); }
  }
  private async replaceRootFile(logical: string, bytes: Buffer, mode: number, owner = this.rootIdentity): Promise<void> {
    const path = this.path(logical);
    const temporary = `${path}.${process.pid}.tmp`;
    await rm(temporary, { force: true });
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, mode);
    await chown(temporary, owner.uid, owner.gid);
    await rename(temporary, path);
  }
  async currentVersion(): Promise<string> {
    const current = this.path("/opt/pi-together/current");
    const info = await lstat(current);
    if (!info.isSymbolicLink() || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid) throw new Error("active release symlink metadata is unsafe");
    const target = await readlink(current);
    const prefix = "/opt/pi-together/releases/";
    if (!target.startsWith(prefix)) throw new Error("active release symlink is invalid");
    const release = UpgradeReleaseIdSchema.safeParse(target.slice(prefix.length));
    if (!release.success) throw new Error("active release symlink is invalid");
    return release.data;
  }
  private async recoverJournal(expectedTarget?: string): Promise<"clean" | "rolled-back"> {
    try {
      const handle = await open(this.journal(), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: { schemaVersion?: number; from?: string; to?: string; activated?: boolean };
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid || info.size > 1024 * 1024) throw new Error("unsafe upgrade recovery journal");
        value = JSON.parse(await handle.readFile("utf8")) as typeof value;
      } finally { await handle.close(); }
      if (value.schemaVersion !== 1 || !UpgradeReleaseIdSchema.safeParse(value.to).success
        || (expectedTarget !== undefined && value.to !== expectedTarget)
        || !UpgradeReleaseIdSchema.safeParse(value.from).success) throw new Error("upgrade recovery journal is invalid");
      if (value.activated) {
        const base = this.path(`/var/lib/pi-together/backups/upgrade-${value.from}-to-${value.to}`);
        this.configBytes = await this.readRootBackup(`${base}.config.json`);
        this.config = parseConfig(JSON.parse(this.configBytes.toString("utf8")));
        this.acceptCanonicalOldManifest(await this.readRootBackup(`${base}.manifest.json`), value.from!);
        await this.rollback(value.from!, value.to!);
      }
      else {
        const backup = this.path(`/var/lib/pi-together/backups/upgrade-${value.from}-to-${value.to}.config.json`);
        try {
          const oldConfig = await this.readRootBackup(backup);
          const current = await lstat(this.path("/etc/pi-together/config.json"));
          await this.replaceRootFile("/etc/pi-together/config.json", oldConfig, 0o600, { uid: this.options.request.invokingUid, gid: current.gid });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rm(this.stageRoot(value.to!), { recursive: true, force: true });
        await rm(this.path(`/opt/pi-together/releases/${value.to}`), { recursive: true, force: true });
        await rm(this.journal(), { force: true });
      }
      return "rolled-back";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "clean";
      throw error;
    }
  }
  async recover(candidate: SignedRelease): Promise<"clean" | "rolled-back"> {
    return this.recoverJournal(candidateRelease(candidate));
  }

  async recoverPending(): Promise<"clean" | "rolled-back"> {
    return this.recoverJournal();
  }

  private previousVersion(manifest: InstallManifest): string | undefined {
    return manifest.entries.find((entry) => entry.kind === "directory" && entry.path.startsWith("/opt/pi-together/releases/") && !entry.path.endsWith(`/${manifest.version}`))?.path.split("/").at(-1);
  }
  private acceptCanonicalOldManifest(bytes: Buffer, expectedVersion: string): InstallManifest {
    const manifest = InstallManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const archive = manifest.entries.find((entry) => entry.path.startsWith("/var/lib/pi-together/downloads/oauth2-proxy-v"))?.path;
    const previous = this.previousVersion(manifest);
    const hasPreviousLink = manifest.entries.some((entry) => entry.path === "/opt/pi-together/previous");
    if (manifest.version !== expectedVersion || hasPreviousLink !== !!previous
      || renderInstallManifest(buildInstallManifest(manifest.mode, manifest.version, archive, previous)) !== bytes.toString("utf8")) {
      throw new Error("upgrade inventory is not canonical");
    }
    this.oldManifestBytes = bytes;
    this.oldManifest = manifest;
    this.displacedPreviousVersion = previous;
    return manifest;
  }
  private async filesUnder(root: string): Promise<string[]> {
    const files: string[] = [];
    let entries = 0;
    let bytes = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name); const info = await lstat(path);
        entries++;
        bytes += info.size;
        if (entries > 10_000 || bytes > 256 * 1024 * 1024 || info.isSymbolicLink() || info.uid !== this.rootIdentity.uid || (info.mode & 0o022) !== 0) {
          throw new Error("upgrade tree ownership, mode, type, or size is unsafe");
        }
        if (info.isDirectory()) await walk(path); else if (info.isFile()) files.push(path); else throw new Error("upgrade package contains an unsupported type");
      }
    };
    await walk(root); return files.sort();
  }
  async stage(candidate: SignedRelease): Promise<void> {
    const archive = this.fullRequest().archivePath;
    const { bytes, info } = await readBoundedRegular(archive, 256 * 1024 * 1024, "signed upgrade archive is not a bounded stable regular file");
    if (info.uid !== this.options.request.invokingUid || sha256(bytes) !== candidate.metadata.packageSha256) {
      throw new Error("signed upgrade archive failed root-side verification");
    }
    const from = await this.currentVersion();
    const target = candidateRelease(candidate);
    const journalHandle = await open(this.journal(), "wx", 0o600);
    try {
      await journalHandle.writeFile(`${JSON.stringify({ schemaVersion: 1, from, to: target, activated: false })}\n`);
      await journalHandle.sync();
    } finally { await journalHandle.close(); }
    const stage = this.stageRoot(target);
    await mkdir(stage, { mode: 0o700 });
    const stagedArchive = join(stage, "candidate.tgz");
    const stagedHandle = await open(stagedArchive, "wx", 0o600);
    try { await stagedHandle.writeFile(bytes); await stagedHandle.sync(); } finally { await stagedHandle.close(); }
    const tarEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    const listing = (await exec("/bin/tar", ["-tzf", stagedArchive], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: tarEnvironment })).stdout.trim().split("\n");
    const types = (await exec("/bin/tar", ["-tvzf", stagedArchive], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: tarEnvironment })).stdout.trim().split("\n");
    if (listing.length > 10_000 || listing.some((path) => !path.startsWith("package/") || path.includes("../") || path.includes("//")) || types.some((line) => !/^[d-]/.test(line))) {
      throw new Error("signed upgrade archive paths or types are unsafe");
    }
    await this.command("/bin/tar", ["-xzf", stagedArchive, "-C", stage, "--no-same-owner", "--no-same-permissions"]);
    const packageRoot = join(stage, "package");
    await this.filesUnder(packageRoot);
    const manifestBytes = await readFile(join(packageRoot, "dist/release/manifest.json"));
    if (sha256(manifestBytes) !== candidate.metadata.releaseManifestSha256) throw new Error("signed upgrade release manifest mismatch");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { package?: { version?: string }; artifacts?: Array<{ path: string; bytes: number; sha256: string }> };
    if (manifest.package?.version !== candidate.metadata.version || !Array.isArray(manifest.artifacts)) throw new Error("signed upgrade manifest is invalid");
    for (const artifact of manifest.artifacts) {
      if (!artifact.path.startsWith("dist/") || artifact.path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(artifact.path)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new Error("signed upgrade artifact metadata is invalid");
      }
      const artifactBytes = await readFile(join(packageRoot, artifact.path));
      if (artifactBytes.length !== artifact.bytes || sha256(artifactBytes) !== artifact.sha256) throw new Error("signed upgrade artifact mismatch");
    }
    const destination = this.path(`/opt/pi-together/releases/${target}`);
    try { await lstat(destination); throw new Error("immutable upgrade destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await cp(join(packageRoot, "dist"), destination, { recursive: true, errorOnExist: true, force: false });
  }
  async migrateConfig(fromVersion: string, toVersion: string): Promise<void> {
    const configPath = this.path("/etc/pi-together/config.json");
    const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let configGroup = -1;
    try {
      const bounded = await readBoundedHandle(handle, 1024 * 1024, "upgrade config is not a bounded stable regular file");
      if ((bounded.info.mode & 0o777) !== 0o600 || bounded.info.uid !== this.options.request.invokingUid) throw new Error("upgrade config metadata is unsafe");
      configGroup = bounded.info.gid;
      this.configBytes = bounded.bytes; this.config = parseConfig(JSON.parse(this.configBytes.toString("utf8")));
    } finally { await handle.close(); }
    const manifestHandle = await open(this.path("/var/lib/pi-together/install-manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await manifestHandle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o644 || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid || info.size > 1024 * 1024) throw new Error("upgrade inventory metadata is unsafe");
      this.acceptCanonicalOldManifest(await manifestHandle.readFile(), fromVersion);
    } finally { await manifestHandle.close(); }
    if (!this.configBytes || !this.oldManifestBytes) throw new Error("upgrade migration backup inputs are unavailable");
    const backup = this.path(`/var/lib/pi-together/backups/upgrade-${fromVersion}-to-${toVersion}`);
    await this.writeOrVerifyBackup(`${backup}.config.json`, this.configBytes);
    await this.writeOrVerifyBackup(`${backup}.manifest.json`, this.oldManifestBytes);
    const canonicalConfig = Buffer.from(`${JSON.stringify(this.config, null, 2)}\n`);
    if (!canonicalConfig.equals(this.configBytes)) {
      await this.replaceRootFile("/etc/pi-together/config.json", canonicalConfig, 0o600, { uid: this.options.request.invokingUid, gid: configGroup });
    }
  }
  async activate(fromVersion: string, toVersion: string): Promise<void> {
    if (!this.config || !this.oldManifestBytes || !this.oldManifest) throw new Error("upgrade migration was not prepared");
    await this.replaceRootFile("/var/lib/pi-together/upgrade-journal.json", Buffer.from(`${JSON.stringify({ schemaVersion: 1, from: fromVersion, to: toVersion, activated: true })}\n`), 0o600);
    await this.atomicSymlink(`/opt/pi-together/releases/${fromVersion}`, "/opt/pi-together/previous");
    await this.atomicSymlink(`/opt/pi-together/releases/${toVersion}`, "/opt/pi-together/current");
    const archive = this.oldManifest.entries.find((entry) => entry.path.startsWith("/var/lib/pi-together/downloads/oauth2-proxy-v"))?.path;
    await this.replaceRootFile("/var/lib/pi-together/install-manifest.json", Buffer.from(renderInstallManifest(buildInstallManifest(this.oldManifest.mode, toVersion, archive, fromVersion))), 0o644);
  }
  async restart(): Promise<void> {
    if (!this.config) throw new Error("upgrade restart config is unavailable");
    const publicServices = this.config.mode === "local" ? [] : ["pi-together-oauth2-proxy.service"];
    const funnelServices = this.config.mode === "tailscale-funnel"
      ? ["pi-together-edge.service", "pi-together-funnel.service"]
      : [];
    const stopOrder = [...funnelServices].reverse().concat("pi-together.service", ...publicServices);
    const resetOrder = ["pi-together.service", ...publicServices, ...funnelServices];
    await this.command("/bin/systemctl", ["stop", ...stopOrder]);
    await this.command("/bin/systemctl", ["reset-failed", ...resetOrder]);
    for (const service of publicServices) await this.command("/bin/systemctl", ["start", service]);
    await this.command("/bin/systemctl", ["start", "pi-together.service"]);
    for (const service of funnelServices) await this.command("/bin/systemctl", ["start", service]);
  }
  async health(): Promise<void> {
    if (!this.config) throw new Error("upgrade health config is unavailable");
    if (this.options.health) await this.options.health(this.config);
    else await verifyPrivateHealth(this.config, (logical) => this.path(logical), "upgraded private health");
    if (this.config.mode !== "local") {
      await this.command("/bin/systemctl", ["is-active", "--quiet", "pi-together-oauth2-proxy.service"]);
    }
    if (this.config.mode === "tailscale-funnel") {
      await this.command("/bin/systemctl", ["is-active", "--quiet", "pi-together-edge.service"]);
      await this.command("/bin/systemctl", ["is-active", "--quiet", "pi-together-funnel.service"]);
    }
  }
  async commit(): Promise<void> {
    if (this.displacedPreviousVersion) {
      const obsolete = this.path(`/opt/pi-together/releases/${this.displacedPreviousVersion}`);
      const info = await lstat(obsolete);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.rootIdentity.uid || (info.mode & 0o022) !== 0) throw new Error("obsolete rollback release is unsafe to remove");
      await this.filesUnder(obsolete);
      await rm(obsolete, { recursive: true });
    }
    await rm(this.stageRoot(candidateRelease(this.fullRequest().candidate)), { recursive: true, force: true });
    await rm(this.journal(), { force: true });
  }
  async rollback(fromVersion: string, toVersion: string): Promise<void> {
    await this.atomicSymlink(`/opt/pi-together/releases/${fromVersion}`, "/opt/pi-together/current");
    if (this.displacedPreviousVersion) await this.atomicSymlink(`/opt/pi-together/releases/${this.displacedPreviousVersion}`, "/opt/pi-together/previous");
    else await rm(this.path("/opt/pi-together/previous"), { force: true });
    if (this.oldManifestBytes) await this.replaceRootFile("/var/lib/pi-together/install-manifest.json", this.oldManifestBytes, 0o644);
    if (this.configBytes) {
      const info = await lstat(this.path("/etc/pi-together/config.json"));
      await this.replaceRootFile("/etc/pi-together/config.json", this.configBytes, 0o600, { uid: this.options.request.invokingUid, gid: info.gid });
      this.config = parseConfig(JSON.parse(this.configBytes.toString("utf8")));
    }
    await this.restart(); await this.health();
    await rm(this.path(`/opt/pi-together/releases/${toVersion}`), { recursive: true, force: true });
    await rm(this.stageRoot(toVersion), { recursive: true, force: true }); await rm(this.journal(), { force: true });
  }
}
