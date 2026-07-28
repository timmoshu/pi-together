export const TAILSCALE_COMPATIBILITY = ">=1.98.8 <1.99.0";
export const TAILSCALE_RELEASE = {
  version: "1.98.9",
  package: "tailscale",
  architecture: "amd64",
  bytes: 37_102_668,
  sha256: "c739c29ec2342cc7df1a24cd102a3dfb51b359f79338d433ce8f052aeebc62ff",
  urls: {
    debian: "https://pkgs.tailscale.com/stable/debian/pool/tailscale_1.98.9_amd64.deb",
    ubuntu: "https://pkgs.tailscale.com/stable/ubuntu/pool/tailscale_1.98.9_amd64.deb",
  },
  termsUrl: "https://tailscale.com/terms",
  funnelDocsUrl: "https://tailscale.com/docs/features/tailscale-funnel",
  license: "BSD-3-Clause",
  funnelStage: "beta",
} as const;

export function supportsTailscaleVersion(output: string): boolean {
  const match = output.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  return !!match && Number(match[1]) === 1 && Number(match[2]) === 98 && Number(match[3]) >= 8;
}
