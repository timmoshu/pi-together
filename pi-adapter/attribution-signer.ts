import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  LeaseEnvelopeSchema,
  MessageEnvelopeSchema,
  canonicalEnvelopeBytes,
  encodeSignedEnvelope,
  hashContent,
  type EnvelopePayload,
  type SignedEnvelope,
} from "../extension/attribution-core.js";
import type { DurableActor, DurableLeaseEvent } from "../shared/protocol.js";

const EnvelopePayloadSchema = z.union([MessageEnvelopeSchema, LeaseEnvelopeSchema]);

export function signEnvelope(
  payload: EnvelopePayload,
  privateKey: KeyObject | string | Buffer,
): SignedEnvelope {
  const parsed = EnvelopePayloadSchema.parse(payload);
  return {
    payload: parsed,
    signature: sign(null, canonicalEnvelopeBytes(parsed), privateKey).toString("base64url"),
  };
}

export class AttributionSigner {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  }

  messageArm(input: {
    sessionId: string;
    requestId: string;
    actor: DurableActor;
    action: "prompt" | "steer" | "followUp";
    viewerId: string;
    text: string;
    now?: number;
  }): string {
    const now = input.now ?? Date.now();
    return encodeSignedEnvelope(signEnvelope({
      version: 1,
      kind: "message",
      sessionId: input.sessionId,
      requestId: input.requestId,
      actor: input.actor,
      action: input.action,
      viewerId: input.viewerId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15_000).toISOString(),
      nonce: randomBytes(24).toString("base64url"),
      contentSha256: hashContent(input.text),
    }, this.privateKey));
  }

  leaseEvent(input: {
    sessionId: string;
    requestId: string;
    event: DurableLeaseEvent["event"];
    previous?: DurableLeaseEvent["previous"];
    next?: DurableLeaseEvent["next"];
    now?: number;
  }): string {
    const now = input.now ?? Date.now();
    return encodeSignedEnvelope(signEnvelope({
      version: 1,
      kind: "lease",
      sessionId: input.sessionId,
      requestId: input.requestId,
      event: input.event,
      previous: input.previous,
      next: input.next,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15_000).toISOString(),
      nonce: randomBytes(24).toString("base64url"),
    }, this.privateKey));
  }
}
