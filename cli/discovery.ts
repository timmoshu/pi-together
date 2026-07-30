import { execFile } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { arch, platform } from "node:process";
import { promisify } from "node:util";
import { resolve4, resolve6 } from "node:dns/promises";
import { availableLoopbackPort, LOCAL_LISTENER_PORTS } from "../shared/local-listener.js";
import { PI_COMPATIBILITY, PI_PACKAGE_SPEC, supportsPiVersion } from "./pi-version.js";

export type CheckStatus = "pass" | "warn" | "fail";
export interface DiscoveryCheck { id: string; status: CheckStatus; summary: string; detail?: string }
export interface DiscoveryFacts {
  observedAt: string;
  platform: string;
  distro: { id: string; version: string };
  arch: string;
  node: { path: string; version: string };
  user: { uid?: number; username: string; group: string };
  piPath?: string;
  nginxPath?: string;
  occupiedPorts: number[];
  localPort?: number;
  sharedRepositoryFolders: Record<string, string>;
  existingInstall: boolean;
}
export interface DiscoveryReport { schemaVersion: 1; checks: DiscoveryCheck[]; facts: DiscoveryFacts; safeToPlan: boolean }
export interface PiPrerequisite {
  status: "ready" | "missing" | "unsupported" | "no-models" | "probe-failed";
  piPath?: string;
  version?: string;
  modelCount?: number;
}
export const PI_INSTALL_COMMAND = `npm install --global --prefix "$HOME/.local" --ignore-scripts ${PI_PACKAGE_SPEC}`;

export interface ProbeIo {
  platform(): string;
  arch(): string;
  nodePath: string;
  nodeVersion: string;
  uid(): number | undefined;
  username: string;
  piBin?: string;
  now(): number;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  exec(file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  dns(domain: string): Promise<string[]>;
  availableLoopbackPort(ports: readonly number[]): Promise<number | undefined>;
}

const exec = promisify(execFile);

export const nodeProbeIo: ProbeIo = {
  platform: () => platform,
  arch: () => arch,
  nodePath: process.execPath,
  nodeVersion: process.version,
  uid: () => process.getuid?.(),
  username: process.env.USER ?? "unknown",
  piBin: process.env.PI_BIN,
  now: Date.now,
  read: (path) => readFile(path, "utf8"),
  exists: async (path) => access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT" && error.code !== "ENOTDIR",
  ),
  realpath,
  isDirectory: async (path) => (await lstat(path)).isDirectory(),
  exec: async (file, args) => {
    const result = await exec(file, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  dns: async (domain) => [...await resolve4(domain).catch(() => []), ...await resolve6(domain).catch(() => [])],
  availableLoopbackPort,
};

function parseOsRelease(source: string): { id: string; version: string } {
  const values = new Map(source.split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
  }));
  return { id: values.get("ID") ?? "unknown", version: values.get("VERSION_ID") ?? "unknown" };
}

async function commandOnPath(name: string, io: ProbeIo): Promise<string | null> {
  try {
    const path = (await io.exec("which", [name])).stdout.trim();
    return path.startsWith("/") && !path.includes("\n") ? path : null;
  } catch {
    return null;
  }
}

export async function probePiPrerequisite(io: ProbeIo = nodeProbeIo): Promise<PiPrerequisite> {
  const discovered = io.piBin?.startsWith("/") ? io.piBin : await commandOnPath("pi", io);
  const piPath = discovered ? await io.realpath(discovered).catch(() => discovered) : null;
  if (!piPath) return { status: "missing" };
  try {
    const version = (await io.exec(piPath, ["--version"])).stdout.trim();
    if (!supportsPiVersion(version)) return { status: "unsupported", piPath, version };
    const models = (await io.exec(piPath, ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--list-models"]))
      .stdout.trim().split(/\r?\n/).slice(1).filter(Boolean);
    return models.length
      ? { status: "ready", piPath, version, modelCount: models.length }
      : { status: "no-models", piPath, version, modelCount: 0 };
  } catch {
    return { status: "probe-failed", piPath };
  }
}

export async function discoverHost(
  input: { domain?: string; sharedRepositoryFolders?: string[]; localListener?: boolean } = {},
  io: ProbeIo = nodeProbeIo,
  knownPi?: PiPrerequisite,
): Promise<DiscoveryReport> {
  const checks: DiscoveryCheck[] = [];
  const observedAt = new Date(io.now()).toISOString();
  const sharedRepositoryFolders: Record<string, string> = {};
  const safeText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500);
  const add = (id: string, status: CheckStatus, summary: string, detail?: string) =>
    checks.push({ id: safeText(id), status, summary: safeText(summary), ...(detail ? { detail: safeText(detail) } : {}) });

  const hostPlatform = io.platform();
  add("platform", hostPlatform === "linux" ? "pass" : "fail", hostPlatform, "Only Linux deployment is supported");

  const os = parseOsRelease(await io.read("/etc/os-release").catch(() => ""));
  const supportedOs = (os.id === "debian" && os.version === "12")
    || (os.id === "ubuntu" && ["22.04", "24.04"].includes(os.version));
  add("os", supportedOs ? "pass" : "fail", `${os.id} ${os.version}`, "Supported: Debian 12 or Ubuntu 22.04/24.04");

  const machine = io.arch();
  add("arch", machine === "x64" ? "pass" : machine === "arm64" ? "warn" : "fail", machine,
    machine === "arm64" ? "Experimental: arm64 is not an initially supported deployment target" : "Supported: x64");
  const nodeMatch = io.nodeVersion.match(/^v(\d+)\.(\d+)\./);
  const nodeSupported = !!nodeMatch && (Number(nodeMatch[1]) > 22 || (Number(nodeMatch[1]) === 22 && Number(nodeMatch[2]) >= 19));
  add("node", nodeSupported ? "pass" : "fail", `${io.nodeVersion} at ${io.nodePath}`, "Required: Node >=22.19.0");
  try {
    const systemNodeVersion = (await io.exec("/usr/bin/node", ["--version"])).stdout.trim();
    const systemMatch = systemNodeVersion.match(/^v(\d+)\.(\d+)\./);
    const systemMajor = systemMatch ? Number(systemMatch[1]) : 0;
    const systemCurrent = !!systemMatch && (systemMajor > 22 || (systemMajor === 22 && Number(systemMatch[2]) >= 19));
    const helperCompatible = systemMajor >= 18;
    add(
      "system-node",
      systemCurrent ? "pass" : "warn",
      systemCurrent ? `System Node ${systemNodeVersion} is current` : `System Node ${systemNodeVersion || "version unknown"} is older than the application runtime`,
      systemCurrent
        ? undefined
        : helperCompatible
          ? `Pi Together will use the reviewed ${io.nodeVersion} runtime at ${io.nodePath}; system Node is used only for the narrow privileged helper and is not replaced`
          : "Final installation requires a root-owned /usr/bin/node version 18 or newer; install the Ubuntu/Debian nodejs package before choosing Install now",
    );
  } catch {
    add("system-node", "warn", "System Node could not be probed", "Final installation requires a root-owned /usr/bin/node version 18 or newer; install the Ubuntu/Debian nodejs package before choosing Install now");
  }

  const uid = io.uid();
  add("user", uid !== undefined && uid !== 0 ? "pass" : "fail", `${io.username} (uid ${uid ?? "unknown"})`, "Setup must be invoked as the non-root Pi-owning user");

  const primaryGroup = await io.exec("id", ["-gn", io.username]).then((result) => result.stdout.trim(), () => io.username);
  add("group", /^[a-z_][a-z0-9_-]{0,31}$/.test(primaryGroup) ? "pass" : "fail", primaryGroup, "Primary service group must be a canonical local account name");

  const systemd = await io.exists("/run/systemd/system");
  add("systemd", systemd ? "pass" : "fail", systemd ? "systemd is running" : "systemd runtime directory not found");

  const pi = knownPi ?? await probePiPrerequisite(io);
  const piPath = pi.piPath ?? null;
  if (pi.status === "missing") add("pi", "fail", "Pi is not on PATH", PI_INSTALL_COMMAND);
  else if (pi.status === "unsupported") add("pi", "fail", `${pi.version ?? "Unknown version"} at ${piPath}`, `Required: ${PI_COMPATIBILITY}`);
  else if (pi.status === "probe-failed") add("pi", "fail", "Pi version/model probe failed");
  else {
    add("pi", "pass", `${pi.version} at ${piPath}`, `Required: ${PI_COMPATIBILITY}`);
    add("models", pi.status === "ready" ? "pass" : "fail", pi.status === "ready" ? `${pi.modelCount} available model entries` : "No available models reported");
  }

  const nginxPath = await commandOnPath("nginx", io)
    ?? (await io.exists("/usr/sbin/nginx") ? "/usr/sbin/nginx" : null);
  if (!nginxPath) add("nginx", "warn", "nginx is not on PATH", "Setup may plan a supported apt install");
  else {
    try {
      const version = await io.exec(nginxPath, ["-v"]);
      add("nginx", "pass", (version.stderr || version.stdout).trim().slice(0, 200));
    } catch {
      add("nginx", "warn", "nginx exists but version probe failed");
    }
  }

  let occupiedPorts: number[] = [];
  let localPort: number | undefined;
  try {
    const sockets = await io.exec("ss", ["-H", "-ltn"]);
    occupiedPorts = [80, 443].filter((port) => new RegExp(`[:.]${port}\\s`).test(sockets.stdout));
    add("ports", occupiedPorts.length ? "warn" : "pass", occupiedPorts.length ? `Listening ports detected: ${occupiedPorts.join(", ")}` : "Ports 80 and 443 appear unused");
  } catch {
    add("ports", "warn", "Unable to inspect listening ports without mutation");
  }
  if (input.localListener) {
    localPort = await io.availableLoopbackPort(LOCAL_LISTENER_PORTS).catch(() => undefined);
    add(
      "local-port",
      localPort === undefined ? "fail" : "pass",
      localPort === undefined ? "No Pi Together local port is available" : `Local port ${localPort} is available`,
      localPort === undefined ? `Free one of these loopback ports: ${LOCAL_LISTENER_PORTS.join(", ")}` : undefined,
    );
  }

  const synchronized = await io.exec("timedatectl", ["show", "-p", "NTPSynchronized", "--value"])
    .then((result) => result.stdout.trim() === "yes", () => false);
  add("clock", synchronized ? "pass" : "warn", synchronized ? "Clock synchronization reported" : "Clock synchronization not confirmed", observedAt);

  if (input.domain) {
    const addresses = await io.dns(input.domain).catch(() => []);
    add("dns", addresses.length ? "pass" : "fail", addresses.length ? `${input.domain} resolves to ${addresses.join(", ")}` : `${input.domain} did not resolve`);
  }

  for (const root of input.sharedRepositoryFolders ?? []) {
    try {
      const canonical = await io.realpath(root);
      const directory = await io.isDirectory(canonical);
      if (directory) sharedRepositoryFolders[root] = canonical;
      add(`workspace:${root}`, directory ? "pass" : "fail", directory ? canonical : `${root} is not a directory`);
    } catch {
      add(`workspace:${root}`, "fail", `${root} does not resolve to an existing directory`);
    }
  }

  // Both markers are created before the protected install manifest. Avoid probing the root-only
  // state directory: EACCES cannot distinguish an absent post-uninstall manifest from a live one.
  const installationMarkers = [
    "/opt/pi-together/current",
    "/etc/systemd/system/pi-together.service",
  ];
  const existing = (await Promise.all(installationMarkers.map((path) => io.exists(path)))).some(Boolean);
  add("existing-install", existing ? "warn" : "pass", existing ? "Existing or partial installation marker found" : "No existing installation marker found");
  return {
    schemaVersion: 1,
    checks,
    facts: {
      observedAt,
      platform: hostPlatform,
      distro: os,
      arch: machine,
      node: { path: io.nodePath, version: io.nodeVersion },
      user: { ...(uid === undefined ? {} : { uid }), username: io.username, group: primaryGroup },
      ...(piPath ? { piPath } : {}),
      ...(nginxPath ? { nginxPath } : {}),
      occupiedPorts,
      ...(localPort === undefined ? {} : { localPort }),
      sharedRepositoryFolders,
      existingInstall: existing,
    },
    safeToPlan: checks.every((check) => check.status !== "fail"),
  };
}
