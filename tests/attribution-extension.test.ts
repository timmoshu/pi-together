import { generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AttributionExtensionCore,
  canonicalEnvelopeBytes,
  encodeSignedEnvelope,
  hashContent,
  type InputEventLike,
  type MessageEnvelope,
} from "../extension/attribution-core.js";
import { signEnvelope } from "../pi-adapter/attribution-signer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const NOW = Date.parse("2025-01-02T03:04:05.000Z");
const actor = { provider: "github" as const, subject: "12345", login: "octocat" };
let nonceCounter = 0;
const nonce = () => `nonce_${String(++nonceCounter).padStart(16, "0")}`;

function payload(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  const text = overrides.action === "steer" ? "steer text" : overrides.action === "followUp" ? "follow text" : "hello";
  return {
    version: 1,
    kind: "message",
    sessionId: "session_1",
    requestId: `req_${nonceCounter + 1}`,
    actor,
    action: "prompt",
    viewerId: "viewer_a",
    issuedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 10_000).toISOString(),
    nonce: nonce(),
    contentSha256: hashContent(text),
    ...overrides,
  };
}

function encoded(value: MessageEnvelope): string {
  return encodeSignedEnvelope(signEnvelope(value, privateKey));
}

function makeCore(options: { maxReplayEntries?: number; managed?: boolean; now?: () => number; appendThrows?: boolean; reserve?: (data: unknown) => false | (() => void) | undefined } = {}) {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const core = new AttributionExtensionCore({
    publicKey,
    sessionId: () => "session_1",
    now: options.now ?? (() => NOW),
    maxReplayEntries: options.maxReplayEntries,
    managed: options.managed,
    appendEntry: (customType, data) => {
      if (options.appendThrows) throw new Error("synthetic append failure");
      appended.push({ customType, data });
    },
    reserveMessage: options.reserve,
  });
  return { core, appended };
}

beforeEach(() => { nonceCounter = 0; });

describe("signed attribution extension core", () => {
  it("canonically encodes payloads and verifies one exact RPC input", () => {
    const p = payload();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as MessageEnvelope;
    expect(canonicalEnvelopeBytes(p)).toEqual(canonicalEnvelopeBytes(reordered));
    expect(canonicalEnvelopeBytes({ ...p, actor }).toString("utf8")).toBe(
      JSON.stringify({
        action: p.action,
        actor: { login: actor.login, provider: actor.provider, subject: actor.subject },
        contentSha256: p.contentSha256,
        expiresAt: p.expiresAt,
        issuedAt: p.issuedAt,
        kind: p.kind,
        nonce: p.nonce,
        requestId: p.requestId,
        sessionId: p.sessionId,
        version: p.version,
        viewerId: p.viewerId,
      }),
    );

    const { core, appended } = makeCore();
    expect(core.arm(encoded(p))).toBe(true);
    expect(core.handleInput({ text: "hello", source: "rpc" })).toEqual({ action: "continue" });
    expect(appended).toEqual([{
      customType: "pi-together.attribution.v1",
      data: expect.objectContaining({ requestId: p.requestId, actor, action: "prompt", viewerId: "viewer_a" }),
    }]);
    expect(core.isArmed).toBe(false);
  });

  it.each([
    ["wrong content", payload(), { text: "changed", source: "rpc" }],
    ["wrong source", payload(), { text: "hello", source: "interactive" }],
    ["wrong prompt behavior", payload(), { text: "hello", source: "rpc", streamingBehavior: "steer" }],
    ["wrong steer behavior", payload({ action: "steer", contentSha256: hashContent("steer text") }), { text: "steer text", source: "rpc" }],
  ] as const)("handles %s without append or throw", (_name, p, event) => {
    const { core, appended } = makeCore();
    expect(core.arm(encoded(p))).toBe(true);
    let result: ReturnType<typeof core.handleInput> | undefined;
    expect(() => { result = core.handleInput(event as InputEventLike); }).not.toThrow();
    expect(result).toEqual({ action: "handled" });
    expect(appended).toEqual([]);
  });

  it("rejects an otherwise valid normal prompt when Pi is already running", () => {
    const { core, appended } = makeCore();
    expect(core.arm(encoded(payload()))).toBe(true);
    expect(core.handleInput({ text: "hello", source: "rpc" }, false)).toEqual({ action: "handled" });
    expect(appended).toEqual([]);
    expect(core.isArmed).toBe(false);
  });

  it("binds steer and follow-up actions to streaming behavior", () => {
    for (const [action, text] of [["steer", "steer text"], ["followUp", "follow text"]] as const) {
      const { core, appended } = makeCore();
      const p = payload({ action, contentSha256: hashContent(text) });
      expect(core.arm(encoded(p))).toBe(true);
      expect(core.handleInput({ text, source: "rpc", streamingBehavior: action })).toEqual({ action: "continue" });
      expect(appended[0]?.data).toEqual(expect.objectContaining({ action }));
    }
  });

  it("rejects malformed, bad-signature, wrong-session, expired, future, and overlong envelopes", () => {
    const { core } = makeCore();
    expect(core.arm("not-json")).toBe(false);
    expect(core.arm(undefined)).toBe(false);
    const wrongSession = payload({ sessionId: "session_2" });
    expect(core.arm(encoded(wrongSession))).toBe(false);
    const malformedInput = payload({ requestId: "req_malformed_input" });
    expect(core.arm(encoded(malformedInput))).toBe(true);
    expect(() => core.handleInput(null as unknown as InputEventLike)).not.toThrow();
    expect(core.isArmed).toBe(false);
    expect(core.arm(encoded(payload({ expiresAt: new Date(NOW).toISOString() })))).toBe(false);
    expect(core.arm(encoded(payload({ issuedAt: new Date(NOW + 6_000).toISOString(), expiresAt: new Date(NOW + 8_000).toISOString() })))).toBe(false);
    expect(core.arm(encoded(payload({ expiresAt: new Date(NOW + 31_000).toISOString() })))).toBe(false);

    const signed = signEnvelope(payload(), privateKey);
    signed.signature = Buffer.from(randomBytes(64)).toString("base64url");
    expect(core.arm(encodeSignedEnvelope(signed))).toBe(false);
  });

  it("rejects replay and a second arm while preserving the first pending message", () => {
    const { core, appended } = makeCore();
    const first = payload({ requestId: "req_first" });
    const second = payload({ requestId: "req_second" });
    const firstEncoded = encoded(first);
    expect(core.arm(firstEncoded)).toBe(true);
    expect(core.arm(encoded(second))).toBe(false);
    expect(core.handleInput({ text: "hello", source: "rpc" })).toEqual({ action: "continue" });
    expect(appended[0]?.data).toEqual(expect.objectContaining({ requestId: "req_first" }));
    expect(core.arm(firstEncoded)).toBe(false);
  });

  it("bounds replay memory and prunes expired nonces", () => {
    let now = NOW;
    const { core } = makeCore({ maxReplayEntries: 2, now: () => now });
    for (let index = 0; index < 2; index++) {
      expect(core.arm(encoded(payload({ requestId: `req_${index}` })))).toBe(true);
      core.handleInput({ text: "hello", source: "rpc" });
    }
    expect(core.replaySize).toBe(2);
    expect(core.arm(encoded(payload({ requestId: "req_full" })))).toBe(false);
    now += 11_000;
    const fresh = payload({ requestId: "req_fresh", issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 10_000).toISOString() });
    expect(core.arm(encoded(fresh))).toBe(true);
    expect(core.replaySize).toBe(1);
  });

  it("blocks unarmed managed input and allows explicit unmanaged local input", () => {
    expect(makeCore().core.handleInput({ text: "plain", source: "rpc" })).toEqual({ action: "handled" });
    expect(makeCore({ managed: false }).core.handleInput({ text: "plain", source: "interactive" })).toEqual({ action: "continue" });
  });

  it("continues only when the persisted attribution is accepted by bounded turn identity state", () => {
    const accepted: unknown[] = [];
    const allowed = makeCore({ reserve: (data) => { accepted.push(data); return () => { accepted.pop(); }; } });
    expect(allowed.core.arm(encoded(payload()))).toBe(true);
    expect(allowed.core.handleInput({ text: "hello", source: "rpc" })).toEqual({ action: "continue" });
    expect(accepted).toHaveLength(1);

    const full = makeCore({ reserve: () => false });
    expect(full.core.arm(encoded(payload({ requestId: "req_full_queue" })))).toBe(true);
    expect(full.core.handleInput({ text: "hello", source: "rpc" })).toEqual({ action: "handled" });
  });

  it("handles append failure rather than allowing unattributed input and rolls back reservation", () => {
    let reserved = 0;
    const { core } = makeCore({
      appendThrows: true,
      reserve: () => { reserved++; return () => { reserved--; }; },
    });
    expect(core.arm(encoded(payload()))).toBe(true);
    expect(core.handleInput({ text: "hello", source: "rpc" })).toEqual({ action: "handled" });
    expect(reserved).toBe(0);
  });

  it("validates and appends a signed lease exactly once", () => {
    const { core, appended } = makeCore();
    const lease = {
      version: 1 as const,
      kind: "lease" as const,
      sessionId: "session_1",
      requestId: "lease_1",
      issuedAt: new Date(NOW - 1_000).toISOString(),
      expiresAt: new Date(NOW + 10_000).toISOString(),
      nonce: nonce(),
      event: "acquired" as const,
      next: { actor, viewerId: "viewer_a" },
    };
    const value = encodeSignedEnvelope(signEnvelope(lease, privateKey));
    expect(core.appendLease(value)).toBe(true);
    expect(core.appendLease(value)).toBe(false);
    expect(appended).toEqual([{
      customType: "pi-together.lease.v1",
      data: expect.objectContaining({ requestId: "lease_1", event: "acquired", next: lease.next }),
    }]);
  });

  it("stops later handlers on invalid input even when earlier handlers throw or mutate", () => {
    const { core, appended } = makeCore();
    const laterCalls: string[] = [];
    const run = (event: InputEventLike, handlers: Array<(event: InputEventLike) => InputResult | void>) => {
      let current = event;
      for (const handler of handlers) {
        try {
          const result = handler(current);
          if (result?.action === "handled") return false;
          if (result && "text" in result) current = { ...current, text: String(result.text) };
        } catch { /* Pi continues after extension errors. */ }
      }
      return true;
    };
    type InputResult = { action: "handled" | "continue" } | { action: "transform"; text: string };

    expect(core.arm(encoded(payload()))).toBe(true);
    expect(run({ text: "hello", source: "rpc" }, [
      () => { throw new Error("synthetic earlier failure"); },
      () => ({ action: "transform", text: "mutated" }),
      (event) => core.handleInput(event),
      () => { laterCalls.push("later"); },
    ])).toBe(false);
    expect(appended).toEqual([]);
    expect(laterCalls).toEqual([]);

    const valid = makeCore();
    expect(valid.core.arm(encoded(payload()))).toBe(true);
    expect(run({ text: "hello", source: "rpc" }, [
      () => ({ action: "continue" }),
      (event) => valid.core.handleInput(event),
      () => { throw new Error("synthetic later failure"); },
      () => { laterCalls.push("valid-later"); },
    ])).toBe(true);
    expect(valid.appended).toHaveLength(1);
    expect(laterCalls).toEqual(["valid-later"]);
  });
});
