import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { z } from "zod";
import type { AuthenticatedPrincipal } from "./security.js";
const Challenge = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-f0-9]{32}$/), expectedLogin: z.string(), expiresAt: z.string().datetime() }).strict();
export class OnboardingVerificationObserver {
  constructor(private readonly challengePath = "/run/pi-together/onboarding-challenge.json", private readonly proofPath = "/run/pi-together/onboarding-proof.json") {}
  async observe(principal: AuthenticatedPrincipal): Promise<void> {
    let handle;
    try { handle = await open(this.challengePath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.size > 4096) return;
      const challenge = Challenge.parse(JSON.parse(await handle.readFile("utf8")));
      if (Date.parse(challenge.expiresAt) <= Date.now() || principal.login !== challenge.expectedLogin) return;
      const temp = `${this.proofPath}.${process.pid}.tmp`;
      const proof = await open(temp, "wx", 0o600);
      try { await proof.writeFile(`${JSON.stringify({ schemaVersion: 1, id: challenge.id, login: principal.login, observedAt: new Date().toISOString() })}\n`); await proof.sync(); } finally { await proof.close(); }
      await rename(temp, this.proofPath);
    } catch { /* Invalid runtime challenge never affects normal requests. */ }
    finally { await handle.close(); }
  }
  async cleanup(): Promise<void> { await Promise.all([rm(this.challengePath, { force: true }), rm(this.proofPath, { force: true })]); }
}
