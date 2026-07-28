import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderNginxFunnelEdge, renderNginxSite, renderOauth2ProxyConfig, type DeploymentTemplateInput } from "../deployment/templates.js";

function fixtureInput(root: string, listener: DeploymentTemplateInput["listener"]): DeploymentTemplateInput {
  return {
    domain: "agents.example.com",
    listener,
    oauth2ProxyPort: 4180,
    proxySecret: "s".repeat(43),
    githubLogins: ["octocat", "hubot"],
    oauthClientId: "Iv1.example-client",
    oauthClientSecretFile: join(root, "client.secret"),
    cookieSecretFile: join(root, "cookie.secret"),
    tlsCertificate: join(root, "certificate.pem"),
    tlsCertificateKey: join(root, "certificate-key.pem"),
    acmeWebroot: join(root, "acme"),
  };
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function validateNativeTemplates(options: { nginx: string; oauth2Proxy: string; openssl?: string }): void {
  const root = mkdtempSync(join(tmpdir(), "pi-together-native-"));
  try {
    const openssl = options.openssl ?? "openssl";
    run(openssl, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=agents.example.com",
      "-keyout", join(root, "certificate-key.pem"),
      "-out", join(root, "certificate.pem"),
    ]);
    writeFileSync(join(root, "client.secret"), "synthetic-client-secret", { mode: 0o600 });
    writeFileSync(join(root, "cookie.secret"), Buffer.alloc(32, 7), { mode: 0o600 });

    const variants: DeploymentTemplateInput["listener"][] = [
      { kind: "unix", path: "/run/pi-together/app.sock" },
      { kind: "tcp", host: "127.0.0.1", port: 43117, fallback: true },
    ];
    for (const [index, listener] of variants.entries()) {
      const input = fixtureInput(root, listener);
      const configPath = join(root, `nginx-${index}.conf`);
      const site = renderNginxSite(input)
        .replace("listen 80;", "listen 127.0.0.1:18080;")
        .replace("listen [::]:80;", "listen [::1]:18081;")
        .replace("listen 443 ssl http2;", "listen 127.0.0.1:18443 ssl http2;")
        .replace("listen [::]:443 ssl http2;", "listen [::1]:18444 ssl http2;");
      writeFileSync(configPath, `
pid ${join(root, `nginx-${index}.pid`)};
error_log ${join(root, `nginx-${index}.error.log`)};
events {}
http {
  access_log off;
  client_body_temp_path ${join(root, `client-body-${index}`)};
  proxy_temp_path ${join(root, `proxy-${index}`)};
  fastcgi_temp_path ${join(root, `fastcgi-${index}`)};
  uwsgi_temp_path ${join(root, `uwsgi-${index}`)};
  scgi_temp_path ${join(root, `scgi-${index}`)};
${site}
}
`);
      run(options.nginx, ["-t", "-p", `${root}/`, "-c", configPath]);
    }

    const funnelConfig = join(root, "nginx-funnel.conf");
    const funnelRuntime = join(root, "nginx-funnel-runtime");
    mkdirSync(funnelRuntime, { mode: 0o755 });
    writeFileSync(funnelConfig, renderNginxFunnelEdge(fixtureInput(root, variants[0]!), {
      serviceUser: process.env.USER ?? "nobody",
      runtimeDirectory: funnelRuntime,
    }));
    run(options.nginx, ["-t", "-p", `${root}/`, "-c", funnelConfig]);

    const oauthConfig = join(root, "oauth2-proxy.cfg");
    writeFileSync(oauthConfig, renderOauth2ProxyConfig(fixtureInput(root, variants[0]!)), { mode: 0o600 });
    run(options.oauth2Proxy, ["--config", oauthConfig, "--config-test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("native-template-validation.ts")) {
  const nginx = process.env.NGINX_BIN ?? "nginx";
  const oauth2Proxy = process.env.OAUTH2_PROXY_BIN;
  if (!oauth2Proxy) throw new Error("OAUTH2_PROXY_BIN is required");
  validateNativeTemplates({ nginx, oauth2Proxy, openssl: process.env.OPENSSL_BIN });
  process.stdout.write("native deployment template validation passed\n");
}
