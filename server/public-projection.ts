// server/public-projection.ts — the single browser-safe projection for collaboration metadata.
// Durable Pi entries and adapter state retain viewer IDs; HTTP/SSE values never do.
import type {
  AdapterChatDetail,
  AdapterChatTimelineItem,
  AdapterEvent,
  ChatDetail,
  ChatTimelineItem,
  ChatSummary,
  DurableLeaseEvent,
  LeaseInfo,
  DurableTurn,
  LeaseHistoryEvent,
  ServerEvent,
  Turn,
} from "../shared/protocol.js";

function publicLease(lease: LeaseInfo | null): LeaseInfo | null {
  if (!lease) return null;
  return {
    leaseId: lease.leaseId,
    actor: {
      provider: lease.actor.provider,
      subject: lease.actor.subject,
      login: lease.actor.login,
    },
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    ...(lease.isHolder === undefined ? {} : { isHolder: lease.isHolder }),
  };
}

export function publicChatSummary(chat: ChatSummary): ChatSummary {
  return {
    id: chat.id,
    name: chat.name,
    status: chat.status,
    workspaceRoot: chat.workspaceRoot,
    repoRoot: chat.repoRoot,
    updatedAt: chat.updatedAt,
    turnCount: chat.turnCount,
    lease: publicLease(chat.lease),
    live: chat.live,
    toolMode: chat.toolMode,
    origin: chat.origin,
  };
}

export function publicTurn(turn: DurableTurn): Turn {
  const base: Turn = { id: turn.id, role: turn.role, text: turn.text, ts: turn.ts };
  if (!turn.attribution) return base;
  return {
    ...base,
    attribution: {
      requestId: turn.attribution.requestId,
      actor: {
        provider: turn.attribution.actor.provider,
        subject: turn.attribution.actor.subject,
        login: turn.attribution.actor.login,
      },
      action: turn.attribution.action,
      issuedAt: turn.attribution.issuedAt,
    },
  };
}

export function publicLeaseHistoryEvent(event: DurableLeaseEvent): LeaseHistoryEvent {
  const previous = event.previous ? { actor: { ...event.previous.actor } } : undefined;
  const next = event.next ? { actor: { ...event.next.actor } } : undefined;
  const sameActorViewerChanged = !!event.previous && !!event.next
    && event.previous.actor.provider === event.next.actor.provider
    && event.previous.actor.subject === event.next.actor.subject
    && event.previous.viewerId !== event.next.viewerId;
  return {
    requestId: event.requestId,
    event: event.event,
    occurredAt: event.occurredAt,
    ...(previous ? { previous } : {}),
    ...(next ? { next } : {}),
    ...(sameActorViewerChanged ? { sameActorViewerChanged: true } : {}),
  };
}

function publicTimelineItem(item: AdapterChatTimelineItem): ChatTimelineItem {
  return item.kind === "turn" ? { kind: "turn", ...publicTurn(item) } : { ...item };
}

export function publicChatDetail(detail: AdapterChatDetail): ChatDetail {
  return {
    ...publicChatSummary(detail),
    config: detail.config,
    queue: detail.queue,
    runState: detail.runState,
    attributionDiagnostics: detail.attributionDiagnostics,
    pendingExtension: detail.pendingExtension,
    turns: detail.turns.map(publicTurn),
    timeline: detail.timeline.map(publicTimelineItem),
    leaseHistory: detail.leaseHistory?.map(publicLeaseHistoryEvent),
  };
}

/** Adapter events can structurally contain durable turn attribution; project before public replay. */
export function publicAdapterEvent(event: AdapterEvent): ServerEvent {
  if (event.type === "chat.updated") return { ...event, chat: publicChatSummary(event.chat) };
  if (event.type === "chat.turn") return { ...event, turn: publicTurn(event.turn as DurableTurn) };
  if (event.type === "lease.history") {
    return { ...event, event: publicLeaseHistoryEvent(event.event as DurableLeaseEvent) };
  }
  return event;
}
