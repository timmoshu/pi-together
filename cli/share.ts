import { createHash } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadUserManagementState } from "./users.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";
import { AppConfigSchema } from "../server/config.js";
import type { ShareRequest } from "../privileged/share.js";
import { verifyPublicLogin } from "./verify-login.js";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export async function runShareCommand(args: string[], options: { uid?: number; confirm?: (m: string) => Promise<boolean>; write?: (m: string) => void; invoke?: (r: ShareRequest) => Promise<void>; load?: typeof loadUserManagementState } = {}): Promise<boolean> {
  const [operation, ...rest] = args; if (!['enable','disable','status','verify'].includes(operation ?? '') || rest.some((v) => v !== '--yes')) throw new Error("Usage: pi-together share enable|disable|status|verify [--yes]");
  const uid = options.uid ?? process.getuid?.(); if (!uid || uid === 0) throw new Error("sharing must run as the non-root Pi service user");
  const write = options.write ?? ((m: string) => stdout.write(m)); const state = await (options.load ?? loadUserManagementState)(uid);
  const config = AppConfigSchema.parse(JSON.parse(state.appConfig)); if (config.mode !== "tailscale-funnel") throw new Error("share commands require a Tailscale Funnel installation");
  if (operation === "status") { write(`Funnel origin: ${config.publicOrigin}\nRun \`pi-together status\` for owned service state.\n`); return true; }
  if (operation === "verify") return verifyPublicLogin({ origin: config.publicOrigin, expectedLogin: config.principals[0]!.login, write });
  if (!rest.includes('--yes')) {
    let confirmed: boolean;
    if (options.confirm) confirmed = await options.confirm(`${operation} public sharing at ${config.publicOrigin}?`);
    else { const prompt = createInterface({ input: stdin, output: stdout }); try { confirmed = /^(?:y|yes)$/i.test((await prompt.question(`${operation} public sharing at ${config.publicOrigin}? [y/N] `)).trim()); } finally { prompt.close(); } }
    if (!confirmed) return false;
  }
  const request: ShareRequest = { protocolVersion: 1, action: "share", operation: operation as "enable"|"disable", invokingUid: uid, expected: { configSha256: sha(state.appConfig), manifestSha256: sha(state.manifest) } };
  await (options.invoke ?? ((r) => runPrivilegedLifecycle(r, "share")))(request); write(`Public sharing ${operation === 'enable' ? 'enabled' : 'disabled'}: ${config.publicOrigin}\n`); return true;
}
