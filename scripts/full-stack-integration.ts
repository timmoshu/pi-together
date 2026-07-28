import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { renderDeploymentTemplates } from "../deployment/templates.js";

const exec = promisify(execFile);
const nginxBin = process.env.NGINX_BIN ?? "/usr/sbin/nginx";
const oauthBin = process.env.OAUTH2_PROXY_BIN;
if (!oauthBin?.startsWith("/")) throw new Error("OAUTH2_PROXY_BIN must be an absolute verified helper path");
const root = await mkdtemp(join(tmpdir(), "pi-together-full-stack-"));
const socket = join(root, "app.sock");
const domain = "pi.example.com";
const proxySecret = "p".repeat(43);
const oauthClientSecret = join(root, "oauth-client.secret");
const cookieSecret = join(root, "oauth-cookie.secret");
const acme = join(root, "acme");
const certificate = join(root, "tls.crt");
const certificateKey = join(root, "tls.key");
const oauthConfig = join(root, "oauth2-proxy.cfg");
const appConfig = join(root, "app-config.json");
const workspace = join(root, "workspace");
const baselineAppTcp = (await exec("/usr/bin/ss", ["-H", "-ltn", "sport = :43117"])).stdout;

function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  return createServer(handler);
}
function listenTcp(instance: ReturnType<typeof server>, port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(port, host, () => { instance.off("error", reject); resolve(); });
  });
}
function close(instance: ReturnType<typeof server>): Promise<void> {
  return new Promise((resolve) => instance.close(() => resolve()));
}
interface Response { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function plain(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: 18080, path, method: "GET", headers: { host: domain } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}
function unix(path: string, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: socket, path, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}
function tls(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1", port: 18443, path, method: "GET", rejectUnauthorized: false, servername: domain,
      headers: { host: domain, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}
function tlsFirstChunk(path: string, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1", port: 18443, path, method: "GET", rejectUnauthorized: false, servername: domain,
      headers: { host: domain, ...headers },
    }, (response) => {
      response.once("data", (chunk) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.from(chunk).toString("utf8") });
        request.destroy();
      });
    });
    request.once("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    request.end();
  });
}
async function poll(check: () => Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw last instanceof Error ? last : new Error("integration poll timed out");
}

const oauthMock = server((request, response) => {
  if (request.url?.startsWith("/oauth2/auth")) {
    if (request.headers.cookie === "session=valid") {
      response.writeHead(202, { "x-auth-request-user": "alice" });
      response.end();
    } else {
      response.writeHead(401);
      response.end();
    }
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("mock oauth sign in");
});

let app: ReturnType<typeof spawn> | undefined;
let nginx: ReturnType<typeof spawn> | undefined;
let oauth: ReturnType<typeof spawn> | undefined;
try {
  await mkdir(join(acme, ".well-known/acme-challenge"), { recursive: true });
  await mkdir(workspace);
  await writeFile(appConfig, `${JSON.stringify({
    version: 2,
    mode: "reverse-proxy",
    listener: { kind: "unix", path: socket },
    publicOrigin: `https://${domain}`,
    proxySecret,
    principals: [{ provider: "github", subject: "1001", login: "alice", verifiedAt: "2026-07-25T00:00:00.000Z", verification: "verified" }],
    sharedRepositoryFolders: [workspace],
  }, null, 2)}\n`, { mode: 0o600 });
  for (const directory of ["client", "proxy", "fastcgi", "uwsgi", "scgi"]) await mkdir(join(root, directory));
  await writeFile(join(acme, ".well-known/acme-challenge/token"), "challenge-ok\n");
  await writeFile(oauthClientSecret, "synthetic-oauth-client-secret", { mode: 0o600 });
  await writeFile(cookieSecret, randomBytes(32).toString("base64url"), { mode: 0o600 });
  await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${domain}`, "-keyout", certificateKey, "-out", certificate]);

  const rendered = renderDeploymentTemplates({
    domain,
    listener: { kind: "unix", path: socket },
    oauth2ProxyPort: 4180,
    proxySecret,
    githubLogins: ["alice"],
    oauthClientId: "synthetic-client-id",
    oauthClientSecretFile: oauthClientSecret,
    cookieSecretFile: cookieSecret,
    tlsCertificate: certificate,
    tlsCertificateKey: certificateKey,
    acmeWebroot: acme,
  });
  await writeFile(oauthConfig, rendered.oauth2ProxyConfig, { mode: 0o600 });
  await chmod(oauthConfig, 0o600);
  const site = rendered.nginxSite
    .replaceAll("listen 80;", "listen 18080;")
    .replaceAll("listen [::]:80;", "listen [::]:18080;")
    .replaceAll("listen 443 ssl http2;", "listen 18443 ssl;")
    .replaceAll("listen [::]:443 ssl http2;", "listen [::]:18443 ssl;");
  const unrelated = join(root, "unrelated.conf");
  const unrelatedBytes = "# unrelated site must remain byte-identical\n";
  await writeFile(unrelated, unrelatedBytes);
  const nginxConfig = join(root, "nginx.conf");
  await writeFile(nginxConfig, `pid ${join(root, "nginx.pid")};\nerror_log ${join(root, "error.log")} info;\nevents {}\nhttp {\n  access_log off;\n  client_body_temp_path ${join(root, "client")};\n  proxy_temp_path ${join(root, "proxy")};\n  fastcgi_temp_path ${join(root, "fastcgi")};\n  uwsgi_temp_path ${join(root, "uwsgi")};\n  scgi_temp_path ${join(root, "scgi")};\n${site}\n}\n`);

  app = spawn(process.execPath, [join(process.cwd(), "dist/server/index.js")], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PI_TOGETHER_ADAPTER: "fake",
      PI_TOGETHER_CONFIG_FILE: appConfig,
      PI_TOGETHER_CLIENT_DIR: join(process.cwd(), "dist/client"),
      PI_TOGETHER_ATTRIBUTION_EXTENSION: join(process.cwd(), "dist/extension/pi-together-attribution-v1.js"),
      PI_TOGETHER_GIT_LAUNCHER: join(process.cwd(), "dist/extension/git-bin/git"),
    },
  });
  let appError = "";
  app.stderr?.on("data", (chunk) => { appError += chunk.toString(); });
  await poll(async () => {
    const response = await unix("/api/health", {
      host: domain,
      "x-pi-together-proxy-secret": proxySecret,
      "x-pi-together-login": "alice",
    });
    if (response.status !== 200) throw new Error(`private app not ready: ${response.status} ${appError}`);
  });
  await listenTcp(oauthMock, 4180);
  await exec(nginxBin, ["-t", "-p", `${root}/`, "-c", nginxConfig]);
  nginx = spawn(nginxBin, ["-p", `${root}/`, "-c", nginxConfig, "-g", "daemon off;"], { stdio: ["ignore", "ignore", "pipe"] });
  let nginxError = "";
  nginx.stderr?.on("data", (chunk) => { nginxError += chunk.toString(); });
  await poll(async () => {
    const response = await tls("/");
    if (response.status !== 302) throw new Error(`nginx not ready: ${response.status} ${nginxError}`);
  });

  const challenge = await plain("/.well-known/acme-challenge/token");
  const httpRedirect = await plain("/");
  if (challenge.status !== 200 || challenge.body !== "challenge-ok\n" || httpRedirect.status !== 301) throw new Error("HTTP challenge/redirect surface failed");

  const redirect = await tls("/", { "x-pi-together-login": "mallory", "x-pi-together-proxy-secret": "caller" });
  if (redirect.status !== 302 || !String(redirect.headers.location).includes("/oauth2/sign_in?")) throw new Error("unauthenticated browser path did not enter OAuth flow");

  const authenticated = await tls("/api/bootstrap", {
    cookie: "session=valid", authorization: "Bearer attacker", origin: `https://${domain}`,
    "x-pi-together-login": "mallory", "x-pi-together-proxy-secret": "caller", "x-forwarded-user": "mallory",
  });
  const bootstrap = JSON.parse(authenticated.body) as { owner?: string; principal?: { subject?: string }; adapter?: string };
  if (authenticated.status !== 200 || bootstrap.owner !== "alice" || bootstrap.principal?.subject !== "1001" || bootstrap.adapter !== "fake") {
    throw new Error("authenticated principal/header boundary failed");
  }

  const stream = await tlsFirstChunk("/events", { cookie: "session=valid", "last-event-id": "0" });
  if (stream.status !== 200 || !stream.body.includes("data:")
    || !String(stream.headers["cache-control"]).includes("no-transform") || stream.headers["x-accel-buffering"] !== "no") {
    throw new Error("SSE proxy contract failed");
  }
  if (((await stat(socket)).mode & 0o777) !== 0o660) throw new Error("application socket mode is not 0660");
  const directTcp = await exec("/usr/bin/ss", ["-H", "-ltn", "sport = :43117"]);
  if (directTcp.stdout !== baselineAppTcp) throw new Error("application changed the direct TCP listener inventory");
  if (await readFile(unrelated, "utf8") !== unrelatedBytes) throw new Error("unrelated nginx site changed");

  nginx.kill("SIGTERM");
  await new Promise((resolve) => nginx!.once("exit", resolve));
  nginx = undefined;
  await close(oauthMock);

  await exec(oauthBin, ["--config", oauthConfig, "--config-test"]);
  oauth = spawn(oauthBin, ["--config", oauthConfig], { stdio: ["ignore", "ignore", "pipe"] });
  let oauthError = "";
  oauth.stderr?.on("data", (chunk) => { oauthError += chunk.toString(); });
  await poll(async () => {
    const response = await fetch("http://127.0.0.1:4180/ping", { redirect: "manual" });
    if (!response.ok) throw new Error(`oauth2-proxy not ready: ${response.status} ${oauthError}`);
  });
  const sockets = await exec("/usr/bin/ss", ["-H", "-ltn", "sport = :4180"]);
  if (!sockets.stdout.includes("127.0.0.1:4180") || sockets.stdout.includes("0.0.0.0:4180") || sockets.stdout.includes("[::]:4180")) {
    throw new Error("oauth2-proxy is not isolated to literal loopback");
  }
  nginx = spawn(nginxBin, ["-p", `${root}/`, "-c", nginxConfig, "-g", "daemon off;"], { stdio: ["ignore", "ignore", "pipe"] });
  nginxError = "";
  nginx.stderr?.on("data", (chunk) => { nginxError += chunk.toString(); });
  let oauthStart: Response | undefined;
  await poll(async () => {
    oauthStart = await tls("/oauth2/start?rd=%2F");
    if (oauthStart.status !== 302) throw new Error(`OAuth start route not ready: ${oauthStart.status} ${nginxError}`);
  });
  const authorization = String(oauthStart?.headers.location ?? "");
  if (!authorization.startsWith("https://github.com/login/oauth/authorize?")
    || !authorization.includes("client_id=synthetic-client-id")
    || !authorization.includes(encodeURIComponent(`https://${domain}/oauth2/callback`))) {
    throw new Error("OAuth authorization redirect shape is invalid");
  }
  const callback = await tls("/oauth2/callback");
  if (callback.status === 404 || callback.body.includes("<title>Pi Together</title>")) throw new Error("OAuth callback was not isolated to oauth2-proxy");

  process.stdout.write(JSON.stringify({
    ok: true,
    nginxAuthRequest: true,
    headerSpoofingRejected: true,
    sse: true,
    socketMode: "0660",
    oauthLoopback: true,
    unrelatedSitePreserved: true,
    noProviderCall: true,
  }) + "\n");
} finally {
  nginx?.kill("SIGTERM");
  oauth?.kill("SIGTERM");
  app?.kill("SIGTERM");
  await close(oauthMock).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
