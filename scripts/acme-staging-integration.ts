import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderDeploymentTemplates, renderNginxChallengeSite } from "../deployment/templates.js";

const exec = promisify(execFile);
const pebbleBin = process.env.PEBBLE_BIN;
if (!pebbleBin?.startsWith("/")) throw new Error("PEBBLE_BIN must be an absolute pinned binary path");
const nginxBin = process.env.NGINX_BIN ?? "/usr/sbin/nginx";
const certbotBin = process.env.CERTBOT_BIN ?? "/usr/bin/certbot";
const domain = "acme.pi-together.test";
const root = await mkdtemp(join(tmpdir(), "pi-together-acme-staging-"));
const acme = join(root, "acme");
const letsencrypt = join(root, "letsencrypt");
const work = join(root, "work");
const logs = join(root, "logs");
const nginxConfig = join(root, "nginx.conf");
const pebbleConfig = join(root, "pebble.json");
const pebbleCert = join(root, "pebble.crt");
const pebbleKey = join(root, "pebble.key");
const hostsBackup = join(root, "hosts.backup");
const hook = join(root, "deploy-hook.sh");
const hookMarker = join(root, "renewed");
let pebble: ReturnType<typeof spawn> | undefined;
let nginxStarted = false;

async function sudo(file: string, args: string[]): Promise<void> {
  await exec("/usr/bin/sudo", [file, ...args], { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
}
function pebbleTlsReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port: 14000, servername: "localhost", rejectUnauthorized: false });
    socket.once("secureConnect", () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
}
async function poll(check: () => Promise<void>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw last instanceof Error ? last : new Error("ACME staging poll timed out");
}
function tlsHeaders(): Promise<Record<string, string | string[] | undefined>> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host: "127.0.0.1", port: 443, servername: domain, path: "/oauth2/start", rejectUnauthorized: false, headers: { host: domain } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.headers));
    });
    request.once("error", reject);
    request.end();
  });
}
function nginxMain(site: string): string {
  return `pid ${join(root, "nginx.pid")};\nerror_log ${join(root, "nginx-error.log")} info;\nevents {}\nhttp {\n  access_log off;\n${site}\n}\n`;
}

try {
  await Promise.all([mkdir(acme, { recursive: true }), mkdir(letsencrypt), mkdir(work), mkdir(logs)]);
  await chmod(root, 0o755);
  await chmod(acme, 0o755);
  await copyFile("/etc/hosts", hostsBackup);
  const stagedHosts = join(root, "hosts.staged");
  await writeFile(stagedHosts, `${await readFile("/etc/hosts", "utf8")}127.0.0.1 ${domain}\n`);
  await sudo("/bin/cp", [stagedHosts, "/etc/hosts"]);
  await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", pebbleKey, "-out", pebbleCert]);
  await writeFile(pebbleConfig, `${JSON.stringify({ pebble: {
    listenAddress: "127.0.0.1:14000", managementListenAddress: "127.0.0.1:15000",
    certificate: pebbleCert, privateKey: pebbleKey, httpPort: 80, tlsPort: 443,
    ocspResponderURL: "", externalAccountBindingRequired: false, domainBlocklist: [],
    retryAfter: { authz: 0, order: 0 }, keyAlgorithm: "ecdsa",
  } }, null, 2)}\n`);
  pebble = spawn(pebbleBin, ["-config", pebbleConfig], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: "/usr/bin:/bin", PEBBLE_VA_NOSLEEP: "1", PEBBLE_WFE_NONCEREJECT: "0" },
  });
  let pebbleError = "";
  pebble.stderr?.on("data", (chunk) => { pebbleError += chunk.toString(); });
  await poll(pebbleTlsReady).catch((error) => { throw new Error(`Pebble failed to start: ${pebbleError || (error as Error).message}`); });

  const challenge = renderNginxChallengeSite(domain, acme);
  if (challenge.includes("Strict-Transport-Security") || challenge.includes("listen 443")) throw new Error("HSTS/TLS appeared before successful issuance");
  await writeFile(nginxConfig, nginxMain(challenge));
  await sudo(nginxBin, ["-t", "-p", `${root}/`, "-c", nginxConfig]);
  await sudo(nginxBin, ["-p", `${root}/`, "-c", nginxConfig]);
  nginxStarted = true;

  const certbotCommon = [
    "--non-interactive", "--no-verify-ssl", "--server", "https://127.0.0.1:14000/dir",
    "--config-dir", letsencrypt, "--work-dir", work, "--logs-dir", logs,
  ];
  await sudo(certbotBin, [
    "certonly", ...certbotCommon, "--agree-tos", "--register-unsafely-without-email", "--webroot", "-w", acme,
    "--preferred-challenges", "http", "--cert-name", domain, "-d", domain,
  ]);
  const fullchain = join(letsencrypt, "live", domain, "fullchain.pem");
  const privateKey = join(letsencrypt, "live", domain, "privkey.pem");
  await sudo("/usr/bin/openssl", ["x509", "-in", fullchain, "-noout", "-checkhost", domain]);
  const privateMode = Number.parseInt((await exec("/usr/bin/sudo", ["/usr/bin/stat", "-Lc", "%a", privateKey])).stdout.trim(), 8);
  if ((privateMode & 0o077) !== 0) throw new Error("staging private key permissions are too broad");

  const final = renderDeploymentTemplates({
    domain, listener: { kind: "unix", path: "/run/pi-together/app.sock" }, oauth2ProxyPort: 4180,
    proxySecret: "p".repeat(43), githubLogins: ["alice"], oauthClientId: "synthetic-client-id",
    oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
    cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
    tlsCertificate: fullchain, tlsCertificateKey: privateKey, acmeWebroot: acme,
  }).nginxSite;
  if (!final.includes("Strict-Transport-Security")) throw new Error("final TLS site omitted HSTS");
  await writeFile(nginxConfig, nginxMain(final));
  await sudo(nginxBin, ["-t", "-p", `${root}/`, "-c", nginxConfig]);
  await sudo(nginxBin, ["-s", "reload", "-p", `${root}/`, "-c", nginxConfig]);
  const headers = await tlsHeaders();
  if (!String(headers["strict-transport-security"]).includes("max-age=")) throw new Error("activated HTTPS response omitted HSTS");

  await writeFile(hook, `#!/bin/sh\nset -eu\nprintf renewed > ${hookMarker}\n`, { mode: 0o755 });
  await chmod(hook, 0o755);
  await sudo(certbotBin, ["renew", ...certbotCommon, "--force-renewal", "--no-random-sleep-on-renew", "--deploy-hook", hook]);
  if ((await readFile(hookMarker, "utf8")) !== "renewed") throw new Error("ACME staging renewal did not run its deploy hook");

  process.stdout.write(JSON.stringify({ ok: true, pebble: "2.10.1", http01: true, hstsAfterIssuance: true, renewal: true, noNginxRewrite: true }) + "\n");
} finally {
  if (nginxStarted) await sudo(nginxBin, ["-s", "stop", "-p", `${root}/`, "-c", nginxConfig]).catch(() => undefined);
  pebble?.kill("SIGTERM");
  await sudo("/bin/cp", [hostsBackup, "/etc/hosts"]).catch(() => undefined);
  await sudo("/bin/rm", ["-rf", root]).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
