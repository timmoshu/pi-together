import { z } from "zod";
import { ReleaseMetadataSchema, validateSignedRelease } from "../cli/upgrade-core.js";

export const UpgradeRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("upgrade"),
  candidate: z.object({ metadata: ReleaseMetadataSchema, keyId: z.string(), signature: z.string() }).strict(),
  archivePath: z.string().min(1),
  invokingUid: z.number().int().positive(),
}).strict();
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;
export function validateUpgradeRequest(value: unknown): UpgradeRequest {
  const request = UpgradeRequestSchema.parse(value);
  validateSignedRelease(request.candidate);
  if (!request.archivePath.startsWith("/") || request.archivePath.includes("\0") || request.archivePath.split("/").includes("..")) throw new Error("upgrade archive path is unsafe");
  return request;
}
