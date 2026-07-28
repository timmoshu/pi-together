import { describe, expect, it } from "vitest";
import {
  OAUTH2_PROXY_RELEASE,
  renderDeploymentTemplates,
  renderNginxFunnelEdge,
  renderNginxSite,
  renderOauth2ProxyConfig,
  type DeploymentTemplateInput,
} from "../deployment/templates.js";

const SECRET = "s".repeat(43);

function input(listener: DeploymentTemplateInput["listener"] = { kind: "unix", path: "/run/pi-together/app.sock" }): DeploymentTemplateInput {
  return {
    domain: "agents.example.com",
    listener,
    oauth2ProxyPort: 4180,
    proxySecret: SECRET,
    githubLogins: ["octocat", "hubot"],
    oauthClientId: "Iv1.example-client",
    oauthClientSecretFile: "/etc/pi-together/example/client.secret",
    cookieSecretFile: "/etc/pi-together/example/cookie.secret",
    tlsCertificate: "/etc/letsencrypt/live/agents.example.com/fullchain.pem",
    tlsCertificateKey: "/etc/letsencrypt/live/agents.example.com/privkey.pem",
    acmeWebroot: "/var/lib/pi-together/example/acme",
  };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("deployment security templates", () => {
  it.each([
    ["Unix socket", { kind: "unix", path: "/run/pi-together/app.sock" } as const, "server unix:/run/pi-together/app.sock;"],
    ["loopback fallback", { kind: "tcp", host: "127.0.0.1", port: 43117, fallback: true } as const, "server 127.0.0.1:43117;"],
  ])("renders the %s upstream without a broad bind", (_name, listener, expected) => {
    const nginx = renderNginxSite(input(listener));
    expect(nginx).toContain(expected);
    expect(nginx).not.toContain("0.0.0.0");
  });

  it("drops caller headers and sets only the two dedicated backend trust headers", () => {
    const nginx = renderNginxSite(input());

    expect(count(nginx, "proxy_pass_request_headers off;")).toBe(5);
    expect(count(nginx, "proxy_set_header X-Pi-Together-Proxy-Secret")).toBe(3);
    expect(count(nginx, "proxy_set_header X-Pi-Together-Login")).toBe(3);
    expect(nginx).not.toMatch(/\$http_(?:authorization|x_forwarded_user|x_auth_request|x_pi_together)/i);
    expect(nginx).not.toContain("X-Forwarded-Access-Token");
    expect(nginx).not.toContain("X-Auth-Request-Access-Token");
    expect(nginx).toContain("proxy_set_header Origin $http_origin;");
    expect(nginx).toContain("proxy_set_header Last-Event-ID $http_last_event_id;");
  });

  it("keeps OAuth cookies at nginx and forwards only oauth2-proxy's user result", () => {
    const nginx = renderNginxSite(input());

    expect(count(nginx, "proxy_set_header Cookie $http_cookie;")).toBe(2);
    expect(nginx).toContain("auth_request_set $pi_together_login $upstream_http_x_auth_request_user;");
    expect(nginx).toContain("proxy_set_header X-Pi-Together-Login $pi_together_login;");
    expect(nginx).not.toContain("proxy_set_header Cookie $http_cookie;\n    proxy_set_header X-Pi-Together");
  });

  it("renders an explicit GitHub allowlist and disables token/header forwarding", () => {
    const config = renderOauth2ProxyConfig(input());

    expect(config).toContain('provider = "github"');
    expect(config).toContain('http_address = "127.0.0.1:4180"');
    expect(config).toContain('github_users = ["hubot", "octocat"]');
    expect(config).toContain('email_domains = ["*"]');
    for (const setting of [
      "set_authorization_header",
      "set_basic_auth",
      "pass_access_token",
      "pass_authorization_header",
      "pass_basic_auth",
      "pass_user_headers",
      "pass_host_header",
      "skip_auth_strip_headers",
      "skip_auth_preflight",
      "show_debug_on_error",
      "request_logging",
    ]) {
      expect(config).toContain(`${setting} = false`);
    }
    expect(config).toContain("set_xauthrequest = true");
    expect(config).toContain("cookie_secure = true");
    expect(config).toContain("cookie_httponly = true");
    expect(config).toContain('cookie_samesite = "lax"');
    expect(config).toContain('cookie_name = "__Host-pi_together"');
    expect(config).not.toMatch(/^client_secret\s*=/m);
    expect(config).not.toMatch(/^cookie_secret\s*=/m);
  });

  it("applies the SSE buffering, transformation, timeout, and reconnect contract", () => {
    const nginx = renderNginxSite(input());
    const events = nginx.slice(nginx.indexOf("location = /events"), nginx.indexOf("location / {", nginx.indexOf("location = /events")));

    expect(events).toContain("proxy_buffering off;");
    expect(events).toContain("proxy_request_buffering off;");
    expect(events).toContain("proxy_cache off;");
    expect(events).toContain("gzip off;");
    expect(events).toContain("proxy_read_timeout 1h;");
    expect(events).toContain("proxy_send_timeout 1h;");
    expect(events).toContain('Cache-Control "no-cache, no-transform"');
    expect(events).toContain('X-Accel-Buffering "no"');
    expect(events).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(events).toContain("frame-ancestors 'none'");
    expect(events).toContain("Last-Event-ID $http_last_event_id");
  });

  it("redirects Funnel authentication through the canonical public HTTPS origin, never its private listener", () => {
    const nginx = renderNginxFunnelEdge(input(), { serviceUser: "example" });
    expect(nginx).toContain("return 302 https://agents.example.com/oauth2/sign_in?rd=https://agents.example.com$request_uri;");
    expect(nginx).not.toContain("http://$host:43118");
  });

  it("redacts the backend secret from reviewable output", () => {
    const rendered = renderDeploymentTemplates(input());
    expect(rendered.nginxSite).toContain(SECRET);
    expect(rendered.redacted.nginxSite).toContain("<redacted-proxy-secret>");
    expect(JSON.stringify(rendered.redacted)).not.toContain(SECRET);
    expect(rendered.oauth2ProxyConfig).not.toContain(SECRET);
  });

  it.each([
    ["domain injection", { domain: "agents.example.com; include /tmp/evil" }],
    ["path injection", { tlsCertificate: "/tmp/cert.pem; include /tmp/evil" }],
    ["path traversal", { tlsCertificate: "/etc/letsencrypt/../private/key.pem" }],
    ["login injection", { githubLogins: ["octocat", "bad login"] }],
    ["duplicate login", { githubLogins: ["octocat", "octocat"] }],
    ["broad OAuth listener collision", { oauth2ProxyPort: 43117, listener: { kind: "tcp", host: "127.0.0.1", port: 43117, fallback: true } }],
  ])("rejects %s without echoing the proxy secret", (_name, override) => {
    let message = "";
    try {
      renderDeploymentTemplates({ ...input(), ...override } as DeploymentTemplateInput);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(SECRET);
  });

  it("pins verified oauth2-proxy release metadata for supported architectures", () => {
    expect(OAUTH2_PROXY_RELEASE.version).toBe("7.15.3");
    expect(Object.keys(OAUTH2_PROXY_RELEASE.assets)).toEqual(["linux-x64", "linux-arm64"]);
    for (const asset of Object.values(OAUTH2_PROXY_RELEASE.assets)) {
      expect(asset.archive).toContain("v7.15.3.linux-");
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
