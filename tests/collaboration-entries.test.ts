import { describe, expect, it } from "vitest";
import {
  AttributionDataSchema,
  LeaseDataSchema,
  parseAttributionEntry,
} from "../pi-adapter/collaboration-entries.js";
import { normalizeSessionEntries, type RawSessionEntry } from "../pi-adapter/normalize.js";

const actor = { provider: "github" as const, subject: "12345", login: "octocat" };
const controller = { actor, viewerId: "viewer_a" };
const at = "2025-01-02T03:04:05.000Z";

function marker(id: string, parentId: string | null, requestId = id): RawSessionEntry {
  return {
    type: "custom", id, parentId, customType: "pi-together.attribution.v1",
    data: { kind: "message", requestId, actor, action: "prompt", viewerId: "viewer_a", issuedAt: at },
  };
}
function user(id: string, parentId: string | null, text = id): RawSessionEntry {
  return { type: "message", id, parentId, message: { role: "user", content: text, timestamp: 1 } };
}
function assistant(id: string, parentId: string | null): RawSessionEntry {
  return { type: "message", id, parentId, message: { role: "assistant", content: "working", timestamp: 2 } };
}

describe("collaboration custom-entry schemas", () => {
  it("accepts a bounded attribution entry and rejects unknown or sensitive fields", () => {
    const data = { kind: "message", requestId: "req_1", actor, action: "followUp", viewerId: "viewer_a", issuedAt: at };
    expect(AttributionDataSchema.parse(data)).toEqual(data);
    for (const invalid of [
      { ...data, email: "person@example.invalid" },
      { ...data, token: "synthetic-token" },
      { ...data, actor: { ...actor, subject: "not-numeric" } },
      { ...data, actor: { ...actor, login: "NotCanonical" } },
      { ...data, requestId: "x".repeat(129) },
      { ...data, issuedAt: "yesterday" },
    ]) expect(AttributionDataSchema.safeParse(invalid).success).toBe(false);
  });

  it.each([
    ["acquired", undefined, controller],
    ["released", controller, undefined],
    ["expired", controller, undefined],
    ["takenOver", controller, { ...controller, viewerId: "viewer_b" }],
    ["recovered", controller, { ...controller, viewerId: "viewer_b" }],
  ] as const)("validates %s lease transition shape", (event, previous, next) => {
    const data = { kind: "lease", requestId: `lease_${event}`, event, occurredAt: at, previous, next };
    expect(LeaseDataSchema.safeParse(data).success).toBe(true);
    expect(LeaseDataSchema.safeParse({ ...data, email: "person@example.invalid" }).success).toBe(false);
  });

  it("rejects impossible lease transitions and sensitive fields", () => {
    const acquired = { kind: "lease", requestId: "lease_bad", event: "acquired", occurredAt: at, next: controller };
    expect(LeaseDataSchema.safeParse({ ...acquired, previous: controller }).success).toBe(false);
    expect(LeaseDataSchema.safeParse({ ...acquired, next: undefined }).success).toBe(false);
    expect(LeaseDataSchema.safeParse({ ...acquired, token: "synthetic-token" }).success).toBe(false);
  });

  it("fails closed for malformed custom entry wrappers", () => {
    expect(parseAttributionEntry({ type: "custom", customType: "pi-together.attribution.v1", data: { kind: "message" } })).toBeNull();
    expect(parseAttributionEntry({ type: "message", customType: "pi-together.attribution.v1", data: {} })).toBeNull();
  });
});

describe("branch-aware collaboration normalization", () => {
  it("pairs markers FIFO with later user messages across intervening entries", () => {
    const normalized = normalizeSessionEntries([
      marker("m1", null, "req_1"),
      assistant("a1", "m1"),
      marker("m2", "a1", "req_2"),
      user("u1", "m2", "first"),
      user("u2", "u1", "second"),
    ]);
    expect(normalized.turns.filter((turn) => turn.role === "user").map((turn) => [turn.text, turn.attribution?.requestId]))
      .toEqual([["first", "req_1"], ["second", "req_2"]]);
  });

  it("uses only the root-to-current-leaf branch and supports an explicit leaf", () => {
    const entries = [
      user("root", null, "root"),
      marker("old-marker", "root", "req_old"),
      user("old-user", "old-marker", "abandoned"),
      marker("new-marker", "root", "req_new"),
      user("new-user", "new-marker", "current"),
    ];
    expect(normalizeSessionEntries(entries).turns.map((turn) => turn.text)).toEqual(["root", "current"]);
    expect(normalizeSessionEntries(entries).turns[1]?.attribution?.requestId).toBe("req_new");
    expect(normalizeSessionEntries(entries, { currentLeafId: "old-user" }).turns.map((turn) => turn.text))
      .toEqual(["root", "abandoned"]);
  });

  it("ignores duplicate request IDs and reports orphan delivery without guessing", () => {
    const normalized = normalizeSessionEntries([
      marker("m1", null, "req_same"),
      user("u1", "m1", "attributed"),
      marker("m2", "u1", "req_same"),
      user("u2", "m2", "unknown"),
      marker("orphan", "u2", "req_orphan"),
    ]);
    expect(normalized.turns[0]?.attribution?.requestId).toBe("req_same");
    expect(normalized.turns[1]?.attribution).toBeUndefined();
    expect(normalized.attributionDiagnostics).toEqual([{ requestId: "req_orphan", reason: "delivery-incomplete" }]);
  });

  it("preserves branch attribution through compaction and copied trees", () => {
    const entries: RawSessionEntry[] = [
      marker("m1", null, "req_before"),
      user("u1", "m1", "before"),
      { type: "compaction", id: "compact", parentId: "u1", summary: "bounded summary" },
      marker("m2", "compact", "req_after"),
      user("u2", "m2", "after"),
    ];
    const original = normalizeSessionEntries(entries);
    const copied = normalizeSessionEntries(structuredClone(entries));
    expect(copied.turns).toEqual(original.turns);
    expect(copied.turns.map((turn) => turn.attribution?.requestId)).toEqual(["req_before", "req_after"]);
  });

  it("reconstructs lease audit rows only from the selected branch", () => {
    const lease = (id: string, parentId: string | null, event: "acquired" | "released", requestId: string): RawSessionEntry => ({
      type: "custom", id, parentId, customType: "pi-together.lease.v1",
      data: event === "acquired"
        ? { kind: "lease", requestId, event, occurredAt: at, next: controller }
        : { kind: "lease", requestId, event, occurredAt: at, previous: controller },
    });
    const normalized = normalizeSessionEntries([
      lease("acquire", null, "acquired", "lease_1"),
      lease("abandoned-release", "acquire", "released", "lease_old"),
      user("current", "acquire", "current"),
      lease("release", "current", "released", "lease_2"),
    ]);
    expect(normalized.leaseHistory.map((row) => row.requestId)).toEqual(["lease_1", "lease_2"]);
  });

  it("supports retained tails with a missing ancestor and rejects cyclic trees", () => {
    const retained = normalizeSessionEntries([
      marker("tail-marker", "missing-parent", "req_tail"),
      user("tail-user", "tail-marker", "retained"),
    ]);
    expect(retained.turns[0]?.attribution?.requestId).toBe("req_tail");
    expect(normalizeSessionEntries([
      user("cycle-a", "cycle-b", "a"),
      user("cycle-b", "cycle-a", "b"),
    ]).turns).toEqual([]);
    expect(normalizeSessionEntries([
      user("duplicate", null, "first"),
      user("duplicate", "duplicate", "second"),
    ]).turns).toEqual([]);
  });

  it("leaves existing native messages explicitly unattributed", () => {
    expect(normalizeSessionEntries([user("u1", null, "native")]).turns[0]?.attribution).toBeUndefined();
  });
});
