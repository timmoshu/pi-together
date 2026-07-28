import { describe, expect, it } from "vitest";
import { renderFunnelEdgeService, renderFunnelService } from "../deployment/service-templates.js";

describe("Funnel service templates", () => {
  it("owns one exact foreground route without global mutation flags", () => {
    const unit = renderFunnelService();
    expect(unit).toContain("ExecStart=/usr/bin/tailscale funnel --https=443 --yes http://127.0.0.1:43118");
    expect(unit).not.toMatch(/--bg|reset|auth-key|login-server|hostname/);
    expect(unit).toContain("Requires=tailscaled.service pi-together-edge.service");
  });
  it("runs a dedicated native-validated loopback edge", () => {
    const unit = renderFunnelEdgeService();
    expect(unit).toContain("nginx -t -c /etc/pi-together/nginx-funnel.conf");
    expect(unit).toContain('daemon off;');
    expect(unit).toContain("Requires=pi-together.service pi-together-oauth2-proxy.service");
    expect(unit).toContain("ProtectSystem=strict\nRuntimeDirectory=pi-together-edge\nRuntimeDirectoryMode=0755\nReadWritePaths=/run/pi-together-edge");
  });
});
