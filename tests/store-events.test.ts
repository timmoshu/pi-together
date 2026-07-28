import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSummary } from "../shared/protocol.js";
import { applyServerEvent, upsertChat } from "../client/src/store-events.js";
import type { AppState, SelectedState } from "../client/src/store-types.js";

function summary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "chat-1",
    name: "Synthetic session",
    status: "idle",
    workspaceRoot: "/workspace/example",
    repoRoot: "/workspace/example",
    updatedAt: 1,
    turnCount: 0,
    lease: null,
    live: true,
    toolMode: "read-only",
    origin: "web",
    ...overrides,
  };
}
function selected(): SelectedState {
  return {
    id: "chat-1",
    summary: summary(),
    config: null,
    queue: { steering: [], followUp: [] },
    runState: "idle",
    timeline: [],
    live: { itemId: null, assistant: "", thinking: "", active: false },
    ext: null,
    leaseHistory: [],
  };
}
function state(): AppState {
  const value = selected();
  return {
    boot: null, connection: "connected", chats: [value.summary], models: [], presence: {}, selected: value,
    error: null, pending: null, controlNotice: null,
  };
}

describe("client event transitions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deduplicates finalized replay while retaining ordered live traces", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const app = state();
    const seen = new Set<string>();
    const turn = { id: "turn-1", role: "user" as const, text: "hello", ts: 1 };
    applyServerEvent(app, { type: "chat.turn", chatId: "chat-1", turn }, seen);
    applyServerEvent(app, { type: "chat.turn", chatId: "chat-1", turn }, seen);
    applyServerEvent(app, { type: "msg.start", chatId: "chat-1", itemId: "agent-1", role: "agent" }, seen);
    applyServerEvent(app, { type: "thinking.delta", chatId: "chat-1", itemId: "agent-1", text: "checking" }, seen);
    applyServerEvent(app, { type: "tool.start", chatId: "chat-1", callId: "tool-1", name: "read", argsSummary: "file" }, seen);
    expect(app.selected?.timeline.map((item) => item.id)).toEqual(["turn-1", "agent-1-think", "tool-1"]);
  });

  it("applies presence snapshots purely and ignores replayed or out-of-order revisions", () => {
    const app = state();
    const seen = new Set<string>();
    const current = { type: "chat.presence" as const, chatId: "chat-1", revision: 2, observedAt: 20, participants: [{ actor: { provider: "github" as const, subject: "2", login: "member-two" }, viewerCount: 2 }] };
    applyServerEvent(app, current, seen);
    expect(app.presence["chat-1"]).toEqual({ revision: 2, observedAt: 20, participants: current.participants });

    applyServerEvent(app, { ...current, participants: [] }, seen);
    applyServerEvent(app, { ...current, revision: 1, observedAt: 10, participants: [] }, seen);
    expect(app.presence["chat-1"]?.participants).toEqual(current.participants);

    applyServerEvent(app, { ...current, revision: 3, observedAt: 30, participants: [] }, seen);
    expect(app.presence["chat-1"]).toEqual({ revision: 3, observedAt: 30, participants: [] });

    const restarted = { ...current, revision: 1, observedAt: 40, participants: [{ actor: { provider: "github" as const, subject: "3", login: "member-three" }, viewerCount: 1 }] };
    applyServerEvent(app, restarted, seen);
    applyServerEvent(app, { ...current, revision: 99, observedAt: 20 }, seen);
    expect(app.presence["chat-1"]).toEqual({ revision: 1, observedAt: 40, participants: restarted.participants });
  });

  it("preserves personalized holder state when an unpersonalized summary arrives", () => {
    const app = state();
    app.chats[0] = summary({ lease: { leaseId: "opaque", actor: { provider: "github", subject: "1", login: "alice" }, acquiredAt: 1, expiresAt: 2, isHolder: true } });
    upsertChat(app, summary({ updatedAt: 2, lease: { leaseId: "opaque", actor: { provider: "github", subject: "1", login: "alice" }, acquiredAt: 1, expiresAt: 3 } }));
    expect(app.chats[0]?.lease).toMatchObject({ isHolder: true, expiresAt: 3 });
  });

  it("notifies the exact displaced holder when another principal takes control", () => {
    const app = state();
    app.boot = {
      owner: "alice",
      principal: { provider: "github", subject: "1", login: "alice" },
      origin: "http://test.local",
      adapter: "fake",
      chats: [], catalog: [], workspaces: [], models: [],
    };
    const held = summary({ lease: {
      leaseId: "lease-alice",
      actor: app.boot.principal,
      acquiredAt: 1,
      expiresAt: 2,
      isHolder: true,
    } });
    app.chats = [held];
    app.selected!.summary = held;

    applyServerEvent(app, { type: "chat.lease", chatId: "chat-1", lease: {
      leaseId: "lease-bob",
      actor: { provider: "github", subject: "2", login: "bob" },
      acquiredAt: 2,
      expiresAt: 3,
    } }, new Set());

    expect(app.selected?.summary.lease?.isHolder).toBeUndefined();
    expect(app.controlNotice).toMatchObject({
      chatId: "chat-1",
      leaseId: "lease-bob",
      actor: { subject: "2", login: "bob" },
      samePrincipal: false,
    });
  });

  it("uses same-user copy when control moves to another tab or device", () => {
    const app = state();
    app.boot = {
      owner: "alice",
      principal: { provider: "github", subject: "1", login: "alice" },
      origin: "http://test.local", adapter: "fake", chats: [], catalog: [], workspaces: [], models: [],
    };
    const held = summary({ lease: {
      leaseId: "lease-one", actor: app.boot.principal, acquiredAt: 1, expiresAt: 2, isHolder: true,
    } });
    app.chats = [held]; app.selected!.summary = held;
    applyServerEvent(app, { type: "chat.lease", chatId: "chat-1", lease: {
      leaseId: "lease-two", actor: app.boot.principal, acquiredAt: 2, expiresAt: 3,
    } }, new Set());
    expect(app.controlNotice?.samePrincipal).toBe(true);
  });

});
