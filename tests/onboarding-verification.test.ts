import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OnboardingVerificationObserver } from "../server/onboarding-verification.js";
const dirs: string[] = []; afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
describe("post-apply authenticated observation", () => {
  it("records only the expected authenticated GitHub principal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pt-verify-")); dirs.push(dir); const challenge = join(dir, "challenge"); const proof = join(dir, "proof");
    await writeFile(challenge, `${JSON.stringify({ schemaVersion: 1, id: "a".repeat(32), expectedLogin: "alice", expiresAt: "2099-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const observer = new OnboardingVerificationObserver(challenge, proof);
    await observer.observe({ provider: "github", subject: "2", login: "bob" });
    await expect(readFile(proof)).rejects.toMatchObject({ code: "ENOENT" });
    await observer.observe({ provider: "github", subject: "1", login: "alice" });
    expect(JSON.parse(await readFile(proof, "utf8"))).toMatchObject({ id: "a".repeat(32), login: "alice" });
  });
});
