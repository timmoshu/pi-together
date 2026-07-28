import { describe, expect, it } from "vitest";
import { renderNginxFunnelEdge } from "../deployment/templates.js";

const input = {
  domain: "node.tailnet.ts.net", listener: { kind: "unix" as const, path: "/run/pi-together/app.sock" },
  oauth2ProxyPort: 4180, proxySecret: "s".repeat(43), githubLogins: ["alice"], oauthClientId: "client",
  oauthClientSecretFile: "/run/credentials/oauth-secret", cookieSecretFile: "/run/credentials/cookie-secret",
  tlsCertificate: "/unused/fullchain.pem", tlsCertificateKey: "/unused/privkey.pem", acmeWebroot: "/unused/acme",
};
describe("Tailscale Funnel edge template", () => {
  it("binds only loopback and preserves the authenticated streaming edge", () => {
    const config = renderNginxFunnelEdge(input, { serviceUser: "example" });
    expect(config).toContain("listen 127.0.0.1:43118;");
    expect(config).not.toMatch(/listen (?:80|443|\[::\]|0\.0\.0\.0)/);
    expect(config).not.toContain("ssl_certificate");
    expect(config).toContain("auth_request /oauth2/auth;");
    expect(config).toContain("proxy_pass_request_headers off;");
    expect(config).toContain("X-Pi-Together-Proxy-Secret");
    expect(config).toContain("proxy_buffering off;");
    for (const path of ["client-body", "proxy", "fastcgi", "uwsgi", "scgi"]) {
      expect(config).toContain(`/run/pi-together-edge/nginx-${path}-temp`);
    }
    expect(config).toContain("pid /run/pi-together-edge/nginx-edge.pid;");
    expect(config).not.toContain("/var/lib/nginx");
    expect(config).toContain("https://node.tailnet.ts.net/oauth2/sign_in?rd=https://node.tailnet.ts.net$request_uri");
  });

  it("rejects an unsafe runtime directory override", () => {
    expect(() => renderNginxFunnelEdge(input, { serviceUser: "example", runtimeDirectory: "/run/../etc" })).toThrow(/normalized|unsupported/);
  });
});
