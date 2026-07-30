// pi-adapter/normalize.ts — turn a pi session jsonl into the shared protocol shape.
//
// Validated against pi session JSONL (fixture from 0.81.1; shape rechecked against 0.83.0).
// pi records are typed lines: `session` (header: version/id/cwd), `session_info` (name),
// `model_change`, `thinking_level_change`, and `message` (nested `{role, content[], timestamp}`).
// A session file is a transcript only — it carries no run status; the live status ("running"/
// "waiting") is owned by the runtime layer, so we report "idle" here.
import {
  MAX_TOOL_PREVIEW,
  type ChatStatus,
  type AdapterChatTimelineItem,
  type DurableLeaseEvent,
  type DurableTurn,
  type DurableTurnAttribution,
} from "../shared/protocol.js";
import { parseAttributionEntry, parseLeaseEntry, type AttributionData } from "./collaboration-entries.js";

export interface RawContentPart {
  type?: string; // "text" | "thinking" | "toolCall" (plus legacy spellings)
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

export interface RawMessage {
  role?: string; // "user" | "assistant" | "toolResult" | extended Pi roles
  content?: RawContentPart[] | string;
  timestamp?: number; // epoch ms
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [k: string]: unknown;
}

export interface RawSessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number; // ISO (outer) or epoch ms
  // session header
  version?: number;
  cwd?: string;
  // session_info
  name?: string;
  // message/custom
  message?: RawMessage;
  customType?: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface NormalizedSession {
  id: string | null; // pi's session id (from the `session` header)
  name: string | null;
  cwd: string | null;
  status: ChatStatus; // always "idle" from a file; runtime layer overrides
  turns: DurableTurn[];
  timeline: AdapterChatTimelineItem[];
  leaseHistory: DurableLeaseEvent[];
  attributionDiagnostics: Array<{ requestId: string; reason: "delivery-incomplete" }>;
  updatedAt: number;
}

const ROLE_MAP: Record<string, DurableTurn["role"]> = {
  user: "user",
  assistant: "agent",
  system: "system",
  tool: "tool", // legacy sessions only; current Pi uses toolResult
};

function toEpochMs(v: number | string | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? Math.round(v * 1000) : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

const ROLE_TO_TURN: Record<string, DurableTurn["role"]> = ROLE_MAP;

/** Convert a single pi AgentMessage ({role, content[]}) into a Turn, or null if not displayable. */
export function messageToTurn(m: RawMessage, id: string, fallbackTs: number): DurableTurn | null {
  const role = ROLE_TO_TURN[String(m.role ?? "").toLowerCase()];
  if (!role) return null;
  const text = renderContent(m.content);
  if (!text && role !== "user") return null;
  return { id, role, text, ts: toEpochMs(m.timestamp) ?? fallbackTs };
}

/** Flatten only user/assistant display text; process traces are normalized separately. */
export function renderContent(content: RawMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" || p.type === undefined)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

/** Complete model thinking from a finalized assistant message. */
export function renderThinking(content: RawMessage["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "thinking" || p.type === "reasoning")
    .map((p) => (typeof p.thinking === "string" ? p.thinking : typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

/** One-line, bounded tool label shared by disk replay and live RPC events. */
export function summarizeToolArgs(name: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") return `${name}: ${a.command}`.slice(0, 200);
    if (typeof a.path === "string") return `${name}: ${a.path}`.slice(0, 200);
    if (typeof a.pattern === "string") return `${name}: ${a.pattern}`.slice(0, 200);
    try {
      return `${name} ${JSON.stringify(a)}`.slice(0, 200);
    } catch {
      return name;
    }
  }
  return name;
}

/** Bounded text preview for a persisted toolResult message. */
export function previewToolContent(content: RawMessage["content"]): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part.text === "string" ? part.text : "")).join("")
      : "";
  return text.length > MAX_TOOL_PREVIEW ? `${text.slice(0, MAX_TOOL_PREVIEW)}\n… (truncated)` : text;
}

/**
 * Derive a human-readable session name from the transcript when Pi has no explicit `session_info`
 * name (the common case). Uses the first meaningful user message, stripping leading system-injected
 * XML-ish blocks (`<kandev-system>…</kandev-system>`, `<system-reminder>…`, etc.) that would
 * otherwise surface as the title. Returns null if nothing usable is found.
 */
const NOISE_LINE = /^(?:>|#{1,6}\s|\s*[-*]\s|```|<)|HARNESS CONSTRAINT|KANDEV|system-reminder|OVERRIDE|^\s*⚠/i;

export function deriveNameFromTurns(turns: DurableTurn[]): string | null {
  for (const t of turns) {
    if (t.role !== "user") continue;
    let s = t.text;
    // strip a leading run of fully-tagged blocks: <tag ...>…</tag>
    s = s.replace(/^\s*(?:<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*)+/g, "");
    // pick the first line that reads like a real instruction — skip blockquotes, headings, list
    // bullets, code fences, tag lines, and known system-preamble markers.
    for (const raw of s.split("\n")) {
      const line = raw.trim();
      if (line.length < 3 || NOISE_LINE.test(line)) continue;
      // must contain some letters/digits (skip pure emoji/symbol lines)
      if (!/[a-zA-Z0-9]/.test(line)) continue;
      // drop literal markdown emphasis so the title doesn't show raw ** or ` characters
      const clean = line.replace(/[*`]+/g, "").replace(/\s+/g, " ").trim();
      if (clean.length < 3) continue;
      return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
    }
  }
  return null;
}

export function selectCurrentBranch(entries: RawSessionEntry[], currentLeafId?: string): RawSessionEntry[] {
  const hasTreeLinks = entries.some((entry) => entry.parentId !== undefined);
  if (!hasTreeLinks) return entries;
  const byId = new Map<string, RawSessionEntry>();
  for (const entry of entries) {
    if (entry.type === "session" || typeof entry.id !== "string") continue;
    if (byId.has(entry.id)) return [];
    byId.set(entry.id, entry);
  }
  const leafId = currentLeafId ?? [...entries].reverse().find((entry) => entry.type !== "session" && typeof entry.id === "string")?.id;
  if (!leafId || !byId.has(leafId)) return [];
  const branch: RawSessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: RawSessionEntry | undefined = byId.get(leafId);
  while (cursor?.id) {
    if (seen.has(cursor.id)) return [];
    branch.push(cursor);
    seen.add(cursor.id);
    cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
  }
  return branch.reverse();
}

export function normalizeSessionEntries(
  entries: RawSessionEntry[],
  options: { currentLeafId?: string } = {},
): NormalizedSession {
  const turns: DurableTurn[] = [];
  const timeline: AdapterChatTimelineItem[] = [];
  const tools = new Map<string, Extract<AdapterChatTimelineItem, { kind: "tool" }>>();
  const leaseHistory: DurableLeaseEvent[] = [];
  const pendingAttribution: AttributionData[] = [];
  const seenAttributionRequests = new Set<string>();
  const seenLeaseRequests = new Set<string>();
  const attributionDiagnostics: Array<{ requestId: string; reason: "delivery-incomplete" }> = [];
  let id: string | null = null;
  let name: string | null = null;
  let cwd: string | null = null;
  let updatedAt = 0;

  for (const entry of entries) {
    if (entry.type === "session") {
      if (typeof entry.id === "string") id = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      const timestamp = toEpochMs(entry.timestamp);
      if (timestamp && timestamp > updatedAt) updatedAt = timestamp;
    }
  }

  for (const e of selectCurrentBranch(entries, options.currentLeafId)) {
    const outerTs = toEpochMs(e.timestamp);
    if (outerTs && outerTs > updatedAt) updatedAt = outerTs;

    const attribution = parseAttributionEntry(e);
    if (attribution && !seenAttributionRequests.has(attribution.requestId)) {
      seenAttributionRequests.add(attribution.requestId);
      pendingAttribution.push(attribution);
      continue;
    }
    const lease = parseLeaseEntry(e);
    if (lease && !seenLeaseRequests.has(lease.requestId)) {
      seenLeaseRequests.add(lease.requestId);
      leaseHistory.push({
        requestId: lease.requestId,
        event: lease.event,
        occurredAt: lease.occurredAt,
        ...(lease.previous ? { previous: lease.previous } : {}),
        ...(lease.next ? { next: lease.next } : {}),
      });
      continue;
    }

    switch (e.type) {
      case "session_info":
        if (typeof e.name === "string") name = e.name;
        break;
      case "message": {
        const m = e.message;
        if (!m) break;
        const rawRole = String(m.role ?? "");
        const role = ROLE_MAP[rawRole.toLowerCase()];
        const ts = toEpochMs(m.timestamp) ?? outerTs ?? updatedAt;
        if (ts > updatedAt) updatedAt = ts;

        if (rawRole.toLowerCase() === "toolresult") {
          const callId = String(m.toolCallId ?? e.id ?? `tool-${timeline.length}`);
          const existing = tools.get(callId);
          const preview = previewToolContent(m.content);
          if (existing) {
            existing.state = m.isError ? "error" : "success";
            existing.preview = preview;
          } else {
            const tool: Extract<AdapterChatTimelineItem, { kind: "tool" }> = {
              kind: "tool",
              id: callId,
              name: String(m.toolName ?? "tool"),
              argsSummary: String(m.toolName ?? "tool"),
              state: m.isError ? "error" : "success",
              preview,
              ts,
            };
            tools.set(callId, tool);
            timeline.push(tool);
          }
          break;
        }

        if (!role) break;
        if (role === "agent" && Array.isArray(m.content)) {
          for (let i = 0; i < m.content.length; i++) {
            const part = m.content[i]!;
            if (part.type === "thinking" || part.type === "reasoning") {
              const text = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
              if (text) timeline.push({ kind: "thinking", id: `${e.id ?? `a${timeline.length}`}-thinking-${i}`, text, ts });
            } else if (part.type === "toolCall" || part.type === "tool_call" || part.type === "tool_use") {
              const callId = String(part.id ?? `${e.id ?? "tool"}-${i}`);
              const name = String(part.name ?? "tool");
              const tool: Extract<AdapterChatTimelineItem, { kind: "tool" }> = {
                kind: "tool",
                id: callId,
                name,
                argsSummary: summarizeToolArgs(name, part.arguments ?? part["input"]),
                state: "running",
                preview: "",
                ts,
              };
              tools.set(callId, tool);
              timeline.push(tool);
            }
          }
        }

        const text = renderContent(m.content);
        if (!text && role !== "user") break; // pure thinking/tool-call assistant messages are traces only
        const matched = role === "user" ? pendingAttribution.shift() : undefined;
        const turn: DurableTurn = {
          id: e.id ?? `t${turns.length}`,
          role,
          text,
          ts,
          ...(matched ? {
            attribution: {
              requestId: matched.requestId,
              actor: matched.actor,
              action: matched.action,
              viewerId: matched.viewerId,
              issuedAt: matched.issuedAt,
            } satisfies DurableTurnAttribution,
          } : {}),
        };
        turns.push(turn);
        timeline.push({ kind: "turn", ...turn });
        break;
      }
      default:
        break; // model_change / thinking_level_change / unknown → ignored
    }
  }

  for (const orphan of pendingAttribution) {
    attributionDiagnostics.push({ requestId: orphan.requestId, reason: "delivery-incomplete" });
  }

  // Explicit session_info name wins; otherwise derive one from the first meaningful user message.
  return {
    id,
    name: name ?? deriveNameFromTurns(turns),
    cwd,
    status: "idle",
    turns,
    timeline,
    leaseHistory,
    attributionDiagnostics,
    updatedAt,
  };
}
