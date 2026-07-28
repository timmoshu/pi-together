import { describe, expect, it } from "vitest";
import { authorPresentation, canRespondToExtension, controlLostMessage, controllerPresentation, historySentence } from "../client/src/ui/presentation.js";
import type { DurableActor, LeaseHistoryEvent, PrincipalIdentity, TurnAttribution } from "../shared/protocol.js";

const alice = { provider: "github", subject: "1", login: "alice" } as const satisfies PrincipalIdentity;
const bob = { provider: "github", subject: "2", login: "bob" } as const satisfies PrincipalIdentity;
const attribution = (actor: DurableActor, action: TurnAttribution["action"] = "prompt"): TurnAttribution => ({
  requestId: "req_1", actor: { ...actor, provider: "github" }, action, issuedAt: "2026-07-25T00:00:00.000Z",
});

describe("multiplayer presentation", () => {
  it("labels own, other, and unattributed messages without device metadata", () => {
    expect(authorPresentation(attribution(alice), alice)).toEqual({ kind: "own", author: "You", action: null });
    expect(authorPresentation(attribution(bob, "steer"), alice)).toEqual({ kind: "other", author: "bob", action: "steered" });
    expect(authorPresentation(undefined, alice)).toEqual({ kind: "unattributed", author: "Local / unknown", action: null });
    expect(authorPresentation(undefined, { provider: "local", subject: "local", login: "Local user" }))
      .toEqual({ kind: "unattributed", author: "Local input", action: null });
  });

  it("distinguishes exact control, the same principal elsewhere, another principal, and none", () => {
    expect(controllerPresentation(null, alice)).toMatchObject({ relation: "none" });
    expect(controllerPresentation({ leaseId: "l", actor: alice, acquiredAt: 1, expiresAt: 2, isHolder: true }, alice))
      .toMatchObject({ relation: "mine", text: "You’re controlling this session in this tab." });
    expect(controllerPresentation({ leaseId: "l", actor: alice, acquiredAt: 1, expiresAt: 2 }, alice))
      .toMatchObject({ relation: "mine-elsewhere", text: "You’re controlling this session in another tab or device." });
    expect(controllerPresentation({ leaseId: "l", actor: bob, acquiredAt: 1, expiresAt: 2 }, alice))
      .toMatchObject({ relation: "other", text: "bob is controlling this session." });
  });

  it("lets an unattached viewer claim an unheld extension dialog, but keeps other holders read-only", () => {
    expect(canRespondToExtension(null)).toBe(true);
    expect(canRespondToExtension({ leaseId: "l", actor: alice, acquiredAt: 1, expiresAt: 2, isHolder: true })).toBe(true);
    expect(canRespondToExtension({ leaseId: "l", actor: bob, acquiredAt: 1, expiresAt: 2 })).toBe(false);
  });

  it("writes displaced-controller notices without exposing viewer identity", () => {
    expect(controlLostMessage({ samePrincipal: false, actor: bob })).toBe(
      "bob took over this session. You’re now viewing read-only. Your draft is saved.",
    );
    expect(controlLostMessage({ samePrincipal: true, actor: alice })).toBe(
      "This session was taken over in another tab or device. You’re now viewing read-only. Your draft is saved.",
    );
  });

  it("turns durable history into actor-aware sentences", () => {
    const event = (value: Partial<LeaseHistoryEvent>): LeaseHistoryEvent => ({
      requestId: "lease_1", event: "takenOver", occurredAt: "2026-07-25T00:00:00.000Z", ...value,
    });
    expect(historySentence(event({ previous: { actor: alice }, next: { actor: bob } }), alice)).toBe("bob took control from you.");
    expect(historySentence(event({ previous: { actor: alice }, next: { actor: alice }, sameActorViewerChanged: true }), alice))
      .toBe("You moved control to another tab or device.");
    expect(historySentence(event({ previous: { actor: bob }, next: { actor: bob }, sameActorViewerChanged: true }), alice))
      .toBe("bob moved control to another tab or device.");
    expect(historySentence(event({ event: "recovered", previous: { actor: alice }, next: { actor: bob } }), alice))
      .toBe("bob recovered control after a server restart.");
  });
});
