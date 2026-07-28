import { z } from "zod";

export const CertificateDomainSchema = z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const CertificateInspectionRequestSchema = z.object({
  protocolVersion: z.literal(1), action: z.literal("inspect-certificate"), invokingUid: z.number().int().positive(), domain: CertificateDomainSchema,
}).strict();
export const CertificateInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z.object({
    status: z.literal("existing"),
    fullchainState: z.object({ kind: z.literal("symlink"), target: z.string().min(1).max(4096), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }).strict(),
    expiresAt: z.string().datetime(),
  }).strict(),
]);
export type CertificateInspection = z.infer<typeof CertificateInspectionSchema>;
