import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { compareUpgradeReleases, StableVersionSchema, UpgradeReleaseIdSchema } from "./release-identity.js";

export const RELEASE_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF2M+awOF5OQDX0u53KxX/qAfEwJO61ysJT71Ebg4xpE=
-----END PUBLIC KEY-----
`;
export const RELEASE_SIGNING_KEY_ID = "96a07c48ce48d9da04e9f0a26831532ed02ce54337fb4eed8fdf72f452b930d9";
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ReleaseMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.literal("stable"),
  version: StableVersionSchema,
  packageSha256: SHA256,
  releaseManifestSha256: SHA256,
  sourceRef: z.string().min(1).max(256),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  builder: z.literal("github-actions"),
  createdAt: z.string().datetime(),
}).strict().superRefine((metadata, context) => {
  if (metadata.sourceRef !== `refs/tags/v${metadata.version}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRef"], message: "release tag does not match version" });
  }
});
export type ReleaseMetadata = z.infer<typeof ReleaseMetadataSchema>;
export interface SignedRelease { metadata: ReleaseMetadata; keyId: string; signature: string }

export interface UpgradeIo {
  currentVersion(): Promise<string>;
  stage(candidate: SignedRelease): Promise<void>;
  migrateConfig(fromVersion: string, toVersion: string): Promise<void>;
  activate(fromVersion: string, toVersion: string): Promise<void>;
  restart(): Promise<void>;
  health(): Promise<void>;
  commit(fromVersion: string, toVersion: string): Promise<void>;
  rollback(fromVersion: string, toVersion: string): Promise<void>;
  recover(candidate: SignedRelease): Promise<"clean" | "rolled-back">;
}

export function candidateRelease(candidate: SignedRelease): string {
  return ReleaseMetadataSchema.parse(candidate.metadata).version;
}

export function selectUpgradeVersion(requested: string | undefined, available: string[], current: string): string {
  UpgradeReleaseIdSchema.parse(current);
  const releases = [...new Set(available.map((release) => UpgradeReleaseIdSchema.parse(release)))].sort(compareUpgradeReleases);
  const selected = requested === undefined || requested === "latest" ? releases.at(-1) : UpgradeReleaseIdSchema.parse(requested);
  if (!selected) throw new Error("no signed release is available");
  if (!releases.includes(selected)) throw new Error("requested release is unavailable");
  if (compareUpgradeReleases(selected, current) <= 0) throw new Error("upgrade target must be newer than the current release");
  return selected;
}

export function canonicalReleaseMetadata(metadata: ReleaseMetadata): Buffer {
  return Buffer.from(`${JSON.stringify(ReleaseMetadataSchema.parse(metadata), null, 2)}\n`);
}

export function validateSignedRelease(value: SignedRelease, publicKeyPem = RELEASE_SIGNING_PUBLIC_KEY_PEM): SignedRelease {
  const metadata = ReleaseMetadataSchema.parse(value.metadata);
  if (value.keyId !== RELEASE_SIGNING_KEY_ID || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)) {
    throw new Error("release signing identity is invalid");
  }
  const signature = Buffer.from(value.signature, "base64");
  if (signature.length !== 64 || !verify(null, canonicalReleaseMetadata(metadata), createPublicKey(publicKeyPem), signature)) {
    throw new Error("release signature verification failed");
  }
  return { metadata, keyId: value.keyId, signature: value.signature };
}

export function releaseManifestDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runUpgrade(candidateValue: SignedRelease, io: UpgradeIo): Promise<void> {
  const candidate = validateSignedRelease(candidateValue);
  const target = candidateRelease(candidate);
  await io.recover(candidate);
  const current = await io.currentVersion();
  if (compareUpgradeReleases(target, current) <= 0) throw new Error("signed release is not newer than the installed release");
  let activationAttempted = false;
  try {
    await io.stage(candidate);
    await io.migrateConfig(current, target);
    activationAttempted = true;
    await io.activate(current, target);
    await io.restart();
    await io.health();
    await io.commit(current, target);
  } catch (error) {
    if (activationAttempted) {
      try { await io.rollback(current, target); }
      catch { throw new Error("upgrade failed and rollback failed"); }
    }
    throw new Error(`upgrade failed: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
}
