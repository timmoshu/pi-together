import { createHash, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  AttributionDataSchema,
  BoundedIdSchema,
  ControllerSchema,
  GitHubActorSchema,
  LeaseDataSchema,
  type AttributionData,
  type LeaseData,
} from "../pi-adapter/collaboration-entries.js";

export const ARM_COMMAND = "pi-together-arm-v1";
export const LEASE_COMMAND = "pi-together-lease-v1";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonceSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const EnvelopeBase = {
  version: z.literal(1),
  sessionId: BoundedIdSchema,
  requestId: BoundedIdSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: NonceSchema,
};

export const MessageEnvelopeSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal("message"),
  actor: GitHubActorSchema,
  action: z.enum(["prompt", "steer", "followUp"]),
  viewerId: BoundedIdSchema,
  contentSha256: Sha256Schema,
}).strict();
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export const LeaseEnvelopeSchema = z.object({
  ...EnvelopeBase,
  kind: z.literal("lease"),
  event: z.enum(["acquired", "released", "takenOver", "expired", "recovered"]),
  previous: ControllerSchema.optional(),
  next: ControllerSchema.optional(),
}).strict().superRefine((envelope, context) => {
  const result = LeaseDataSchema.safeParse({
    kind: "lease",
    requestId: envelope.requestId,
    event: envelope.event,
    occurredAt: envelope.issuedAt,
    previous: envelope.previous,
    next: envelope.next,
  });
  if (!result.success) context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid lease transition" });
});
export type LeaseEnvelope = z.infer<typeof LeaseEnvelopeSchema>;
export type EnvelopePayload = MessageEnvelope | LeaseEnvelope;

export const SignedEnvelopeSchema = z.object({
  payload: z.union([MessageEnvelopeSchema, LeaseEnvelopeSchema]),
  signature: z.string().min(80).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type SignedEnvelope = z.infer<typeof SignedEnvelopeSchema>;

export interface InputEventLike {
  text: string;
  source: "interactive" | "rpc" | "extension" | string;
  streamingBehavior?: "steer" | "followUp";
}
export type InputResult = { action: "continue" } | { action: "handled" };

export interface AttributionCoreOptions {
  publicKey: KeyObject | string | Buffer;
  sessionId: () => string;
  appendEntry: (customType: string, data: AttributionData | LeaseData) => void;
  /** Reserve bounded turn state before append; false blocks, rollback runs if durable append fails. */
  reserveMessage?: (data: AttributionData) => false | (() => void) | undefined;
  now?: () => number;
  maxClockSkewMs?: number;
  maxLifetimeMs?: number;
  maxReplayEntries?: number;
  managed?: boolean;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalEnvelopeBytes(payload: EnvelopePayload): Buffer {
  return Buffer.from(JSON.stringify(canonicalValue(payload)), "utf8");
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function encodeSignedEnvelope(envelope: SignedEnvelope): string {
  return Buffer.from(JSON.stringify(SignedEnvelopeSchema.parse(envelope)), "utf8").toString("base64url");
}

export class AttributionExtensionCore {
  private pending: MessageEnvelope | null = null;
  private readonly replay = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxClockSkewMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxReplayEntries: number;
  private readonly managed: boolean;

  constructor(private readonly options: AttributionCoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? 30_000;
    this.maxReplayEntries = options.maxReplayEntries ?? 1_024;
    this.managed = options.managed ?? true;
  }

  get replaySize(): number { return this.replay.size; }
  get isArmed(): boolean { return this.pending !== null; }

  clear(): void {
    this.pending = null;
    this.replay.clear();
  }

  private pruneReplay(now: number): void {
    for (const [nonce, expiresAt] of this.replay) if (expiresAt <= now) this.replay.delete(nonce);
  }

  private validateSigned(encoded: unknown, expectedKind: EnvelopePayload["kind"]): EnvelopePayload | null {
    if (typeof encoded !== "string" || encoded.length > 24_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const parsed = SignedEnvelopeSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.payload.kind !== expectedKind) return null;
    const { payload, signature } = parsed.data;
    let valid = false;
    try {
      valid = verify(null, canonicalEnvelopeBytes(payload), this.options.publicKey, Buffer.from(signature, "base64url"));
    } catch {
      return null;
    }
    if (!valid || payload.sessionId !== this.options.sessionId()) return null;
    const now = this.now();
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
    if (issuedAt > now + this.maxClockSkewMs || expiresAt <= now || expiresAt <= issuedAt) return null;
    if (expiresAt - issuedAt > this.maxLifetimeMs) return null;
    this.pruneReplay(now);
    if (this.replay.has(payload.nonce) || this.replay.size >= this.maxReplayEntries) return null;
    return payload;
  }

  arm(encoded: unknown): boolean {
    try {
      if (this.pending) return false;
      const payload = this.validateSigned(encoded, "message");
      if (!payload || payload.kind !== "message") return false;
      this.replay.set(payload.nonce, Date.parse(payload.expiresAt));
      this.pending = payload;
      return true;
    } catch {
      return false;
    }
  }

  appendLease(encoded: unknown): boolean {
    try {
      const payload = this.validateSigned(encoded, "lease");
      if (!payload || payload.kind !== "lease") return false;
      this.replay.set(payload.nonce, Date.parse(payload.expiresAt));
      const data = LeaseDataSchema.parse({
        kind: "lease",
        requestId: payload.requestId,
        event: payload.event,
        occurredAt: payload.issuedAt,
        previous: payload.previous,
        next: payload.next,
      });
      this.options.appendEntry("pi-together.lease.v1", data);
      return true;
    } catch {
      return false;
    }
  }

  handleInput(event: InputEventLike, actionAllowed = true): InputResult {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return this.managed ? { action: "handled" } : { action: "continue" };
    if (!event || typeof event.text !== "string" || event.source !== "rpc") return { action: "handled" };
    const expectedBehavior = pending.action === "prompt" ? undefined : pending.action;
    if (event.streamingBehavior !== expectedBehavior) return { action: "handled" };
    if (hashContent(event.text) !== pending.contentSha256 || !actionAllowed) return { action: "handled" };
    const data = AttributionDataSchema.parse({
      kind: "message",
      requestId: pending.requestId,
      actor: pending.actor,
      action: pending.action,
      viewerId: pending.viewerId,
      issuedAt: pending.issuedAt,
    });
    let rollback: (() => void) | undefined;
    try {
      const reservation = this.options.reserveMessage?.(data);
      if (reservation === false) return { action: "handled" };
      rollback = reservation;
      this.options.appendEntry("pi-together.attribution.v1", data);
      return { action: "continue" };
    } catch {
      rollback?.();
      return { action: "handled" };
    }
  }
}
