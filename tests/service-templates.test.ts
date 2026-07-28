import { describe, expect, it } from "vitest";
import { renderNginxChallengeSite } from "../deployment/templates.js";
import { renderAppService, renderOauth2ProxyService, renderRenewalHook } from "../deployment/service-templates.js";

describe("installer service and challenge templates", () => {
  it("renders a constrained app unit without a shell or write-blocking Pi home sandbox", () => {
    const unit = renderAppService({ nodePath: "/opt/node/bin/node", piPath: "/opt/node/bin/pi", serviceUser: "example", publicMode: true });
    expect(unit).toContain("ExecStart=/opt/node/bin/node /opt/pi-together/current/server/index.js");
    expect(unit).toContain("User=example");
    expect(unit).toContain("Environment=PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(unit).toContain("Environment=PI_BIN=/opt/node/bin/pi");
    expect(unit).toContain("Environment=PI_TOGETHER_CLIENT_DIR=/opt/pi-together/current/client");
    expect(unit).toContain("Environment=PI_TOGETHER_ATTRIBUTION_EXTENSION=/opt/pi-together/current/extension/pi-together-attribution-v1.js");
    expect(unit).toContain("Environment=PI_TOGETHER_GIT_LAUNCHER=/opt/pi-together/current/extension/git-bin/git");
    expect(unit).toContain("Restart=on-failure\nRestartSec=250ms");
    expect(unit).toContain("ProtectSystem=full");
    expect(unit).toContain("ProtectHome=false");
    expect(unit).toContain("RuntimeDirectory=pi-together");
    expect(unit).not.toContain("/bin/sh");
  });

  it.each([
    { nodePath: "/opt/node/bin/node; touch /tmp/pwn", piPath: "/opt/node/bin/pi", serviceUser: "example", publicMode: false },
    { nodePath: "node", piPath: "/opt/node/bin/pi", serviceUser: "example", publicMode: false },
    { nodePath: "/usr/bin/node", piPath: "pi; bad", serviceUser: "example", publicMode: false },
    { nodePath: "/usr/bin/node", piPath: "/usr/bin/pi", serviceUser: "bad user", publicMode: false },
  ])("rejects unsafe app unit input %#", (input) => {
    expect(() => renderAppService(input)).toThrow();
  });

  it("renders a temporary HTTP-only ACME challenge site before TLS activation", () => {
    const site = renderNginxChallengeSite("pi.example.com", "/var/lib/pi-together/acme");
    expect(site).toContain("listen 80;");
    expect(site).toContain("/.well-known/acme-challenge/");
    expect(site).not.toContain("listen 443");
    expect(site).not.toContain("Strict-Transport-Security");
    expect(() => renderNginxChallengeSite("pi.example.com; include /tmp/x", "/tmp/acme")).toThrow();
  });

  it("renders fixed oauth2-proxy and renewal units without caller-controlled commands", () => {
    expect(renderOauth2ProxyService()).toContain("DynamicUser=yes");
    expect(renderOauth2ProxyService()).toContain("LoadCredential=oauth-config:/etc/pi-together/oauth2-proxy.cfg");
    expect(renderOauth2ProxyService()).toContain("LoadCredential=oauth-client-secret:/etc/pi-together/oauth-client.secret");
    expect(renderOauth2ProxyService()).toContain("ExecStartPre=/opt/pi-together/helpers/oauth2-proxy --config=/run/credentials/pi-together-oauth2-proxy.service/oauth-config --config-test");
    expect(renderOauth2ProxyService()).toContain("ExecStart=/opt/pi-together/helpers/oauth2-proxy --config=/run/credentials/pi-together-oauth2-proxy.service/oauth-config");
    expect(renderRenewalHook()).toBe("#!/bin/sh\nset -eu\n/usr/sbin/nginx -t\nexec /bin/systemctl reload nginx.service\n");
  });
});
