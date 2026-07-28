import { z } from "zod";

const DnsName = z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/);
export const FunnelActivationInspectionRequestSchema = z.object({
  protocolVersion: z.literal(1), action: z.literal("inspect-funnel-activation"), invokingUid: z.number().int().positive(), dnsName: DnsName,
}).strict();
export const FunnelActivationInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active") }).strict(),
  z.object({ status: z.literal("approval-required"), approvalUrl: z.string().url().regex(/^https:\/\/login\.tailscale\.com\/f\/funnel\?node=[A-Za-z0-9_-]+$/) }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
]);
export type FunnelActivationInspection = z.infer<typeof FunnelActivationInspectionSchema>;
