import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderDeploymentTemplates } from "../deployment/templates.js";
import { renderAppService, renderOauth2ProxyService } from "../deployment/service-templates.js";

const output = process.argv[2];
const user = process.env.S16_SERVICE_USER;
const group = process.env.S16_SERVICE_GROUP;
const workspace = process.env.S16_WORKSPACE;
if (!output?.startsWith("/") || !user || !group || !workspace?.startsWith("/")) throw new Error("systemd integration rendering requires absolute typed inputs");
await mkdir(output, { recursive: true });
const config = {
  version: 2,
  mode: "reverse-proxy",
  listener: { kind: "unix", path: "/run/pi-together/app.sock" },
  publicOrigin: "https://pi.example.com",
  proxySecret: "p".repeat(43),
  principals: [{ provider: "github", subject: "1001", login: "alice", verifiedAt: "2026-07-25T00:00:00.000Z", verification: "verified" }],
  sharedRepositoryFolders: [workspace],
};
await writeFile(join(output, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(output, "pi-together.service"), renderAppService({
  nodePath: process.execPath,
  piPath: "/usr/bin/false",
  serviceUser: user,
  publicMode: true,
}));
const oauth = renderDeploymentTemplates({
  domain: "pi.example.com",
  listener: { kind: "unix", path: "/run/pi-together/app.sock" },
  oauth2ProxyPort: 4180,
  proxySecret: "p".repeat(43),
  githubLogins: ["alice"],
  oauthClientId: "synthetic-client-id",
  oauthClientSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-client-secret",
  cookieSecretFile: "/run/credentials/pi-together-oauth2-proxy.service/oauth-cookie-secret",
  tlsCertificate: "/etc/letsencrypt/live/pi.example.com/fullchain.pem",
  tlsCertificateKey: "/etc/letsencrypt/live/pi.example.com/privkey.pem",
  acmeWebroot: "/var/lib/pi-together/acme",
});
await writeFile(join(output, "oauth2-proxy.cfg"), oauth.oauth2ProxyConfig);
await writeFile(join(output, "pi-together-oauth2-proxy.service"), renderOauth2ProxyService());
await writeFile(join(output, "oauth-client.secret"), "synthetic-oauth-client-secret", { mode: 0o600 });
await writeFile(join(output, "oauth-cookie.secret"), "c".repeat(43), { mode: 0o600 });
await writeFile(join(output, "override.conf"), "[Service]\nEnvironment=PI_TOGETHER_ADAPTER=fake\n");
await writeFile(join(output, "identity"), `${user}:${group}\n`);
