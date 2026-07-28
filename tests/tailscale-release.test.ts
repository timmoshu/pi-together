import { describe, expect, it } from "vitest";
import { supportsTailscaleVersion, TAILSCALE_RELEASE } from "../deployment/tailscale-release.js";
import { LoginTailscaleRequestSchema, PrepareTailscaleRequestSchema } from "../privileged/tailscale-prepare.js";

describe("pinned Tailscale contract", () => {
  it("pins one official amd64 package and external trust disclosures", () => {
    expect(TAILSCALE_RELEASE.version).toBe("1.98.9");
    expect(TAILSCALE_RELEASE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(TAILSCALE_RELEASE.bytes).toBe(37_102_668);
    expect(Object.values(TAILSCALE_RELEASE.urls).every((url) => url.startsWith("https://pkgs.tailscale.com/stable/"))).toBe(true);
    expect(TAILSCALE_RELEASE.funnelStage).toBe("beta");
  });

  it("accepts only an explicit, typed terms-approved preparation request", () => {
    expect(PrepareTailscaleRequestSchema.parse({ protocolVersion: 1, action: "prepare-tailscale", invokingUid: 1000, distro: "debian", acceptedTerms: true })).toBeTruthy();
    expect(() => PrepareTailscaleRequestSchema.parse({ protocolVersion: 1, action: "prepare-tailscale", invokingUid: 1000, distro: "debian", acceptedTerms: false })).toThrow();
    expect(() => PrepareTailscaleRequestSchema.parse({ protocolVersion: 1, action: "prepare-tailscale", invokingUid: 1000, distro: "debian", acceptedTerms: true, url: "https://attacker" })).toThrow();
    expect(LoginTailscaleRequestSchema.parse({ protocolVersion: 1, action: "login-tailscale", invokingUid: 1000 })).toBeTruthy();
  });

  it.each([
    ["1.98.8\n  tailscale commit: synthetic", true],
    ["1.98.9", true],
    ["1.98.7", false],
    ["1.99.0", false],
    ["2.0.0", false],
    ["malformed", false],
  ])("checks the qualified CLI line %s", (version, supported) => {
    expect(supportsTailscaleVersion(version)).toBe(supported);
  });
});
