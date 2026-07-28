import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { candidateRelease, canonicalReleaseMetadata, RELEASE_SIGNING_KEY_ID, runUpgrade, selectUpgradeVersion, validateSignedRelease, type SignedRelease, type UpgradeIo } from "../cli/upgrade-core.js";

const candidate: SignedRelease = {
  metadata: {
    schemaVersion: 1, channel: "stable", version: "0.1.0", packageSha256: "c".repeat(64), releaseManifestSha256: "d".repeat(64),
    sourceRef: "refs/tags/v0.1.0", sourceCommit: "a".repeat(40), builder: "github-actions",
    createdAt: "2026-07-28T00:00:00.000Z",
  },
  keyId: RELEASE_SIGNING_KEY_ID,
  signature: "ME9OcwFR14qQlIwF+NJhDT9l08AsDT59s8d7D+ZS1Kc5bsnhNNiKrUU8sA97OX1AULLLuwl3jlumSNRo80SdDg==",
};

class FakeUpgradeIo implements UpgradeIo {
  events: string[] = [];
  fail?: string;
  rollbackFails = false;
  async currentVersion() { return "0.0.9"; }
  private event(name: string) { this.events.push(name); if (this.fail === name) throw new Error(`synthetic ${name} failure`); }
  async recover(): Promise<"clean" | "rolled-back"> { this.event("recover"); return "clean"; }
  async stage() { this.event("stage"); }
  async migrateConfig() { this.event("migrate"); }
  async activate() { this.event("activate"); }
  async restart() { this.event("restart"); }
  async health() { this.event("health"); }
  async commit() { this.event("commit"); }
  async rollback() { this.events.push("rollback"); if (this.rollbackFails) throw new Error("rollback failure"); }
}

describe("signed immutable upgrade state machine", () => {
  it("resolves exact and latest stable releases", () => {
    expect(selectUpgradeVersion(undefined, ["0.1.0", "0.2.0", "0.1.5"], "0.1.0")).toBe("0.2.0");
    expect(selectUpgradeVersion("0.1.5", ["0.1.5", "0.2.0"], "0.1.0")).toBe("0.1.5");
    for (const unsafe of ["main", "next", "refs/heads/main", "0.2.0-beta.1", "0.1.0-staging.1.gaaaaaaaaaaaa"]) {
      expect(() => selectUpgradeVersion(unsafe, ["0.2.0"], "0.1.0")).toThrow();
    }
    expect(() => selectUpgradeVersion("0.0.9", ["0.0.9"], "0.1.0")).toThrow(/newer/);
  });

  it("verifies only the final release signing identity and exact tag-bound metadata", () => {
    expect(RELEASE_SIGNING_KEY_ID).toBe("96a07c48ce48d9da04e9f0a26831532ed02ce54337fb4eed8fdf72f452b930d9");
    expect(validateSignedRelease(candidate)).toEqual(candidate);
    expect(() => validateSignedRelease({ ...candidate, signature: `A${candidate.signature.slice(1)}` })).toThrow(/signature/);
    expect(() => validateSignedRelease({ ...candidate, keyId: "f".repeat(64) })).toThrow(/identity/);
    const branch = structuredClone(candidate);
    branch.metadata.sourceRef = "refs/heads/main";
    expect(() => validateSignedRelease(branch)).toThrow();
    const digest = structuredClone(candidate);
    digest.metadata.releaseManifestSha256 = "e".repeat(64);
    expect(() => validateSignedRelease(digest)).toThrow(/signature/);
  });

  it("supports injected verification keys only with the pinned release key identity", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = {
      ...candidate,
      signature: sign(null, canonicalReleaseMetadata(candidate.metadata), privateKey).toString("base64"),
    };
    expect(candidateRelease(validateSignedRelease(signed, publicKey.export({ type: "spki", format: "pem" }).toString()))).toBe("0.1.0");
  });

  it("recovers an activated candidate before comparing the current version", async () => {
    const io = new FakeUpgradeIo();
    let current = "0.1.0";
    io.currentVersion = async () => current;
    io.recover = async () => { current = "0.0.9"; io.events.push("recover"); return "rolled-back"; };
    await runUpgrade(candidate, io);
    expect(io.events).toEqual(["recover", "stage", "migrate", "activate", "restart", "health", "commit"]);
  });

  it("runs ordered activation and commits only after health", async () => {
    const io = new FakeUpgradeIo();
    await runUpgrade(candidate, io);
    expect(io.events).toEqual(["recover", "stage", "migrate", "activate", "restart", "health", "commit"]);
  });

  it.each(["migrate", "activate", "restart", "health", "commit"])("rolls back after %s failure once activation may have changed state", async (step) => {
    const io = new FakeUpgradeIo();
    io.fail = step;
    await expect(runUpgrade(candidate, io)).rejects.toThrow(/upgrade failed/);
    expect(io.events.includes("rollback")).toBe(step !== "migrate");
  });

  it("reports rollback failure without pretending recovery", async () => {
    const io = new FakeUpgradeIo();
    io.fail = "health";
    io.rollbackFails = true;
    await expect(runUpgrade(candidate, io)).rejects.toThrow(/rollback failed/);
  });
});
