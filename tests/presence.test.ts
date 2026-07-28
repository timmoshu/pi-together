import { describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../pi-adapter/fake.js";
import { PresenceManager, SessionPresence } from "../server/presence.js";
import { RuntimeRegistry } from "../server/runtime-registry.js";
import type { PrincipalIdentity, ServerEvent } from "../shared/protocol.js";

const member = (subject: string): PrincipalIdentity => ({ provider: "github", subject, login: `member-${subject}` });

describe("PresenceManager", () => {
  it("joins, leaves, and deduplicates multiple connections and viewers by principal", () => {
    const changed = vi.fn();
    const presence = new PresenceManager({ now: () => 1_000, onChange: changed });
    expect(presence.join({ chatId: "session-one", connectionId: "connection-a", principal: member("1"), viewerId: "viewer-a" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-b", principal: member("1"), viewerId: "viewer-b" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-c", principal: member("1"), viewerId: "viewer-b" })).toBe(true);
    expect(presence.snapshot("session-one").participants).toEqual([{ actor: member("1"), viewerCount: 2 }]);

    presence.leave("connection-b");
    expect(presence.snapshot("session-one").participants[0]?.viewerCount).toBe(2);
    presence.leave("connection-c");
    expect(presence.snapshot("session-one").participants[0]?.viewerCount).toBe(1);
    presence.leave("connection-a");
    expect(presence.snapshot("session-one").participants).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  it("reaps stale connections without leaving phantom participants", () => {
    let now = 10_000;
    const presence = new PresenceManager({ now: () => now, staleAfterMs: 1_000 });
    presence.join({ chatId: "session-one", connectionId: "connection-a", principal: member("1"), viewerId: "viewer-a" });
    presence.join({ chatId: "session-one", connectionId: "connection-b", principal: member("2"), viewerId: "viewer-b" });
    now += 750;
    presence.touch("connection-b");
    now += 300;
    expect(presence.reapStale()).toBe(1);
    expect(presence.snapshot("session-one").participants).toEqual([{ actor: member("2"), viewerCount: 1 }]);
  });

  it("caps sessions, principals, viewers, and all identifier lengths", () => {
    const presence = new PresenceManager({ maxSessions: 1, maxParticipantsPerSession: 2, maxViewersPerParticipant: 2, maxConnectionsPerViewer: 2 });
    expect(presence.join({ chatId: "session-one", connectionId: "connection-a", principal: member("1"), viewerId: "viewer-a" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-b", principal: member("1"), viewerId: "viewer-b" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-overlap", principal: member("1"), viewerId: "viewer-b" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-overflow", principal: member("1"), viewerId: "viewer-b" })).toBe(false);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-c", principal: member("1"), viewerId: "viewer-c" })).toBe(false);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-d", principal: member("2"), viewerId: "viewer-d" })).toBe(true);
    expect(presence.join({ chatId: "session-one", connectionId: "connection-e", principal: member("3"), viewerId: "viewer-e" })).toBe(false);
    expect(presence.join({ chatId: "session-two", connectionId: "connection-f", principal: member("4"), viewerId: "viewer-f" })).toBe(false);
    expect(() => presence.join({ chatId: "x".repeat(257), connectionId: "connection-g", principal: member("5"), viewerId: "viewer-g" })).toThrow(/chat/i);
    expect(() => presence.join({ chatId: "session-one", connectionId: "connection-h", principal: member("5"), viewerId: "x".repeat(129) })).toThrow(/viewer/i);
  });
});

describe("SessionPresence integration", () => {
  it("runs stale cleanup on its bounded timer", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const registry = new RuntimeRegistry(new FakeAdapter());
    const presence = new SessionPresence(registry, { now: () => now, staleAfterMs: 100, reapIntervalMs: 50 });
    try {
      presence.join({ chatId: "c_alpha", connectionId: "connection-timer", principal: member("1"), viewerId: "viewer-timer" });
      now += 101;
      vi.advanceTimersByTime(50);
      expect(presence.manager.snapshot("c_alpha").participants).toEqual([]);
    } finally {
      presence.close();
      registry.close();
      vi.useRealTimers();
    }
  });

  it("fans ephemeral snapshots through the registry and clears immediately on disconnect", async () => {
    const registry = new RuntimeRegistry(new FakeAdapter());
    const events: ServerEvent[] = [];
    registry.add({ id: "sse-observer", send: (_id, event) => events.push(event) });
    const presence = new SessionPresence(registry, { reapIntervalMs: 60_000 });
    const disconnect = presence.join({
      chatId: "c_alpha", connectionId: "connection-a", principal: member("1"), viewerId: "viewer-a",
    });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "chat.presence", chatId: "c_alpha", participants: [{ actor: member("1"), viewerCount: 1 }] }));
    disconnect();
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "chat.presence", chatId: "c_alpha", participants: [] }));

    const replay: ServerEvent[] = [];
    registry.add({ id: "sse-replay", send: (_id, event) => replay.push(event) }, 0);
    expect(replay.some((event) => event.type === "chat.presence")).toBe(false);
    presence.close();
    registry.close();
  });
});
