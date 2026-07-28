import { z } from "zod";

export const BoundedIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const GitHubActorSchema = z.object({
  provider: z.literal("github"),
  subject: z.string().regex(/^[1-9]\d*$/).max(32),
  login: z.string().min(1).max(39).regex(/^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/),
}).strict();
export const ControllerSchema = z.object({ actor: GitHubActorSchema, viewerId: BoundedIdSchema }).strict();

export const AttributionDataSchema = z.object({
  kind: z.literal("message"),
  requestId: BoundedIdSchema,
  actor: GitHubActorSchema,
  action: z.enum(["prompt", "steer", "followUp"]),
  viewerId: BoundedIdSchema,
  issuedAt: z.string().datetime(),
}).strict();
export type AttributionData = z.infer<typeof AttributionDataSchema>;

export const LeaseDataSchema = z.object({
  kind: z.literal("lease"),
  requestId: BoundedIdSchema,
  event: z.enum(["acquired", "released", "takenOver", "expired", "recovered"]),
  occurredAt: z.string().datetime(),
  previous: ControllerSchema.optional(),
  next: ControllerSchema.optional(),
}).strict().superRefine((data, context) => {
  const required = (field: "previous" | "next") => {
    if (!data[field]) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} controller is required` });
  };
  const forbidden = (field: "previous" | "next") => {
    if (data[field]) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} controller is not allowed` });
  };
  switch (data.event) {
    case "acquired": required("next"); forbidden("previous"); break;
    case "released":
    case "expired": required("previous"); forbidden("next"); break;
    case "takenOver":
    case "recovered": required("previous"); required("next"); break;
  }
});
export type LeaseData = z.infer<typeof LeaseDataSchema>;

export const ATTRIBUTION_CUSTOM_TYPE = "pi-together.attribution.v1";
export const LEASE_CUSTOM_TYPE = "pi-together.lease.v1";

export function parseAttributionEntry(entry: Record<string, unknown>): AttributionData | null {
  if (entry.type !== "custom" || entry.customType !== ATTRIBUTION_CUSTOM_TYPE) return null;
  const parsed = AttributionDataSchema.safeParse(entry.data);
  return parsed.success ? parsed.data : null;
}

export function parseLeaseEntry(entry: Record<string, unknown>): LeaseData | null {
  if (entry.type !== "custom" || entry.customType !== LEASE_CUSTOM_TYPE) return null;
  const parsed = LeaseDataSchema.safeParse(entry.data);
  return parsed.success ? parsed.data : null;
}
