// pi-adapter/real.ts — live adapter over the pi agent.
//
// READ path (validated against pi 0.81.1): session jsonl under ~/.pi/agent/sessions/<project>/*.jsonl,
// parsed by normalize.ts and keyed by the header session id.
// CONTROL path: mutating ops + the live agent-run loop drive a `pi --mode rpc` runtime per session
// (pi-adapter/runtime.ts):
//   resume  → attach/spawn the session's runtime (now controllable)
//   send    → attributed RPC prompt (queue actions use streamingBehavior)
//   abort   → rpc abort
//   config  → set_model / set_thinking_level live; toolMode changes respawn the runtime because pi
//             applies its tool allowlist only at construction (--tools / --no-tools).
//   compact/rename/extensionUiResponse → their rpc equivalents
// Runtime turn/status/delta events bridge to subscribers; the session-file watcher is the
// belt-and-braces path for turns written by pi processes we didn't spawn.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
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
  ExtensionUiRequest,
  ModelInfo,
  PiAdapter,
  RunState,
  ServerEvent,
  ToolMode,
  DurableTurn,
  WebAttribution,
} from "../shared/protocol.js";
import { READ_ONLY_TOOLS } from "../shared/protocol.js";
import { normalizeSessionEntries, type RawSessionEntry } from "./normalize.js";
import { SessionSummaryIndex, type IndexedSession } from "./session-summary-index.js";
import { PiRuntime, PiRuntimeManager, type PiRuntimeOptions } from "./runtime.js";
import { AttributionSigner } from "./attribution-signer.js";

const SESSIONS_DIR = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
const WORKSPACE_ROOTS = (process.env.WORKSPACE_ROOTS ?? homedir()).split(":").filter(Boolean);
const READ_ONLY = [...READ_ONLY_TOOLS];
// Defaults applied to a NEW web session (env-overridable). Full tools + a preferred model/thinking.
const NEW_TOOLMODE: ToolMode = process.env.PI_TOGETHER_NEW_TOOLMODE === "read-only" ? "read-only" : "full";
const NEW_MODEL = process.env.PI_TOGETHER_NEW_MODEL; // e.g. "provider/model" (Pi --model pattern)
const NEW_THINKING = process.env.PI_TOGETHER_NEW_THINKING; // e.g. "high"
// Sessions the dashboard creates get this id prefix, and pi honors it via --session-id. Provenance is
// therefore baked into the session id itself — immutable, needs no external store: `ws-` ⇒ web,
// anything else (a terminal / tmux-agent / kandev UUID) ⇒ external. There is no "claiming": taking
// over an external session lets you drive it, but it stays external (it may be running elsewhere).
const WEB_ID_PREFIX = "ws-";

// In-memory only: metadata for a just-created session so getChat/send/config resolve it in the brief
// window before pi flushes its JSONL to disk. Not persisted — provenance comes from the id prefix.
interface PendingSession {
  cwd: string;
  repoRoot: string;
  name: string;
  createdAt: number;
}

interface ParsedSession {
  id: string;
  file: string;
  cwd: string;
  summary: ChatSummary;
  turns: DurableTurn[];
  timeline: AdapterChatTimelineItem[];
  leaseHistory: DurableLeaseEvent[];
  attributionDiagnostics: Array<{ requestId: string; reason: "delivery-incomplete" }>;
}

const execFileP = promisify(execFile);
const repoRootCache = new Map<string, string>();

/**
 * Resolve a session cwd to its underlying repository so the session rail groups by repo, not by
 * worktree/branch. A git worktree resolves (via --git-common-dir) to its main tree; a plain repo
 * resolves to itself. A removed kandev worktree (`~/.kandev/tasks/<task>/<repo>`) can't be probed,
 * so fall back to `~/<repo>` — which matches the live worktrees' resolved root. Cached per cwd.
 */
async function resolveRepoRoot(cwd: string): Promise<string> {
  const cached = repoRootCache.get(cwd);
  if (cached) return cached;
  let root = cwd;
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeout: 3000,
    });
    const gitdir = stdout.trim();
    if (gitdir) root = basename(gitdir) === ".git" ? dirname(gitdir) : gitdir; // <repo>/.git → <repo>
  } catch {
    const m = cwd.match(/\/\.kandev\/tasks\/[^/]+\/([^/]+)/);
    if (m) root = join(homedir(), m[1]);
  }
  repoRootCache.set(cwd, root);
  return root;
}

async function parseFile(file: string): Promise<ParsedSession | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const entries: RawSessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t) as RawSessionEntry);
    } catch {
      /* tolerate a partially-written trailing line */
    }
  }
  if (!entries.length) return null;
  const norm = normalizeSessionEntries(entries);
  const id = norm.id ?? basename(file).replace(/\.jsonl$/, "");
  const cwd = norm.cwd ?? WORKSPACE_ROOTS[0] ?? homedir();
  // readable name: explicit/derived from normalize, else "<workspace> · <date>" (never the raw uuid).
  const day = new Date(norm.updatedAt || Date.now()).toISOString().slice(0, 10);
  const name = norm.name ?? `${basename(cwd)} · ${day}`;
  const summary: ChatSummary = {
    id,
    name,
    status: norm.status,
    workspaceRoot: cwd,
    repoRoot: await resolveRepoRoot(cwd),
    updatedAt: norm.updatedAt,
    turnCount: norm.turns.length,
    lease: null,
    live: false,
    toolMode: null,
    origin: "external", // overlaid to "web" in withLiveStatus for ws- ids
  };
  return {
    id,
    file,
    cwd,
    summary,
    turns: norm.turns,
    timeline: norm.timeline,
    leaseHistory: norm.leaseHistory,
    attributionDiagnostics: norm.attributionDiagnostics,
  };
}

async function sessionFiles(): Promise<string[]> {
  const out: string[] = [];
  let top;
  try {
    top = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of top) {
    const p = join(SESSIONS_DIR, ent.name);
    if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
    else if (ent.isDirectory()) {
      try {
        for (const f of await readdir(p)) if (f.endsWith(".jsonl")) out.push(join(p, f));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export class RealAdapter implements PiAdapter {
  readonly kind = "real" as const;
  private bus = new EventEmitter();
  private watcher: ReturnType<typeof watch> | null = null;
  private liveStatus = new Map<string, ChatStatus>();
  private runStates = new Map<string, RunState>();
  private configCache = new Map<string, ChatConfig>();
  private toolMode = new Map<string, ToolMode>(); // per-chat override; default is NEW_TOOLMODE (in-memory)
  private pending = new Map<string, PendingSession>(); // id → metadata for not-yet-flushed new sessions
  private runtimes: PiRuntimeManager;
  private modelCache: ModelInfo[] | null = null;
  private pendingExtensions = new Map<string, ExtensionUiRequest>();
  private piBin = process.env.PI_BIN ?? "pi";
  private readonly workspaceRoots: string[];
  private summaryIndex = new SessionSummaryIndex(
    SESSIONS_DIR,
    ".pi-together-summary-index-v1.json",
    WORKSPACE_ROOTS[0] ?? homedir(),
    resolveRepoRoot,
  );
  private detailCache = new Map<string, { size: number; mtimeMs: number; parsed: ParsedSession | null }>();
  private readonly attributionSigner: AttributionSigner | null;

  constructor(options: {
    collaboration?: boolean;
    attributionExtensionPath?: string;
    gitCommitterName?: string;
    gitCommitterEmail?: string;
    gitLauncherPath?: string;
    sharedRepositoryFolders?: string[];
  } = {}) {
    this.workspaceRoots = options.sharedRepositoryFolders ?? WORKSPACE_ROOTS;
    this.attributionSigner = options.collaboration ? new AttributionSigner() : null;
    const extensionSigner = this.attributionSigner ?? new AttributionSigner();
    const attributionExtensionPath = options.attributionExtensionPath
      ?? process.env.PI_TOGETHER_ATTRIBUTION_EXTENSION
      ?? join(process.cwd(), "dist", "extension", "pi-together-attribution-v1.js");
    const attribution = {
      extensionPath: attributionExtensionPath,
      publicKey: extensionSigner.publicKey,
      managed: Boolean(this.attributionSigner),
      destructiveGuard: { home: homedir(), protectedAnchors: this.workspaceRoots },
      gitIdentity: {
        committerName: options.gitCommitterName ?? process.env.PI_TOGETHER_GIT_COMMITTER_NAME ?? "Pi Together",
        committerEmail: options.gitCommitterEmail ?? "",
        launcherPath: options.gitLauncherPath
          ?? process.env.PI_TOGETHER_GIT_LAUNCHER
          ?? join(dirname(attributionExtensionPath), "git-bin", "git"),
      },
    };
    this.runtimes = new PiRuntimeManager(
      {
        piBin: this.piBin,
        provider: process.env.PI_TOGETHER_PI_PROVIDER,
        model: process.env.PI_TOGETHER_PI_MODEL,
        tools: READ_ONLY, // default new/attached runtimes to the read-only allowlist
        attribution,
      },
      (e) => this.onRuntimeEvent(e),
    );

    try {
      this.watcher = watch(SESSIONS_DIR, { persistent: false, recursive: true }, (_e, filename) => {
        if (filename && String(filename).endsWith(".jsonl")) this.bus.emit("dirty");
      });
    } catch {
      /* sessions dir may not exist yet */
    }
    let timer: NodeJS.Timeout | null = null;
    this.bus.on("dirty", () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void this.listChats().then((chats) => {
          for (const chat of chats) this.emit({ type: "chat.updated", chat });
        });
      }, 200);
    });
  }

  private emit(e: AdapterEvent): void {
    this.bus.emit("event", e);
  }

  private clearPendingExtension(chatId: string): void {
    const pending = this.pendingExtensions.get(chatId);
    if (!pending) return;
    this.pendingExtensions.delete(chatId);
    this.emit({ type: "ext.clear", chatId, requestId: pending.requestId });
  }

  private onRuntimeEvent(e: ServerEvent): void {
    if (e.type === "chat.status") {
      this.liveStatus.set(e.chatId, e.status);
      if (e.status === "error") this.runStates.set(e.chatId, "error");
      else if (e.status === "idle") this.runStates.set(e.chatId, "idle"); // runtime exited cleanly
      if (e.status === "idle" || e.status === "error") this.clearPendingExtension(e.chatId);
    }
    if (e.type === "run.state") this.runStates.set(e.chatId, e.state);
    if (e.type === "config") this.configCache.set(e.chatId, e.config);
    if (e.type === "ext.request") {
      const { type: _type, chatId: _chatId, ...request } = e;
      this.pendingExtensions.set(e.chatId, request);
    }
    if (e.type === "ext.clear") this.pendingExtensions.delete(e.chatId);
    this.emit(e);
  }

  // Overlay live runtime state onto a disk-parsed summary: live status, whether a web runtime is
  // attached ("web" session), and its active tool mode (read-only vs full).
  private withLiveStatus(s: ChatSummary): ChatSummary {
    const status = this.liveStatus.get(s.id);
    const live = this.runtimes.has(s.id);
    const toolMode = live ? (this.toolMode.get(s.id) ?? NEW_TOOLMODE) : null;
    const origin = s.id.startsWith(WEB_ID_PREFIX) ? "web" : "external";
    return { ...s, status: status ?? s.status, live, toolMode, origin };
  }

  private toolsFor(id: string): string[] | undefined {
    return (this.toolMode.get(id) ?? NEW_TOOLMODE) === "read-only" ? READ_ONLY : undefined; // undefined ⇒ full toolset
  }

  private async indexedSessions(): Promise<IndexedSession[]> {
    return this.summaryIndex.refresh(await sessionFiles());
  }

  private async locateSummary(id: string): Promise<IndexedSession | null> {
    return (await this.indexedSessions()).find((session) => session.id === id) ?? null;
  }

  /** Full JSONL normalization is deliberately confined to the selected conversation. */
  private async locate(id: string): Promise<ParsedSession | null> {
    const indexed = await this.locateSummary(id);
    if (!indexed) return null;
    const cached = this.detailCache.get(indexed.file);
    if (cached && cached.size === indexed.size && cached.mtimeMs === indexed.mtimeMs) return cached.parsed;
    const parsed = await parseFile(indexed.file);
    this.detailCache.set(indexed.file, { size: indexed.size, mtimeMs: indexed.mtimeMs, parsed });
    return parsed?.id === id ? parsed : null;
  }

  private diskSummary(session: IndexedSession): ChatSummary {
    return this.withLiveStatus({
      id: session.id,
      name: session.name,
      status: "idle",
      workspaceRoot: session.cwd,
      repoRoot: session.repoRoot,
      updatedAt: session.updatedAt,
      turnCount: session.turnCount,
      lease: null,
      live: false,
      toolMode: null,
      origin: "external",
    });
  }

  /** Resolve a chat's session dir + cwd from metadata, without loading its transcript. */
  private async resolveDirs(id: string): Promise<{ sessionDir: string; cwd: string } | null> {
    const session = await this.locateSummary(id);
    if (session) return { sessionDir: dirname(session.file), cwd: session.cwd };
    const rec = this.pending.get(id);
    if (rec) return { sessionDir: SESSIONS_DIR, cwd: rec.cwd };
    return null;
  }

  /** Get (spawning if needed) the runtime for a chat, whether it is on disk or a pending web session. */
  private async ensureRuntime(id: string): Promise<PiRuntime> {
    const d = await this.resolveDirs(id);
    if (!d) throw Object.assign(new Error(`no such chat: ${id}`), { code: "ENOENT" });
    return this.runtimes.ensure(id, d.sessionDir, d.cwd, { tools: this.toolsFor(id) });
  }

  private async summaryOf(id: string): Promise<ChatSummary> {
    const session = await this.locateSummary(id);
    if (session) return this.diskSummary(session);
    const rec = this.pending.get(id);
    if (rec) return this.pendingSummary(id, rec);
    throw Object.assign(new Error(`no such chat: ${id}`), { code: "ENOENT" });
  }

  /** A synthetic summary for a just-created web session whose JSONL pi hasn't flushed yet. */
  private pendingSummary(id: string, rec: PendingSession): ChatSummary {
    return this.withLiveStatus({
      id,
      name: rec.name,
      status: "idle",
      workspaceRoot: rec.cwd,
      repoRoot: rec.repoRoot,
      updatedAt: rec.createdAt,
      turnCount: 0,
      lease: null,
      live: false,
      toolMode: null,
      origin: "web",
    });
  }

  async listChats(): Promise<ChatSummary[]> {
    const indexed = await this.indexedSessions();
    const ids = new Set(indexed.map((session) => session.id));
    const out = indexed.map((session) => this.diskSummary(session));
    // include a just-created web session only while its runtime is live and pi hasn't flushed the
    // JSONL yet — never a phantom for a deleted/never-written session.
    for (const [id, rec] of this.pending)
      if (!ids.has(id) && this.runtimes.has(id)) out.push(this.pendingSummary(id, rec));
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getChat(id: string): Promise<AdapterChatDetail | null> {
    const s = await this.locate(id);
    if (!s) {
      // not on disk yet — if it's a web session whose runtime is still coming up, return a snapshot
      const rec = this.pending.get(id);
      const live = this.runtimes.get(id);
      if (!rec || !live) return null;
      const detail: AdapterChatDetail = { ...this.pendingSummary(id, rec), turns: [], timeline: [] };
      detail.runState = this.runStates.get(id) ?? "idle";
      detail.config = this.configCache.get(id);
      if (!detail.config) detail.config = await this.buildConfig(id, live).catch(() => undefined);
      detail.pendingExtension = this.pendingExtensions.get(id);
      return detail;
    }
    const detail: AdapterChatDetail = {
      ...this.withLiveStatus(s.summary),
      turns: s.turns,
      timeline: s.timeline,
      leaseHistory: s.leaseHistory,
      attributionDiagnostics: s.attributionDiagnostics,
      runState: this.runStates.get(id) ?? (this.liveStatus.get(id) === "running" ? "running" : "idle"),
    };
    detail.pendingExtension = this.pendingExtensions.get(id);
    const live = this.runtimes.get(id);
    if (live) {
      detail.config = this.configCache.get(id);
      if (!detail.config) {
        try {
          detail.config = await this.buildConfig(id, live);
        } catch {
          /* runtime may be mid-restart */
        }
      }
    }
    return detail;
  }

  async resume(id: string): Promise<ChatSummary> {
    // Attaching a runtime lets you drive the session (for an external one, this is the take-over the
    // UI gates behind a warning). It does NOT change provenance: an external session stays external —
    // it may be running elsewhere, so the gate should reappear after a restart.
    const wasLive = this.runtimes.has(id);
    const rt = await this.ensureRuntime(id);
    // Do not downgrade an already-running runtime when a browser renews its attachment/lease.
    if (!wasLive) {
      this.liveStatus.set(id, "waiting");
      this.runStates.set(id, "idle");
    }
    const summary = await this.summaryOf(id);
    this.emit({ type: "chat.updated", chat: summary });
    if (!wasLive) this.emit({ type: "chat.status", chatId: id, status: "waiting" });
    void this.buildConfig(id, rt)
      .then((config) => this.emit({ type: "config", chatId: id, config }))
      .catch(() => undefined);
    return summary;
  }

  async detach(id: string): Promise<ChatSummary> {
    const summary = await this.summaryOf(id); // validate before mutating runtime state
    const runState = this.runStates.get(id) ?? "idle";
    if (runState !== "idle" && runState !== "error") {
      throw Object.assign(new Error("cannot close a session while the agent is running"), { httpStatus: 409 });
    }
    await this.runtimes.stop(id);
    this.liveStatus.set(id, "idle");
    this.runStates.set(id, "idle");
    this.configCache.delete(id);
    this.clearPendingExtension(id);
    const detached: ChatSummary = { ...summary, status: "idle", live: false, toolMode: null };
    this.emit({ type: "chat.updated", chat: detached });
    return detached;
  }

  async compact(id: string): Promise<ChatSummary> {
    const rt = await this.ensureRuntime(id);
    await rt.compact();
    return this.summaryOf(id);
  }

  async rename(id: string, name: string): Promise<ChatSummary> {
    const live = this.runtimes.get(id);
    if (live) {
      await live.setName(name);
    } else {
      const rt = await this.ensureRuntime(id);
      try {
        await rt.setName(name);
      } finally {
        await this.runtimes.stop(id);
      }
    }
    const rec = this.pending.get(id);
    if (rec) rec.name = name; // keep the not-yet-flushed session's display name in sync
    return this.summaryOf(id);
  }

  async listWorkspaces(): Promise<string[]> {
    const roots: string[] = [];
    for (const root of this.workspaceRoots) {
      try {
        if ((await stat(root)).isDirectory()) roots.push(root);
      } catch {
        /* skip */
      }
    }
    return roots;
  }

  private assertRoot(root: string): void {
    if (!this.workspaceRoots.some((r) => root === r || root.startsWith(r + "/"))) {
      throw Object.assign(new Error("workspace outside WORKSPACE_ROOTS"), { code: "EACCES" });
    }
  }

  async openWorkspace(root: string): Promise<ChatSummary> {
    this.assertRoot(root);
    return this.createChat(root);
  }

  async createChat(root: string, name?: string): Promise<ChatSummary> {
    this.assertRoot(root);
    const id = `ws-${basename(root)}-${randomUUID()}`;
    const now = Date.now();
    const displayName = name ?? `${basename(root)} · new`;
    const repoRoot = await resolveRepoRoot(root);
    this.toolMode.set(id, NEW_TOOLMODE);
    // Track it in-memory so getChat/listChats/send resolve it immediately — pi hasn't flushed its
    // JSONL yet. Provenance ("web") comes from the ws- id, so nothing needs persisting.
    this.pending.set(id, { cwd: root, repoRoot, name: displayName, createdAt: now });
    const overrides: Partial<PiRuntimeOptions> = { tools: NEW_TOOLMODE === "read-only" ? READ_ONLY : undefined };
    if (NEW_MODEL) overrides.model = NEW_MODEL;
    if (NEW_THINKING) overrides.thinking = NEW_THINKING;
    this.runtimes.ensure(id, SESSIONS_DIR, root, overrides);
    return {
      id,
      name: displayName,
      status: "idle",
      workspaceRoot: root,
      repoRoot,
      updatedAt: now,
      turnCount: 0,
      lease: null,
      live: true,
      toolMode: NEW_TOOLMODE,
      origin: "web",
    };
  }

  async catalog(): Promise<CatalogEntry[]> {
    // Offer the workspaces you actually use — distinct cwds across existing sessions — plus the
    // configured roots. The browser can also enter any other path inside a root (validated on open).
    const roots = await this.listWorkspaces();
    const counts = new Map<string, number>();
    for (const s of await this.listChats()) counts.set(s.workspaceRoot, (counts.get(s.workspaceRoot) ?? 0) + 1);
    const entries = new Map<string, CatalogEntry>();
    for (const [cwd, sessionCount] of counts) {
      entries.set(cwd, { workspaceRoot: cwd, label: basename(cwd) || cwd, source: "session", sessionCount });
    }
    for (const root of roots) {
      if (!entries.has(root))
        entries.set(root, { workspaceRoot: root, label: basename(root) || root, source: "root", sessionCount: 0 });
    }
    // disambiguate colliding basenames (e.g. several `.../<task>/mobile-arpg`) with a parent segment.
    const byLabel = new Map<string, number>();
    for (const e of entries.values()) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + 1);
    for (const e of entries.values()) {
      if ((byLabel.get(e.label) ?? 0) > 1) {
        const parent = basename(dirname(e.workspaceRoot));
        if (parent) e.label = `${parent}/${e.label}`;
      }
    }
    return [...entries.values()].sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
  }

  async models(refresh = false): Promise<ModelInfo[]> {
    if (refresh) this.modelCache = null;
    if (this.modelCache) return this.modelCache;
    // spawn a short-lived ephemeral runtime to ask pi for its configured/authenticated models.
    const ephemeralId = `models-probe-${Math.floor(process.hrtime()[1] % 1e6)}`;
    const rt = new PiRuntime({ piBin: this.piBin, sessionId: ephemeralId, sessionDir: SESSIONS_DIR, tools: READ_ONLY });
    try {
      this.modelCache = await rt.getAvailableModels();
    } catch {
      this.modelCache = [];
    } finally {
      await rt.close();
    }
    return this.modelCache;
  }

  private async buildConfig(id: string, rt: PiRuntime): Promise<ChatConfig> {
    const [state, levels] = await Promise.all([
      rt.getState().catch(() => ({}) as Record<string, unknown>),
      rt.getAvailableThinkingLevels().catch(() => ["off"]),
    ]);
    // pi's get_state returns `model` as an OBJECT ({id, provider, name, reasoning, …}), not a string.
    const m = state["model"] as { id?: string; provider?: string; name?: string } | undefined;
    const modelId = m?.id ? String(m.id) : "";
    const config: ChatConfig = {
      model: modelId
        ? { provider: String(m?.provider ?? ""), id: modelId, name: String(m?.name ?? modelId) }
        : null,
      thinking: String((state["thinkingLevel"] as string) ?? "off"),
      toolMode: this.toolMode.get(id) ?? NEW_TOOLMODE,
      thinkingLevels: levels.length ? levels : ["off"],
    };
    this.configCache.set(id, config);
    return config;
  }

  async getConfig(id: string): Promise<ChatConfig> {
    return this.buildConfig(id, await this.ensureRuntime(id));
  }

  async setConfig(
    id: string,
    change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode },
  ): Promise<ChatConfig> {
    if (!(await this.resolveDirs(id))) throw Object.assign(new Error(`no such chat: ${id}`), { code: "ENOENT" });
    // toolMode change first: pi applies the tool allowlist only at construction, so dispose and
    // reopen the same session exactly once with the new tool set.
    if (change.toolMode && change.toolMode !== (this.toolMode.get(id) ?? NEW_TOOLMODE)) {
      this.toolMode.set(id, change.toolMode);
      await this.runtimes.stop(id);
    }
    const rt = await this.ensureRuntime(id);
    if (change.model) await rt.setModel(change.model.provider, change.model.id);
    if (change.thinking) await rt.setThinkingLevel(change.thinking);
    const config = await this.buildConfig(id, rt);
    this.emit({ type: "config", chatId: id, config });
    return config;
  }

  async send(
    id: string,
    text: string,
    mode: "normal" | "steer" | "followUp",
    attribution?: WebAttribution,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const rt = await this.ensureRuntime(id);
    const action = mode === "normal" ? "prompt" : mode;
    const streamingBehavior = mode === "normal" ? undefined : mode;
    const now = Date.now();
    if (this.attributionSigner) {
      if (!attribution) throw new Error("collaborative runtime requires an authenticated attribution actor");
      const arm = this.attributionSigner.messageArm({
        sessionId: id,
        requestId: attribution.requestId,
        actor: attribution.actor,
        action,
        viewerId: attribution.viewerId,
        text,
        now,
      });
      await rt.sendAttributed(arm, attribution.requestId, text, streamingBehavior);
    } else {
      await rt.prompt(text, streamingBehavior);
    }
    // Reflect only after Pi accepted the input and, in collaborative mode, persisted attribution.
    this.emit({
      type: "chat.turn",
      chatId: id,
      turn: {
        id: `${id}-u${now}`,
        role: "user",
        text,
        ts: now,
        ...(attribution ? {
          attribution: {
            ...attribution,
            action,
            issuedAt: new Date(now).toISOString(),
          },
        } : {}),
      },
    });
    return { accepted: true, queued: mode !== "normal" };
  }

  async recordLeaseEvent(id: string, event: DurableLeaseEvent): Promise<void> {
    if (!this.attributionSigner) return; // local mode has no authenticated durable actor
    const runtime = await this.ensureRuntime(id);
    const encoded = this.attributionSigner.leaseEvent({
      sessionId: id,
      requestId: event.requestId,
      event: event.event,
      previous: event.previous,
      next: event.next,
      now: Date.parse(event.occurredAt),
    });
    await runtime.appendAttributedLease(encoded, event.requestId);
  }

  async abort(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const pending = this.pendingExtensions.get(id);
    this.emit({ type: "run.state", chatId: id, state: "stopping" });
    await rt.abort(pending?.requestId);
    if (pending && this.pendingExtensions.get(id)?.requestId === pending.requestId) {
      this.clearPendingExtension(id);
    }
  }

  async extensionUiResponse(chatId: string, requestId: string, reply: ExtensionUiReply): Promise<void> {
    const rt = this.runtimes.get(chatId);
    if (!rt) throw Object.assign(new Error(`no live runtime for chat ${chatId}`), { code: "ENOTCONN" });
    const { requestId: _r, ...payload } = reply;
    await rt.extensionUiResponse(requestId, payload as Record<string, unknown>);
    if (this.pendingExtensions.get(chatId)?.requestId === requestId) this.clearPendingExtension(chatId);
  }

  subscribe(listener: (e: AdapterEvent) => void): () => void {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }

  async close(): Promise<void> {
    this.watcher?.close();
    await this.runtimes.closeAll();
    this.bus.removeAllListeners();
  }
}
