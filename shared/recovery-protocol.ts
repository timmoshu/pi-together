import { z } from "zod";

export const PrivilegedActionSchema = z.enum(["apply", "login-tailscale", "manage-users", "manage-workspaces", "prepare-tailscale", "recover", "share", "upgrade", "uninstall"]);
export type PrivilegedAction = z.infer<typeof PrivilegedActionSchema>;
export const RecoverableActionSchema = PrivilegedActionSchema.exclude(["login-tailscale", "recover", "uninstall"]);
export type RecoverableAction = z.infer<typeof RecoverableActionSchema>;
export const RecoveryInspectionRequestSchema = z.object({
  protocolVersion: z.literal(1), action: z.literal("inspect-recovery"), invokingUid: z.number().int().positive(),
}).strict();
const RecoveryJournalSchema = z.object({ action: PrivilegedActionSchema, journalSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const RecoveryRequestSchema = z.object({
  protocolVersion: z.literal(1), action: z.literal("recover"), invokingUid: z.number().int().positive(),
  expectedAction: RecoverableActionSchema, expectedJournalSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const RecoveryInspectionSchema = z.object({ pending: z.array(RecoveryJournalSchema).max(8) }).strict();
export type RecoveryInspection = z.infer<typeof RecoveryInspectionSchema>;
