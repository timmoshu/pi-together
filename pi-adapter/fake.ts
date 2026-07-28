// pi-adapter/fake.ts — deterministic in-memory adapter. Used by ALL unit/e2e tests and by
// `PI_TOGETHER_ADAPTER=fake` local runs, so nothing here touches a real Pi install. It simulates the
// full live agent-run loop (streamed thinking/text/tool deltas, queue, abort, settle) grounded in
// the same event shapes the real adapter derives from pi's rpc stream, but on a fixed schedule.
import type {
  AdapterChatDetail,
  AdapterEvent,
  AdapterChatTimelineItem,
  ChatConfig,
  ChatStatus,
  ChatSummary,
  CatalogEntry,
  DurableLeaseEvent,
  ExtensionUiReply,
  ModelInfo,
  PiAdapter,
  ToolMode,
  DurableTurn,
  WebAttribution,
} from "../shared/protocol.js";
import { READ_ONLY_TOOLS } from "../shared/protocol.js";

let CLOCK = 1_700_000_000_000; // fixed base so tests are deterministic
const tick = () => (CLOCK += 1000);

const MODELS: ModelInfo[] = [
  { provider: "example-ai", id: "example-reasoner", name: "Example Reasoner", reasoning: true },
  { provider: "example-ai", id: "example-coder", name: "Example Coder", reasoning: true },
  { provider: "example-ai", id: "example-fast", name: "Example Fast", reasoning: false },
];
const levelsFor = (m: ModelInfo | null): string[] =>
  m?.reasoning ? ["off", "low", "medium", "high"] : ["off"];

// Step delay for the simulated stream. Small so tests are fast but ordering is deterministic.
const STEP_MS = Number(process.env.FAKE_STEP_MS ?? 8);

interface FakeChat extends AdapterChatDetail {
  config: ChatConfig;
  queue: { steering: string[]; followUp: string[] };
  runState: NonNullable<AdapterChatDetail["runState"]>;
  runToken: number; // bumped on abort/dispose to invalidate in-flight stream steps
  seq: number;
  web: boolean; // true once a runtime is attached from the dashboard (live)
  origin: "web" | "external"; // provenance: created here vs picked up from disk
}

function seedTurns(prefix: string): DurableTurn[] {
  return [
    { id: `${prefix}-1`, role: "user", text: "hello pi", ts: tick() },
    { id: `${prefix}-2`, role: "agent", text: "hi — what are we building?", ts: tick() },
  ];
}

export class FakeAdapter implements PiAdapter {
  readonly kind = "fake" as const;
  private chats = new Map<string, FakeChat>();
  private listeners = new Set<(e: AdapterEvent) => void>();
  private timers = new Set<NodeJS.Timeout>();
  private queuedAttribution = new Map<string, WebAttribution[]>();

  constructor() {
    for (const [id, name, root, status] of [
      ["c_alpha", "atlas refactor", "/home/example/projects/atlas", "waiting"],
      ["c_beta", "beacon pulse", "/home/example/projects/beacon", "idle"],
    ] as const) {
      const turns = seedTurns(id);
      const timeline: AdapterChatTimelineItem[] = turns.map((turn) => ({ kind: "turn", ...turn }));
      const model = MODELS[0]!;
      this.chats.set(id, {
        id,
        name,
        status: status as ChatStatus,
        workspaceRoot: root,
        repoRoot: root,
        updatedAt: turns[turns.length - 1]!.ts,
        turnCount: turns.length,
        lease: null,
        live: false,
        toolMode: null,
        turns,
        timeline,
        config: {
          model: { provider: model.provider, id: model.id, name: model.name },
          thinking: "medium",
          toolMode: status === "waiting" ? "read-only" : "full",
          thinkingLevels: levelsFor(model),
        },
        queue: { steering: [], followUp: [] },
        runState: "idle",
        runToken: 0,
        seq: 0,
        web: false,
        origin: "external", // seeded chats mimic terminal/kandev sessions picked up from disk
      });
    }
  }

  private emit(e: AdapterEvent) {
    if (e.type === "ext.request") {
      const chat = this.chats.get(e.chatId);
      if (chat) {
        const { type: _type, chatId: _chatId, ...request } = e;
        chat.pendingExtension = request;
      }
    } else if (e.type === "ext.clear") {
      const chat = this.chats.get(e.chatId);
      if (chat?.pendingExtension?.requestId === e.requestId) chat.pendingExtension = undefined;
    }
    for (const l of this.listeners) l(e);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private summary(c: FakeChat): ChatSummary {
    const { turns: _t, timeline: _tl, config: _c, queue: _q, runState: _r, runToken: _rt, seq: _s, web: _w, origin: _o, pendingExtension: _pe, ...rest } = c;
    return { ...rest, live: c.web, toolMode: c.web ? c.config.toolMode : null, origin: c.origin };
  }

  private require(id: string): FakeChat {
    const c = this.chats.get(id);
    if (!c) throw Object.assign(new Error(`no such chat: ${id}`), { code: "ENOENT" });
    return c;
  }

  async listChats(): Promise<ChatSummary[]> {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => this.summary(c));
  }

  async getChat(id: string): Promise<AdapterChatDetail | null> {
    const c = this.chats.get(id);
    if (!c) return null;
    return {
      ...this.summary(c),
      turns: [...c.turns],
      timeline: c.timeline.map((item) => ({ ...item })),
      config: c.config,
      queue: { steering: [...c.queue.steering], followUp: [...c.queue.followUp] },
      runState: c.runState,
      pendingExtension: c.pendingExtension,
    };
  }

  async resume(id: string): Promise<ChatSummary> {
    const c = this.require(id);
    const wasLive = c.web;
    c.web = true; // attaching a runtime makes it live (drivable); provenance (origin) is unchanged
    if (!wasLive) c.status = "waiting"; // renewing a lease must not hide an in-flight run
    c.updatedAt = tick();
    this.emit({ type: "chat.updated", chat: this.summary(c) });
    if (!wasLive) this.emit({ type: "chat.status", chatId: id, status: c.status });
    this.emit({ type: "config", chatId: id, config: c.config });
    return this.summary(c);
  }

  async detach(id: string): Promise<ChatSummary> {
    const c = this.require(id);
    if (c.runState !== "idle") throw Object.assign(new Error("cannot close a session while the agent is running"), { httpStatus: 409 });
    c.runToken++;
    if (c.pendingExtension) this.emit({ type: "ext.clear", chatId: id, requestId: c.pendingExtension.requestId });
    c.web = false;
    c.status = "idle";
    c.queue = { steering: [], followUp: [] };
    const summary = this.summary(c);
    this.emit({ type: "chat.updated", chat: summary });
    return summary;
  }

  async compact(id: string): Promise<ChatSummary> {
    const c = this.require(id);
    this.emit({ type: "notice", chatId: id, kind: "compaction", text: "compacting session…" });
    c.turns = c.turns.slice(-2);
    const kept = new Set(c.turns.map((turn) => turn.id));
    c.timeline = c.timeline.filter((item) => item.kind !== "turn" || kept.has(item.id));
    c.turnCount = c.turns.length;
    c.updatedAt = tick();
    this.emit({ type: "chat.updated", chat: this.summary(c) });
    return this.summary(c);
  }

  async rename(id: string, name: string): Promise<ChatSummary> {
    const c = this.require(id);
    c.name = name;
    c.updatedAt = tick();
    this.emit({ type: "chat.updated", chat: this.summary(c) });
    return this.summary(c);
  }

  async listWorkspaces(): Promise<string[]> {
    return ["/home/example/projects/atlas", "/home/example/projects/beacon", "/home/example/projects/canvas"];
  }

  async openWorkspace(root: string): Promise<ChatSummary> {
    return this.createChat(root);
  }

  async createChat(workspaceRoot: string, name?: string): Promise<ChatSummary> {
    if (!workspaceRoot.startsWith("/home/example/projects")) throw new Error("workspace outside WORKSPACE_ROOTS");
    const id = `c_new_${this.chats.size}`;
    const model = MODELS[1]!; // deterministic reasoning model for browser-created fixture sessions
    const ts = tick();
    const chat: FakeChat = {
      id,
      name: name ?? `new — ${workspaceRoot.split("/").pop()}`,
      status: "idle",
      workspaceRoot,
      repoRoot: workspaceRoot,
      updatedAt: ts,
      turnCount: 0,
      lease: null,
      live: true,
      toolMode: "full",
      turns: [],
      timeline: [],
      config: {
        model: { provider: model.provider, id: model.id, name: model.name },
        thinking: "high",
        toolMode: "full",
        thinkingLevels: levelsFor(model),
      },
      queue: { steering: [], followUp: [] },
      runState: "idle",
      runToken: 0,
      seq: 0,
      web: true,
      origin: "web",
    };
    this.chats.set(id, chat);
    this.emit({ type: "chat.updated", chat: this.summary(chat) });
    return this.summary(chat);
  }

  async catalog(): Promise<CatalogEntry[]> {
    const counts = new Map<string, number>();
    for (const c of this.chats.values()) counts.set(c.workspaceRoot, (counts.get(c.workspaceRoot) ?? 0) + 1);
    const roots = ["/home/example/projects/atlas", "/home/example/projects/beacon", "/home/example/projects/canvas"];
    const entries = new Map<string, CatalogEntry>();
    for (const [cwd, sessionCount] of counts)
      entries.set(cwd, { workspaceRoot: cwd, label: cwd.split("/").pop() ?? cwd, source: "session", sessionCount });
    for (const r of roots)
      if (!entries.has(r)) entries.set(r, { workspaceRoot: r, label: r.split("/").pop() ?? r, source: "root", sessionCount: 0 });
    return [...entries.values()].sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
  }

  async models(_refresh = false): Promise<ModelInfo[]> {
    return MODELS;
  }

  async getConfig(id: string): Promise<ChatConfig> {
    return this.require(id).config;
  }

  async setConfig(
    id: string,
    change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode },
  ): Promise<ChatConfig> {
    const c = this.require(id);
    if (c.runState !== "idle") throw Object.assign(new Error("cannot change config while running"), { httpStatus: 409 });
    if (change.model) {
      const m = MODELS.find((x) => x.provider === change.model!.provider && x.id === change.model!.id);
      if (!m) throw Object.assign(new Error("unknown model"), { httpStatus: 400 });
      c.config.model = { provider: m.provider, id: m.id, name: m.name };
      c.config.thinkingLevels = levelsFor(m);
      if (!c.config.thinkingLevels.includes(c.config.thinking)) c.config.thinking = c.config.thinkingLevels[0]!;
    }
    if (change.thinking) {
      if (!c.config.thinkingLevels.includes(change.thinking))
        throw Object.assign(new Error("thinking level not supported by model"), { httpStatus: 400 });
      c.config.thinking = change.thinking;
    }
    if (change.toolMode) c.config.toolMode = change.toolMode;
    this.emit({ type: "config", chatId: id, config: c.config });
    return c.config;
  }

  async send(
    id: string,
    text: string,
    mode: "normal" | "steer" | "followUp",
    attribution?: WebAttribution,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const c = this.require(id);
    if (mode !== "normal" && c.runState === "running") {
      c.queue[mode === "steer" ? "steering" : "followUp"].push(text);
      if (attribution) {
        const key = `${id}:${mode}`;
        this.queuedAttribution.set(key, [...(this.queuedAttribution.get(key) ?? []), attribution]);
      }
      this.emit({ type: "queue", chatId: id, steering: [...c.queue.steering], followUp: [...c.queue.followUp] });
      return { accepted: true, queued: true };
    }
    if (c.runState === "running") {
      // idle send while running is not allowed; require steer/followUp
      throw Object.assign(new Error("agent is running; use steer or followUp"), { httpStatus: 409 });
    }
    this.startRun(c, text, mode, attribution);
    return { accepted: true, queued: false };
  }

  private pushTurn(c: FakeChat, role: DurableTurn["role"], text: string, attribution?: WebAttribution, action: "prompt" | "steer" | "followUp" = "prompt"): DurableTurn {
    const ts = tick();
    const turn: DurableTurn = {
      id: `${c.id}-m${c.seq++}`,
      role,
      text,
      ts,
      ...(attribution ? { attribution: { ...attribution, action, issuedAt: new Date(ts).toISOString() } } : {}),
    };
    c.turns.push(turn);
    c.timeline.push({ kind: "turn", ...turn });
    c.turnCount = c.turns.length;
    c.updatedAt = turn.ts;
    this.emit({ type: "chat.turn", chatId: c.id, turn });
    return turn;
  }

  /** Drive a deterministic streamed run for `prompt`. */
  private startRun(c: FakeChat, prompt: string, mode: "normal" | "steer" | "followUp" = "normal", attribution?: WebAttribution): void {
    const token = c.runToken;
    this.pushTurn(c, "user", prompt, attribution, mode === "normal" ? "prompt" : mode);
    c.runState = "running";
    c.status = "running";
    this.emit({ type: "run.state", chatId: c.id, state: "running" });
    this.emit({ type: "chat.status", chatId: c.id, status: "running" });

    const itemId = `${c.id}-a${c.seq++}`;
    const thinking = "Considering the request and the read-only tools available.";
    const textChunks = ["Looking at ", "the workspace ", `for "${prompt.slice(0, 40)}". `, "Done."];
    const fullText = textChunks.join("");
    const alive = () => c.runToken === token && this.chats.get(c.id) === c;

    const steps: Array<() => void> = [];
    steps.push(() => this.emit({ type: "msg.start", chatId: c.id, itemId, role: "agent" }));
    steps.push(() => {
      c.timeline.push({ kind: "thinking", id: `${itemId}-think`, text: thinking, ts: tick() });
      this.emit({ type: "thinking.delta", chatId: c.id, itemId, text: thinking });
    });
    for (const ch of textChunks) steps.push(() => this.emit({ type: "msg.delta", chatId: c.id, itemId, text: ch }));
    // a representative read-only tool call
    const callId = `${c.id}-t${c.seq++}`;
    steps.push(() => {
      c.timeline.push({ kind: "tool", id: callId, name: "ls", argsSummary: "ls .", state: "running", preview: "", ts: tick() });
      this.emit({ type: "tool.start", chatId: c.id, callId, name: "ls", argsSummary: "ls ." });
    });
    steps.push(() => {
      const tool = c.timeline.find((item) => item.kind === "tool" && item.id === callId);
      if (tool?.kind === "tool") {
        tool.state = "success";
        tool.preview = "README.md\nsrc/\npackage.json";
      }
      this.emit({ type: "tool.end", chatId: c.id, callId, name: "ls", ok: true, preview: "README.md\nsrc/\npackage.json" });
    });
    steps.push(() => {
      this.emit({ type: "msg.end", chatId: c.id, itemId, role: "agent", text: fullText, thinking });
      this.pushTurn(c, "agent", fullText);
    });
    steps.push(() => this.settle(c, token));

    let i = 0;
    const run = () => {
      if (!alive()) return;
      if (i >= steps.length) return;
      steps[i++]!();
      if (i < steps.length) this.later(run, STEP_MS);
    };
    this.later(run, STEP_MS);
  }

  private settle(c: FakeChat, token: number): void {
    if (c.runToken !== token) return;
    // deliver a queued steering/follow-up if any (steering first), else settle idle.
    const mode = c.queue.steering.length ? "steer" : c.queue.followUp.length ? "followUp" : undefined;
    const next = mode === "steer" ? c.queue.steering.shift() : mode === "followUp" ? c.queue.followUp.shift() : undefined;
    this.emit({ type: "queue", chatId: c.id, steering: [...c.queue.steering], followUp: [...c.queue.followUp] });
    if (next && mode) {
      const key = `${c.id}:${mode}`;
      const queued = this.queuedAttribution.get(key) ?? [];
      const attribution = queued.shift();
      if (queued.length) this.queuedAttribution.set(key, queued);
      else this.queuedAttribution.delete(key);
      c.runState = "idle";
      this.startRun(c, next, mode, attribution);
      return;
    }
    c.runState = "idle";
    c.status = "waiting";
    this.emit({ type: "run.state", chatId: c.id, state: "idle" });
    this.emit({ type: "chat.status", chatId: c.id, status: "waiting" });
    this.emit({ type: "chat.updated", chat: this.summary(c) });
  }

  async abort(id: string): Promise<void> {
    const c = this.require(id);
    if (c.pendingExtension) this.emit({ type: "ext.clear", chatId: id, requestId: c.pendingExtension.requestId });
    c.runToken++; // invalidate any in-flight run
    c.queue = { steering: [], followUp: [] };
    this.queuedAttribution.delete(`${id}:steer`);
    this.queuedAttribution.delete(`${id}:followUp`);
    c.runState = "idle";
    c.status = "waiting";
    this.emit({ type: "notice", chatId: id, kind: "info", text: "run aborted" });
    this.emit({ type: "queue", chatId: id, steering: [], followUp: [] });
    this.emit({ type: "run.state", chatId: id, state: "idle" });
    this.emit({ type: "chat.status", chatId: id, status: "waiting" });
  }

  async extensionUiResponse(chatId: string, requestId: string, _reply: ExtensionUiReply): Promise<void> {
    const chat = this.require(chatId);
    if (chat.pendingExtension?.requestId === requestId) {
      chat.pendingExtension = undefined;
      this.emit({ type: "ext.clear", chatId, requestId });
    }
  }

  async recordLeaseEvent(chatId: string, event: DurableLeaseEvent): Promise<void> {
    const chat = this.require(chatId);
    const history = chat.leaseHistory ?? [];
    if (!history.some((existing) => existing.requestId === event.requestId)) {
      chat.leaseHistory = [...history, event];
    }
  }

  subscribe(listener: (e: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queuedAttribution.clear();
    this.listeners.clear();
  }

  // exposed for tests that want to drive an extension-ui round trip deterministically
  emitForTest(e: AdapterEvent): void {
    this.emit(e);
  }
}

export const READ_ONLY = READ_ONLY_TOOLS;
