// shared/protocol.ts — the wire contract shared by the server, the client, and both adapters.
// Reconstructed 2026-07-23; extended 2026-07-23 with the live agent-run loop (send/steer/stop,
// streamed text/thinking/tool deltas, model+thinking+tool controls). Shapes are grounded in the
// pi rpc protocol (docs/rpc.md; rechecked against 0.83.0): message_update.assistantMessageEvent deltas,
// tool_execution_* events, queue_update, agent_settled, get_available_models, set_model, etc.
import { z } from "zod";

export type ChatStatus = "idle" | "running" | "waiting" | "error" | "done";

/** A settled/live run phase for a chat, distinct from the transcript-derived ChatStatus. */
export type RunState = "idle" | "running" | "stopping" | "compacting" | "retrying" | "error";

export type ToolMode = "read-only" | "full";
/** The read-only allowlist is a model-tool allowlist, NOT an OS sandbox (see README security note). */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface DurableActor {
  provider: "github";
  subject: string;
  login: string;
}

export interface WebAttribution {
  requestId: string;
  actor: DurableActor;
  viewerId: string;
}

export interface TurnAttribution {
  requestId: string;
  actor: DurableActor;
  action: "prompt" | "steer" | "followUp";
  issuedAt: string;
}

/** Internal/native attribution. `viewerId` must be projected out before any browser boundary. */
export interface DurableTurnAttribution extends TurnAttribution {
  viewerId: string;
}

export interface Turn {
  id: string;
  role: "user" | "agent" | "system" | "tool";
  text: string;
  ts: number; // epoch ms
  attribution?: TurnAttribution;
}

export interface DurableLeaseEvent {
  requestId: string;
  event: "acquired" | "released" | "takenOver" | "expired" | "recovered";
  occurredAt: string;
  previous?: { actor: DurableActor; viewerId: string };
  next?: { actor: DurableActor; viewerId: string };
}

/** Browser-safe durable history. Raw viewer IDs remain only in `DurableLeaseEvent`. */
export interface LeaseHistoryEvent {
  requestId: string;
  event: DurableLeaseEvent["event"];
  occurredAt: string;
  previous?: { actor: DurableActor };
  next?: { actor: DurableActor };
  /** True only when the same principal moved between two distinct viewer instances. */
  sameActorViewerChanged?: boolean;
}

export interface DurableTurn extends Omit<Turn, "attribution"> {
  attribution?: DurableTurnAttribution;
}

/** Durable conversation rows reconstructed from Pi's native session JSONL. */
export type ChatTimelineItem =
  | ({ kind: "turn" } & Turn)
  | { kind: "thinking"; id: string; text: string; ts: number }
  | {
      kind: "tool";
      id: string; // Pi's stable toolCallId
      name: string;
      argsSummary: string;
      state: "running" | "success" | "error";
      preview: string;
      ts: number;
    };

/** A model pi has configured/authenticated. Never hard-coded — always from pi's own listing. */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

/** Per-chat live controls, mirrored from pi's session state. */
export interface ChatConfig {
  model: { provider: string; id: string; name: string } | null;
  thinking: string; // one of thinkingLevels
  toolMode: ToolMode;
  thinkingLevels: string[]; // levels the current model supports ("off" only ⇒ no reasoning)
}

export interface PrincipalIdentity {
  provider: "github" | "local";
  subject: string;
  login: string;
}

/** Client-safe controller state. Browser viewer IDs never leave their originating request. */
export interface PresenceParticipant {
  /** Browser-safe authenticated principal. Raw viewer identifiers are never serialized. */
  actor: PrincipalIdentity;
  /** Number of distinct live viewer instances collapsed under this principal. */
  viewerCount: number;
}

export interface PresenceSnapshot {
  revision: number;
  observedAt: number;
  participants: PresenceParticipant[];
}

export interface LeaseInfo {
  /** Opaque correlation ID only; never accepted as authority. */
  leaseId: string;
  actor: PrincipalIdentity;
  acquiredAt: number;
  expiresAt: number;
  /** Present only in a response personalized for the requesting principal+viewer. */
  isHolder?: boolean;
}

export interface ChatSummary {
  id: string;
  name: string;
  status: ChatStatus;
  workspaceRoot: string; // the session's actual cwd (a specific worktree/branch)
  /** The underlying repo (worktrees + main tree resolve here) — used to group the session rail. */
  repoRoot: string;
  updatedAt: number;
  turnCount: number;
  lease: LeaseInfo | null;
  /** True when this server holds a live web runtime for the session right now. */
  live: boolean;
  /** Active tool access for a live session; null when no runtime is attached here. */
  toolMode: ToolMode | null;
  /**
   * Provenance:
   *  - "web": created through this dashboard (Pi Together owns it — safe to drive).
   *  - "external": found on disk from a terminal / tmux-agent / kandev task. It may be running in
   *    another process, so driving it here risks a concurrent-writer conflict; the UI gates control
   *    behind an explicit take-over.
   */
  origin: "web" | "external";
}

export interface ExtensionUiRequest {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  prefill?: string;
  placeholder?: string;
}

export interface ChatDetail extends ChatSummary {
  turns: Turn[];
  /** Messages plus persisted thinking/tool traces, in session order. */
  timeline: ChatTimelineItem[];
  config?: ChatConfig;
  queue?: { steering: string[]; followUp: string[] };
  runState?: RunState;
  leaseHistory?: LeaseHistoryEvent[];
  attributionDiagnostics?: Array<{ requestId: string; reason: "delivery-incomplete" }>;
  pendingExtension?: ExtensionUiRequest;
}

/** Adapter/native detail. It is never serialized without the server's public projection. */
export interface AdapterChatDetail extends Omit<ChatDetail, "turns" | "timeline" | "leaseHistory"> {
  turns: DurableTurn[];
  timeline: AdapterChatTimelineItem[];
  leaseHistory?: DurableLeaseEvent[];
}

export type AdapterChatTimelineItem =
  | ({ kind: "turn" } & DurableTurn)
  | Exclude<ChatTimelineItem, { kind: "turn" }>;

/** A place a new/resumed chat can run — a workspace the adapter knows about (root or a used cwd). */
export interface CatalogEntry {
  workspaceRoot: string;
  label: string;
  /** Repository/worktree, prior-session cwd, or an approved folder that currently contains no repository. */
  source: "root" | "session" | "folder";
  /** Number of existing sessions whose cwd is this workspace (always 0 for an empty approved folder). */
  sessionCount: number;
}

export interface WorkspaceRefreshPayload {
  chats: ChatSummary[];
  catalog: CatalogEntry[];
  workspaces: string[];
  truncated: boolean;
}

export interface BootstrapPayload {
  owner: string;
  principal: PrincipalIdentity;
  origin: string;
  adapter: "real" | "fake";
  chats: ChatSummary[];
  catalog: CatalogEntry[];
  workspaces: string[];
  models: ModelInfo[];
}

// ---- streaming item shapes carried over SSE ----
export interface ToolActivity {
  callId: string;
  name: string;
  argsSummary: string;
  state: "running" | "success" | "error";
  preview: string; // bounded (see MAX_TOOL_PREVIEW)
}

export const MAX_TOOL_PREVIEW = 4000;

/**
 * Events pushed over the SSE `/events` stream. Every event that mutates a specific chat carries a
 * `chatId` so a client can reconcile by stable item IDs (itemId / callId) on reconnect.
 */
export type ServerEvent =
  | { type: "hello"; now: number }
  // list/lifecycle
  | { type: "chat.updated"; chat: ChatSummary }
  | { type: "chat.turn"; chatId: string; turn: Turn }
  | { type: "chat.status"; chatId: string; status: ChatStatus }
  | { type: "chat.lease"; chatId: string; lease: LeaseInfo | null }
  | ({ type: "chat.presence"; chatId: string } & PresenceSnapshot)
  | { type: "lease.history"; chatId: string; event: LeaseHistoryEvent }
  | { type: "chat.removed"; chatId: string }
  // live run
  | { type: "run.state"; chatId: string; state: RunState }
  | { type: "msg.start"; chatId: string; itemId: string; role: "agent" }
  | { type: "msg.delta"; chatId: string; itemId: string; text: string }
  | { type: "thinking.delta"; chatId: string; itemId: string; text: string }
  | { type: "msg.end"; chatId: string; itemId: string; role: "agent"; text: string; thinking?: string }
  | { type: "tool.start"; chatId: string; callId: string; name: string; argsSummary: string }
  | { type: "tool.update"; chatId: string; callId: string; preview: string }
  | { type: "tool.end"; chatId: string; callId: string; name: string; ok: boolean; preview: string }
  | { type: "queue"; chatId: string; steering: string[]; followUp: string[] }
  | { type: "notice"; chatId: string; kind: "retry" | "compaction" | "extension" | "info" | "error"; text: string }
  | { type: "config"; chatId: string; config: ChatConfig }
  | ({ type: "ext.request"; chatId: string } & ExtensionUiRequest)
  | { type: "ext.clear"; chatId: string; requestId: string };

/** Internal adapter stream. Sensitive variants are projected to `ServerEvent` at the registry. */
export type AdapterEvent =
  | ServerEvent
  | { type: "chat.turn"; chatId: string; turn: DurableTurn }
  | { type: "lease.history"; chatId: string; event: DurableLeaseEvent };

// ---- request bodies (validated server-side with zod) ----
export const ViewerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const ResumeReq = z.object({
  chatId: z.string().min(1),
  viewer: ViewerId,
  /** Explicit UI resumes may transfer control from another Pi Together browser/device. */
  takeover: z.boolean().optional().default(false),
});
export type ResumeReq = z.infer<typeof ResumeReq>;

export const ViewerReq = z.object({ viewer: ViewerId });
export type ViewerReq = z.infer<typeof ViewerReq>;

export const CloseReq = ViewerReq;
export type CloseReq = z.infer<typeof CloseReq>;

export const RenameReq = z.object({ viewer: ViewerId, name: z.string().min(1).max(200) });
export type RenameReq = z.infer<typeof RenameReq>;

export const OpenWorkspaceReq = z.object({ root: z.string().min(1), viewer: ViewerId });
export type OpenWorkspaceReq = z.infer<typeof OpenWorkspaceReq>;

export const CreateChatReq = z.object({
  workspaceRoot: z.string().min(1),
  viewer: ViewerId,
  name: z.string().max(200).optional(),
});
export type CreateChatReq = z.infer<typeof CreateChatReq>;

export const SendReq = z.object({
  viewer: ViewerId,
  text: z.string().min(1).max(100_000),
  mode: z.enum(["normal", "steer", "followUp"]).default("normal"),
});
export type SendReq = z.infer<typeof SendReq>;

export const ConfigReq = z
  .object({
    viewer: ViewerId,
    model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).optional(),
    thinking: z.string().min(1).max(20).optional(),
    toolMode: z.enum(["read-only", "full"]).optional(),
  })
  .refine((v) => v.model || v.thinking || v.toolMode, { message: "no config change requested" });
export type ConfigReq = z.infer<typeof ConfigReq>;

export const ExtensionUiResponseReq = z.object({
  viewer: ViewerId,
  requestId: z.string().min(1),
  value: z.unknown().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});
export type ExtensionUiResponseReq = z.infer<typeof ExtensionUiResponseReq>;
export type ExtensionUiReply = Omit<ExtensionUiResponseReq, "viewer">;

/** The adapter contract. `real` talks to the live pi store/runtime; `fake` is deterministic. */
export interface PiAdapter {
  readonly kind: "real" | "fake";
  listChats(): Promise<ChatSummary[]>;
  getChat(id: string): Promise<AdapterChatDetail | null>;
  resume(id: string): Promise<ChatSummary>;
  /** Detach the live runtime without deleting the durable session. */
  detach(id: string): Promise<ChatSummary>;
  compact(id: string): Promise<ChatSummary>;
  rename(id: string, name: string): Promise<ChatSummary>;
  listWorkspaces(): Promise<string[]>;
  openWorkspace(root: string): Promise<ChatSummary>;
  createChat(workspaceRoot: string, name?: string): Promise<ChatSummary>;
  catalog(): Promise<CatalogEntry[]>;
  /** Optional derived-catalog refresh; never mutates deployment policy. */
  refreshWorkspaces?(): Promise<{ truncated: boolean }>;
  /** Refresh bypasses the process-local discovery cache after explicit user actions such as creating a session. */
  models(refresh?: boolean): Promise<ModelInfo[]>;
  // live agent-run loop
  send(
    id: string,
    text: string,
    mode: "normal" | "steer" | "followUp",
    attribution?: WebAttribution,
  ): Promise<{ accepted: boolean; queued: boolean }>;
  abort(id: string): Promise<void>;
  getConfig(id: string): Promise<ChatConfig>;
  setConfig(
    id: string,
    change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode },
  ): Promise<ChatConfig>;
  extensionUiResponse(chatId: string, requestId: string, reply: ExtensionUiReply): Promise<void>;
  recordLeaseEvent(chatId: string, event: DurableLeaseEvent): Promise<void>;
  /** Subscribe to adapter-originated events; returns an unsubscribe fn. */
  subscribe(listener: (e: AdapterEvent) => void): () => void;
  close(): Promise<void>;
}
