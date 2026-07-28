import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { z } from "zod";
const Proof = z.object({ schemaVersion: z.literal(1), id: z.string(), login: z.string(), observedAt: z.string().datetime() }).strict();
export async function verifyPublicLogin(input: { origin: string; expectedLogin: string; write(message: string): void; timeoutMs?: number; runtimeDir?: string }): Promise<boolean> {
  const runtime = input.runtimeDir ?? "/run/pi-together"; const challengePath = `${runtime}/onboarding-challenge.json`; const proofPath = `${runtime}/onboarding-proof.json`;
  await Promise.all([rm(challengePath, { force: true }), rm(proofPath, { force: true })]);
  const id = randomBytes(16).toString("hex"); const challenge = await open(challengePath, "wx", 0o600);
  try { await challenge.writeFile(`${JSON.stringify({ schemaVersion: 1, id, expectedLogin: input.expectedLogin, expiresAt: new Date(Date.now() + (input.timeoutMs ?? 10 * 60_000)).toISOString() })}\n`); await challenge.sync(); } finally { await challenge.close(); }
  input.write(`\nOpen ${input.origin} and sign in with GitHub as ${input.expectedLogin}. Waiting for authenticated confirmation…\n`);
  const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
  try {
    while (Date.now() < deadline) {
      try { const handle = await open(proofPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await handle.stat(); const proof = Proof.parse(JSON.parse(await handle.readFile("utf8"))); if (info.isFile() && (info.mode & 0o777) === 0o600 && proof.id === id && proof.login === input.expectedLogin) { input.write(`GitHub sign-in verified for ${proof.login}.\n`); return true; } } finally { await handle.close(); } } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    input.write("Sign-in verification timed out. The local stack remains installed; check OAuth settings and rerun doctor.\n"); return false;
  } finally { await Promise.all([rm(challengePath, { force: true }), rm(proofPath, { force: true })]); }
}
