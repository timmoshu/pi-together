import { readFile } from "node:fs/promises";
import { stdout } from "node:process";
import { TAILSCALE_RELEASE } from "../deployment/tailscale-release.js";
import { probeTailscale } from "./tailscale-discovery.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";
import type { LoginTailscaleRequest, PrepareTailscaleRequest } from "../privileged/tailscale-prepare.js";
export async function runTailscaleLogin(options: { uid?: number; invoke?: (request: LoginTailscaleRequest) => Promise<void> } = {}): Promise<void> {
  const uid = options.uid ?? process.getuid?.(); if (!uid || uid === 0) throw new Error("Tailscale login must run as the non-root Pi user");
  const request: LoginTailscaleRequest = { protocolVersion: 1, action: "login-tailscale", invokingUid: uid };
  await (options.invoke ?? ((value) => runPrivilegedLifecycle(value, "Tailscale login")))(request);
  const state = await probeTailscale(); if (state.status !== "ready") throw new Error("Tailscale login finished but the node is not ready");
}

export async function runTailscalePrepare(options: { uid?: number; acceptedTerms?: boolean; write?: (m: string) => void; invoke?: (r: PrepareTailscaleRequest) => Promise<void> } = {}): Promise<void> {
  const uid = options.uid ?? process.getuid?.(); if (!uid || uid === 0) throw new Error("Tailscale preparation must run as the non-root Pi user");
  const write = options.write ?? ((m: string) => stdout.write(m)); const current = await probeTailscale();
  if (current.status === "ready" || current.status === "needs-login") { write("A compatible Tailscale client is already installed.\n"); return; }
  if (current.status !== "missing") throw new Error("an existing Tailscale installation is incompatible or unsafe; it will not be changed automatically");
  if (!options.acceptedTerms) throw new Error(`Review ${TAILSCALE_RELEASE.termsUrl}, then rerun with --accept-terms`);
  const os = await readFile("/etc/os-release", "utf8"); const id = os.match(/^ID=(?:"?)(debian|ubuntu)(?:"?)$/m)?.[1]; if (id !== "debian" && id !== "ubuntu") throw new Error("unsupported distro");
  const request: PrepareTailscaleRequest = { protocolVersion: 1, action: "prepare-tailscale", invokingUid: uid, distro: id, acceptedTerms: true };
  await (options.invoke ?? ((r) => runPrivilegedLifecycle(r, "Tailscale preparation")))(request);
  write("Tailscale installed. Continue with Tailscale login; guided onboarding does this in the same run.\n");
}
