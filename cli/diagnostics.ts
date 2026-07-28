import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { resolve4, resolve6 } from "node:dns/promises";
import { promisify } from "node:util";
import { parseConfig, type AppConfig } from "../server/config.js";
import { RepositoryDiscovery } from "../server/workspace-policy.js";
import { mappingNeedsVerification, verifyGitHubMapping, type GitHubPrincipalMapping } from "../server/github-principals.js";
import { PI_COMPATIBILITY, parsePiVersion, supportsPiVersion } from "./pi-version.js";
import { packageVersionForRelease } from "./install-manifest.js";

const exec = promisify(execFile);
export type CheckStatus = "pass" | "warn" | "fail";
export interface DiagnosticCheck { code: string; status: CheckStatus; summary: string; remediation?: string }
export interface DoctorReport { schemaVersion: 1; overall: CheckStatus; checks: DiagnosticCheck[] }
export interface StatusReport {
  schemaVersion: 1;
  installed: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  services: { app: string; oauth2Proxy: string; nginx: string; certbotTimer: string; funnelEdge: string; funnel: string; tailscaled: string };
  workspaces: { configuredFolders: number | null; discoveredRepositories: number | null; truncated: boolean | null };
}
interface PathState { kind: "absent" | "file" | "directory" | "symlink" | "other"; mode?: number; uid?: number; gid?: number; target?: string }
interface CommandResult { stdout: string; stderr: string }
export interface DiagnosticIo {
  now(): number;
  uid(): number;
  state(path: string): Promise<PathState>;
  read(path: string, maximumBytes: number): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  exec(file: string, args: string[]): Promise<CommandResult>;
  dns(domain: string): Promise<string[]>;
  fetch(url: string): Promise<{ status: number; location?: string }>;
  tlsCertificate(domain: string): Promise<{ validTo: number }>;
  privateHealth(listener: { kind: "unix"; path: string } | { kind: "tcp"; host: "127.0.0.1"; port: number }, headers: Record<string, string>): Promise<number>;
  verifyPrincipal(mapping: GitHubPrincipalMapping, observedAt: string): Promise<{ kind: "verified" | "not-modified" | "disabled" | "rate-limited"; subject: string; login: string }>;
}

async function nodeState(path: string): Promise<PathState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, target: await readlink(path) };
    if (info.isFile()) return { kind: "file", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
    if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
    return { kind: "other", mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}
async function boundedRead(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error("diagnostic file is not a bounded regular file");
    return await handle.readFile();
  } finally { await handle.close(); }
}
export const nodeDiagnosticIo: DiagnosticIo = {
  now: () => Date.now(),
  uid: () => process.getuid?.() ?? -1,
  state: nodeState,
  read: boundedRead,
  realpath,
  exec: async (file, args) => {
    const home = process.env.HOME;
    const safeHome = home?.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(home) ? home : undefined;
    const result = await exec(file, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", ...(safeHome ? { HOME: safeHome } : {}) } });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  dns: async (domain) => [...await resolve4(domain).catch(() => []), ...await resolve6(domain).catch(() => [])],
  fetch: async (url) => {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return { status: response.status, ...(response.headers.get("location") ? { location: response.headers.get("location")! } : {}) };
  },
  tlsCertificate: (domain) => new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: domain, port: 443, servername: domain, rejectUnauthorized: true });
    socket.setTimeout(10_000, () => socket.destroy(new Error("TLS certificate check timed out")));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const validTo = Date.parse(certificate.valid_to);
      socket.end();
      if (!Number.isFinite(validTo)) reject(new Error("TLS peer certificate has no valid expiry"));
      else resolve({ validTo });
    });
    socket.once("error", reject);
  }),
  privateHealth: (listener, headers) => new Promise((resolve, reject) => {
    const endpoint = listener.kind === "unix" ? { socketPath: listener.path } : { host: listener.host, port: listener.port };
    const request = httpRequest({ ...endpoint, path: "/api/health", method: "GET", headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  }),
  verifyPrincipal: async (mapping, observedAt) => {
    const result = await verifyGitHubMapping(mapping, { now: () => new Date(observedAt) });
    return { kind: result.kind, subject: result.mapping.subject, login: result.mapping.login };
  },
};

const remediation: Record<string, string> = {
  "PTD-CONFIG": "Re-run setup after correcting config ownership, mode, or schema.",
  "PTD-RELEASE": "Reinstall the exact signed release before starting services.",
  "PTD-PI-VERSION": `Install a Pi version in the supported range ${PI_COMPATIBILITY}.`,
  "PTD-PI-MODELS": "Configure at least one Pi model and rerun doctor.",
  "PTD-WORKSPACES": "Restore each configured canonical shared repository folder and invoking-user ownership.",
  "PTD-IDENTITY": "Re-run setup to refresh and reconcile GitHub numeric principal mappings.",
  "PTD-DNS": "Point the public domain at this host, wait for propagation, then rerun doctor.",
  "PTD-LISTENER": "Start the app on its configured private socket or literal loopback listener.",
  "PTD-PORTS": "Restore nginx on ports 80/443 and keep oauth2-proxy on literal loopback only.",
  "PTD-PROCESS-USERS": "Restart owned services from the generated units and ensure neither runs as root.",
  "PTD-SERVICES": "Inspect the named owned units with pi-together logs and restart only after correction.",
  "PTD-CERTIFICATE": "Renew or reissue the domain certificate before exposing the service.",
  "PTD-RENEWAL": "Enable and start certbot.timer and validate the Pi Together deploy hook.",
  "PTD-PRIVATE-HEALTH": "Restore the private app listener and configuration before public activation.",
  "PTD-PUBLIC-REDIRECT": "Verify nginx/oauth2-proxy routing and the configured OAuth callback URL.",
};
function check(code: string, status: CheckStatus, summary: string): DiagnosticCheck {
  return { code, status, summary, ...(status === "pass" ? {} : { remediation: remediation[code] }) };
}
function failed(code: string, summary: string): DiagnosticCheck { return check(code, "fail", summary); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function safeVersion(value: string): string | null { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null; }

async function loadDoctorConfig(path: string, io: DiagnosticIo): Promise<AppConfig> {
  const state = await io.state(path);
  if (state.kind !== "file" || state.mode !== 0o600 || (state.uid !== io.uid() && !(io.uid() === 0 && state.uid !== 0))) throw new Error("unsafe config metadata");
  return parseConfig(JSON.parse((await io.read(path, 1024 * 1024)).toString("utf8")));
}
async function releaseCheck(io: DiagnosticIo, releaseRoot: string, expectedManifestPath?: string): Promise<DiagnosticCheck> {
  try {
    const resolved = await io.realpath(`${releaseRoot}/current`);
    const version = safeVersion(resolved.split("/").at(-1) ?? "");
    if (!version || resolved !== `${releaseRoot}/releases/${version}`) throw new Error();
    const manifestBytes = await io.read(`${resolved}/release/manifest.json`, 4 * 1024 * 1024);
    if (expectedManifestPath && sha256(manifestBytes) !== sha256(await io.read(expectedManifestPath, 4 * 1024 * 1024))) throw new Error();
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { package?: { version?: string }; artifacts?: Array<{ path: string; bytes: number; sha256: string }> };
    if (manifest.package?.version !== packageVersionForRelease(version) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 10_000) throw new Error();
    for (const artifact of manifest.artifacts) {
      if (!artifact.path.startsWith("dist/") || artifact.path.includes("..") || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error();
      const bytes = await io.read(`${resolved}/${artifact.path.slice(5)}`, 64 * 1024 * 1024);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error();
    }
    return check("PTD-RELEASE", "pass", `Release ${version} integrity verified.`);
  } catch { return failed("PTD-RELEASE", "Installed release integrity could not be verified."); }
}
async function serviceState(io: DiagnosticIo, unit: string): Promise<string> {
  try {
    const state = (await io.exec("/bin/systemctl", ["is-active", unit])).stdout.trim();
    return ["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance"].includes(state) ? state : "unknown";
  } catch { return "inactive"; }
}

export async function runDoctor(options: { configPath?: string; releaseRoot?: string; piBin?: string; nodePath?: string; expectedManifestPath?: string } = {}, io: DiagnosticIo = nodeDiagnosticIo): Promise<DoctorReport> {
  const configPath = options.configPath ?? process.env.PI_TOGETHER_CONFIG_FILE ?? "/etc/pi-together/config.json";
  const releaseRoot = options.releaseRoot ?? "/opt/pi-together";
  let piBin = options.piBin ?? process.env.PI_BIN;
  let piNode = options.nodePath;
  if (!piBin) {
    try {
      const environment = (await io.exec("/bin/systemctl", ["show", "--property=Environment", "--value", "pi-together.service"])).stdout;
      const candidate = environment.match(/(?:^|\s)PI_BIN=(\/[A-Za-z0-9._+@/-]+)/)?.[1];
      const servicePath = environment.match(/(?:^|\s)PATH=(\/[A-Za-z0-9._+@/:-]+)/)?.[1];
      if (candidate && !candidate.includes("..") && !candidate.includes("//")) {
        piBin = candidate;
        const runtimeDirectory = servicePath?.split(":")[0];
        if (runtimeDirectory && !runtimeDirectory.includes("..") && !runtimeDirectory.includes("//")) piNode = `${runtimeDirectory}/node`;
      }
    } catch { /* Fall back to PATH below. */ }
  }
  piBin ??= "pi";
  const runPi = (args: string[]) => piNode ? io.exec(piNode, [piBin, ...args]) : io.exec(piBin, args);
  const checks: DiagnosticCheck[] = [];
  let config: AppConfig | undefined;
  try { config = await loadDoctorConfig(configPath, io); checks.push(check("PTD-CONFIG", "pass", "Configuration schema and mode-0600 ownership verified.")); }
  catch { checks.push(failed("PTD-CONFIG", "Configuration is missing, unsafe, or invalid.")); }
  checks.push(await releaseCheck(io, releaseRoot, options.expectedManifestPath));

  try {
    const output = (await runPi(["--version"])).stdout;
    const version = parsePiVersion(output);
    checks.push(version && supportsPiVersion(output) ? check("PTD-PI-VERSION", "pass", `Pi ${version.major}.${version.minor}.${version.patch} is supported.`) : failed("PTD-PI-VERSION", "Installed Pi version is unsupported or invalid."));
  } catch { checks.push(failed("PTD-PI-VERSION", "Pi could not be executed.")); }
  try {
    const models = (await runPi(["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--list-models"])).stdout.trim();
    checks.push(models ? check("PTD-PI-MODELS", "pass", "Pi reports at least one offline model entry.") : failed("PTD-PI-MODELS", "Pi reported no model entries."));
  } catch { checks.push(failed("PTD-PI-MODELS", "Pi model readiness check failed.")); }

  if (config) {
    const workspaceStates = await Promise.all(config.sharedRepositoryFolders.map((path) => io.state(path).catch(() => ({ kind: "absent" as const }))));
    checks.push(workspaceStates.every((state) => state.kind === "directory" && state.uid === io.uid())
      ? check("PTD-WORKSPACES", "pass", `${workspaceStates.length} shared repository folder(s) verified.`)
      : failed("PTD-WORKSPACES", "One or more shared repository folders are unavailable or wrongly owned."));
  } else checks.push(failed("PTD-WORKSPACES", "Shared-folder checks require a valid configuration."));

  if (config && config.mode !== "local") {
    let identityFailure = false;
    let refreshed = false;
    for (const principal of config.principals) {
      if (!mappingNeedsVerification(principal, new Date(io.now()))) continue;
      try {
        const current = await io.verifyPrincipal(principal, new Date(io.now()).toISOString());
        refreshed = true;
        if (!(["verified", "not-modified"].includes(current.kind)) || current.login !== principal.login || current.subject !== principal.subject) identityFailure = true;
      } catch { identityFailure = true; }
    }
    checks.push(identityFailure ? failed("PTD-IDENTITY", "A GitHub mapping is stale, unavailable, or no longer matches its numeric subject.")
      : check("PTD-IDENTITY", "pass", refreshed ? "Due GitHub numeric principal mappings were refreshed and unchanged." : "GitHub numeric principal mappings are fresh."));
    const domain = new URL(config.publicOrigin).hostname;
    const addresses = await io.dns(domain).catch(() => []);
    checks.push(addresses.length ? check("PTD-DNS", "pass", "Public domain resolves.") : failed("PTD-DNS", "Public domain does not resolve."));
  } else {
    checks.push(check("PTD-IDENTITY", "pass", "GitHub mapping checks are not required in local mode."));
    checks.push(check("PTD-DNS", "pass", "Public DNS checks are not required in local mode."));
  }

  if (config) {
    try {
      const state = config.listener.kind === "unix" ? await io.state(config.listener.path) : undefined;
      const listeners = config.listener.kind === "tcp" ? (await io.exec("/usr/bin/ss", ["-H", "-ltn"])).stdout : "";
      const healthy = config.listener.kind === "unix" ? state?.kind === "other" && state.mode === 0o660
        : listeners.includes(`127.0.0.1:${config.listener.port}`) && !listeners.includes(`0.0.0.0:${config.listener.port}`);
      checks.push(healthy ? check("PTD-LISTENER", "pass", "Private listener boundary is active.") : failed("PTD-LISTENER", "Configured private listener is unavailable or unsafe."));
    } catch { checks.push(failed("PTD-LISTENER", "Private listener inventory failed.")); }
  } else checks.push(failed("PTD-LISTENER", "Listener checks require a valid configuration."));

  if (config) {
    try {
      const listeners = (await io.exec("/usr/bin/ss", ["-H", "-ltn"])).stdout;
      const valid = config.mode === "local"
        ? listeners.includes(`127.0.0.1:${config.listener.port}`) && !listeners.includes(`0.0.0.0:${config.listener.port}`)
        : config.mode === "tailscale-funnel"
          ? listeners.includes("127.0.0.1:4180") && listeners.includes("127.0.0.1:43118")
            && !listeners.includes("0.0.0.0:4180") && !listeners.includes("0.0.0.0:43118")
          : listeners.includes(":80 ") && listeners.includes(":443 ") && listeners.includes("127.0.0.1:4180")
            && !listeners.includes("0.0.0.0:4180") && !listeners.includes("[::]:4180");
      checks.push(valid ? check("PTD-PORTS", "pass", "Required ports are active without a broad oauth2-proxy bind.") : failed("PTD-PORTS", "Required ports are missing or oauth2-proxy is broadly bound."));
    } catch { checks.push(failed("PTD-PORTS", "Port inventory failed.")); }
  } else checks.push(failed("PTD-PORTS", "Port checks require a valid configuration."));

  const serviceNames = config?.mode === "reverse-proxy" ? ["pi-together.service", "pi-together-oauth2-proxy.service", "nginx.service"]
    : config?.mode === "tailscale-funnel" ? ["pi-together.service", "pi-together-oauth2-proxy.service", "pi-together-edge.service", "pi-together-funnel.service", "tailscaled.service"]
      : ["pi-together.service"];
  const serviceStates = await Promise.all(serviceNames.map((unit) => serviceState(io, unit)));
  checks.push(serviceStates.every((state) => state === "active") ? check("PTD-SERVICES", "pass", "Owned service dependencies are active.") : failed("PTD-SERVICES", "One or more owned service dependencies are inactive."));
  try {
    const units = config && config.mode !== "local" ? ["pi-together.service", "pi-together-oauth2-proxy.service"] : ["pi-together.service"];
    const users: string[] = [];
    for (const unit of units) {
      const pid = (await io.exec("/bin/systemctl", ["show", "--property=MainPID", "--value", unit])).stdout.trim();
      if (!/^[1-9]\d*$/.test(pid)) throw new Error();
      users.push((await io.exec("/bin/ps", ["-o", "user=", "-p", pid])).stdout.trim());
    }
    checks.push(users.every((user) => user && user !== "root") ? check("PTD-PROCESS-USERS", "pass", "Application and OAuth processes are non-root.") : failed("PTD-PROCESS-USERS", "An owned application process is missing or running as root."));
  } catch { checks.push(failed("PTD-PROCESS-USERS", "Owned application process identity could not be verified.")); }

  if (config && config.mode !== "local") {
    const domain = new URL(config.publicOrigin).hostname;
    try {
      const certificate = await io.tlsCertificate(domain);
      if (certificate.validTo - io.now() < 30 * 24 * 60 * 60_000) throw new Error();
      checks.push(check("PTD-CERTIFICATE", "pass", "Public certificate chain, hostname, and 30-day validity verified."));
    } catch { checks.push(failed("PTD-CERTIFICATE", "Certificate is missing, untrusted, mismatched, or expires within 30 days.")); }
    if (config.mode === "tailscale-funnel") checks.push(check("PTD-RENEWAL", "pass", "TLS certificate lifecycle is managed locally by Tailscale Funnel."));
    else {
      const renewal = await Promise.all([serviceState(io, "certbot.timer"), io.exec("/bin/systemctl", ["is-enabled", "certbot.timer"]).then((result) => result.stdout.trim()).catch(() => "disabled")]);
      checks.push(renewal[0] === "active" && renewal[1] === "enabled" ? check("PTD-RENEWAL", "pass", "Certbot renewal timer is enabled and active.") : failed("PTD-RENEWAL", "Certbot renewal timer is not enabled and active."));
    }
    try {
      const status = await io.privateHealth(config.listener, {
        host: domain, "x-pi-together-proxy-secret": config.proxySecret, "x-pi-together-login": config.principals[0]!.login,
      });
      checks.push(status === 200 ? check("PTD-PRIVATE-HEALTH", "pass", "Authenticated private health check passed.") : failed("PTD-PRIVATE-HEALTH", "Authenticated private health check failed."));
    } catch { checks.push(failed("PTD-PRIVATE-HEALTH", "Authenticated private health check failed.")); }
    try {
      const response = await io.fetch(`${config.publicOrigin}/oauth2/start`);
      const location = response.location ?? "";
      checks.push(response.status === 302 && location.startsWith("https://github.com/login/oauth/authorize?") && location.includes(encodeURIComponent(`${config.publicOrigin}/oauth2/callback`))
        ? check("PTD-PUBLIC-REDIRECT", "pass", "Public OAuth start and callback redirect shape verified.")
        : failed("PTD-PUBLIC-REDIRECT", "Public OAuth redirect shape is invalid."));
    } catch { checks.push(failed("PTD-PUBLIC-REDIRECT", "Public OAuth redirect check failed.")); }
  } else if (config?.mode === "local") {
    checks.push(check("PTD-CERTIFICATE", "pass", "Certificate checks are not required in local mode."));
    checks.push(check("PTD-RENEWAL", "pass", "Certificate renewal is not required in local mode."));
    try {
      const response = await io.fetch(`http://${config.listener.host}:${config.listener.port}/api/health`);
      checks.push(response.status === 200 ? check("PTD-PRIVATE-HEALTH", "pass", "Local health check passed.") : failed("PTD-PRIVATE-HEALTH", "Local health check failed."));
    } catch { checks.push(failed("PTD-PRIVATE-HEALTH", "Local health check failed.")); }
    checks.push(check("PTD-PUBLIC-REDIRECT", "pass", "Public OAuth redirect is not required in local mode."));
  } else {
    for (const code of ["PTD-CERTIFICATE", "PTD-RENEWAL", "PTD-PRIVATE-HEALTH", "PTD-PUBLIC-REDIRECT"]) checks.push(failed(code, "Check requires a valid configuration."));
  }
  const overall = checks.some((item) => item.status === "fail") ? "fail" : checks.some((item) => item.status === "warn") ? "warn" : "pass";
  return { schemaVersion: 1, overall, checks };
}

export async function configuredLogSecrets(configPath = process.env.PI_TOGETHER_CONFIG_FILE ?? "/etc/pi-together/config.json", io: DiagnosticIo = nodeDiagnosticIo): Promise<string[]> {
  try {
    const state = await io.state(configPath);
    if (state.kind !== "file" || state.mode !== 0o600 || (state.uid !== io.uid() && !(io.uid() === 0 && state.uid !== 0))) return [];
    const config = parseConfig(JSON.parse((await io.read(configPath, 1024 * 1024)).toString("utf8")));
    if (config.mode === "local") return [];
    const values = [config.proxySecret];
    if (io.uid() === 0) {
      for (const path of ["/etc/pi-together/oauth-client.secret", "/etc/pi-together/oauth-cookie.secret"]) {
        const secretState = await io.state(path);
        if (secretState.kind === "file" && secretState.mode === 0o600 && secretState.uid === 0) {
          values.push((await io.read(path, 4096)).toString("utf8"));
        }
      }
    }
    return values;
  } catch { return []; }
}

export function renderDoctor(report: DoctorReport): string {
  return [`Pi Together doctor: ${report.overall.toUpperCase()}`, ...report.checks.flatMap((item) => [
    `${item.status.toUpperCase()}  ${item.code}  ${item.summary}`,
    ...(item.remediation ? [`      Remediation: ${item.remediation}`] : []),
  ])].join("\n");
}

export async function runStatus(releaseRoot = "/opt/pi-together", io: DiagnosticIo = nodeDiagnosticIo): Promise<StatusReport> {
  let currentVersion: string | null = null;
  let previousVersion: string | null = null;
  try {
    const resolved = await io.realpath(`${releaseRoot}/current`);
    const candidate = safeVersion(resolved.split("/").at(-1) ?? "");
    currentVersion = candidate && resolved === `${releaseRoot}/releases/${candidate}` ? candidate : null;
  } catch { /* Not installed. */ }
  try {
    const resolved = await io.realpath(`${releaseRoot}/previous`);
    const candidate = safeVersion(resolved.split("/").at(-1) ?? "");
    previousVersion = candidate && resolved === `${releaseRoot}/releases/${candidate}` ? candidate : null;
  } catch { /* No rollback release has been recorded yet. */ }
  let workspaceStatus: StatusReport["workspaces"] = { configuredFolders: null, discoveredRepositories: null, truncated: null };
  try {
    const config = await loadDoctorConfig(process.env.PI_TOGETHER_CONFIG_FILE ?? "/etc/pi-together/config.json", io);
    workspaceStatus = { configuredFolders: config.sharedRepositoryFolders.length, discoveredRepositories: null, truncated: null };
    if (io === nodeDiagnosticIo) {
      const discovery = await new RepositoryDiscovery(config.sharedRepositoryFolders).refresh();
      workspaceStatus = { configuredFolders: config.sharedRepositoryFolders.length, discoveredRepositories: discovery.repositories.length, truncated: discovery.truncated };
    }
  } catch { /* Status remains bounded and reports unavailable counts without path details. */ }
  return {
    schemaVersion: 1,
    installed: currentVersion !== null,
    currentVersion,
    previousVersion,
    workspaces: workspaceStatus,
    services: {
      app: await serviceState(io, "pi-together.service"),
      oauth2Proxy: await serviceState(io, "pi-together-oauth2-proxy.service"),
      nginx: await serviceState(io, "nginx.service"),
      certbotTimer: await serviceState(io, "certbot.timer"),
      funnelEdge: await serviceState(io, "pi-together-edge.service"),
      funnel: await serviceState(io, "pi-together-funnel.service"),
      tailscaled: await serviceState(io, "tailscaled.service"),
    },
  };
}
export function renderStatus(report: StatusReport): string {
  return [
    `Pi Together: ${report.installed ? "installed" : "not installed"}`,
    `Current version: ${report.currentVersion ?? "none"}`,
    `Previous version: ${report.previousVersion ?? "none"}`,
    `Shared repositories: folders=${report.workspaces.configuredFolders ?? "unknown"} repositories=${report.workspaces.discoveredRepositories ?? "unknown"}${report.workspaces.truncated ? " (scan truncated)" : ""}`,
    `Services: app=${report.services.app} oauth2-proxy=${report.services.oauth2Proxy} nginx=${report.services.nginx} certbot=${report.services.certbotTimer} edge=${report.services.funnelEdge} funnel=${report.services.funnel} tailscaled=${report.services.tailscaled}`,
  ].join("\n");
}

const COMPONENT_UNITS = { app: "pi-together.service", "oauth2-proxy": "pi-together-oauth2-proxy.service", edge: "pi-together-edge.service", funnel: "pi-together-funnel.service", nginx: "nginx.service", certbot: "certbot.service" } as const;
export type LogComponent = keyof typeof COMPONENT_UNITS;
export function redactDiagnosticText(text: string, configuredValues: string[] = []): string {
  let redacted = text;
  for (const value of configuredValues.filter((value) => value.length >= 8)) redacted = redacted.replaceAll(value, "[REDACTED]");
  redacted = redacted
    .replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/\b(secret|token|cookie|authorization|password|credential|client_secret)(\s*[=:]\s*)[^\s,"']+/gi, "$1$2[REDACTED]")
    .replace(/\S{16,}/g, "[REDACTED]");
  return redacted;
}
export function ownedLogArguments(component: LogComponent, follow: boolean): string[] {
  const unit = COMPONENT_UNITS[component];
  if (!unit) throw new Error("unknown log component");
  return ["--no-pager", "--output=short-iso", "--unit", unit, ...(follow ? ["--follow"] : ["--lines", "200"] )];
}
export function streamOwnedLogs(component: LogComponent, follow: boolean, configuredValues: string[] = []): Promise<number> {
  const args = ownedLogArguments(component, follow);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/journalctl", args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n") + 1;
        process.stdout.write(redactDiagnosticText(pending.slice(0, end), configuredValues));
        pending = pending.slice(end);
      }
      if (pending.length > 1024 * 1024) {
        process.stdout.write("[REDACTED OVERSIZED LOG LINE]\n");
        pending = "";
      }
    });
    child.stderr.on("data", () => process.stderr.write("Unable to read owned component logs. Check journal permissions.\n"));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (pending) process.stdout.write(redactDiagnosticText(pending, configuredValues));
      resolve(code ?? 1);
    });
  });
}
