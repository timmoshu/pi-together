import type { ChatDetail, ChatSummary, PrincipalIdentity, ServerEvent } from "../../shared/protocol";
import { mergeClientLease } from "./lease-heartbeat";
import type { AppState, ControlNotice, TimelineItem } from "./store-types";
import { samePrincipal } from "./principal";

export function detailToTimeline(detail: ChatDetail): TimelineItem[] {
  return detail.timeline?.map((item) => ({ ...item }))
    ?? detail.turns.map((turn) => ({ kind: "turn" as const, ...turn }));
}

export function controlLossNotice(
  previous: ChatSummary["lease"],
  incoming: ChatSummary["lease"],
  principal: PrincipalIdentity | undefined,
  chatId: string,
  existing: ControlNotice | null,
): ControlNotice | null {
  if (!previous?.isHolder || !incoming || previous.leaseId === incoming.leaseId) return existing;
  if (existing?.leaseId === incoming.leaseId) return existing;
  return {
    chatId,
    leaseId: incoming.leaseId,
    actor: incoming.actor,
    samePrincipal: samePrincipal(incoming.actor, principal),
  };
}

function recordControlLoss(state: AppState, chatId: string, incoming: ChatSummary["lease"]): void {
  const previous = state.selected?.id === chatId ? state.selected.summary.lease : null;
  state.controlNotice = controlLossNotice(previous, incoming, state.boot?.principal, chatId, state.controlNotice);
}

function leaseFromSummaryUpdate(
  current: ChatSummary["lease"],
  incoming: ChatSummary["lease"],
): ChatSummary["lease"] {
  // Adapter-originated chat.updated summaries have no lease knowledge. Authoritative lease clearing
  // arrives as chat.lease, so do not create a transient control loss/flicker here.
  return incoming === null && current !== null ? current : mergeClientLease(current, incoming);
}

export function upsertChat(state: AppState, chat: ChatSummary): void {
  const previous = state.chats.find((candidate) => candidate.id === chat.id);
  const merged = previous ? { ...chat, lease: mergeClientLease(previous.lease, chat.lease) } : chat;
  state.chats = [...state.chats.filter((candidate) => candidate.id !== chat.id), merged]
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function applyToSelected(state: AppState, event: ServerEvent, seen: Set<string>): void {
  const selected = state.selected;
  if (!selected || !("chatId" in event) || event.chatId !== selected.id) return;
  switch (event.type) {
    case "lease.history":
      if (!selected.leaseHistory.some((entry) => entry.requestId === event.event.requestId)) {
        selected.leaseHistory = [...selected.leaseHistory, event.event];
      }
      break;
    case "chat.turn":
      if (!seen.has(event.turn.id)) {
        seen.add(event.turn.id);
        selected.timeline = [...selected.timeline, { kind: "turn", ...event.turn }];
      }
      break;
    case "msg.start":
      selected.live = { itemId: event.itemId, assistant: "", thinking: "", active: true };
      break;
    case "msg.delta":
      selected.live = { ...selected.live, assistant: selected.live.assistant + event.text, active: true };
      break;
    case "thinking.delta":
      selected.live = { ...selected.live, thinking: selected.live.thinking + event.text, active: true };
      break;
    case "msg.end": {
      const thinking = (selected.live.thinking || event.thinking || "").trim();
      const id = `${event.itemId}-think`;
      if (thinking && !seen.has(id)) {
        seen.add(id);
        selected.timeline = [...selected.timeline, { kind: "thinking", id, text: thinking, ts: Date.now() }];
      }
      selected.live = { itemId: null, assistant: "", thinking: "", active: false };
      break;
    }
    case "tool.start": {
      const thinking = selected.live.thinking.trim();
      const id = selected.live.itemId ? `${selected.live.itemId}-think` : "";
      if (thinking && id && !seen.has(id)) {
        seen.add(id);
        selected.timeline = [...selected.timeline, { kind: "thinking", id, text: thinking, ts: Date.now() }];
        selected.live = { ...selected.live, thinking: "" };
      }
      if (!seen.has(event.callId)) {
        seen.add(event.callId);
        selected.timeline = [...selected.timeline, {
          kind: "tool",
          id: event.callId,
          name: event.name,
          argsSummary: event.argsSummary,
          state: "running",
          preview: "",
          ts: Date.now(),
        }];
      }
      break;
    }
    case "tool.update":
      selected.timeline = selected.timeline.map((item) =>
        item.kind === "tool" && item.id === event.callId ? { ...item, preview: event.preview } : item,
      );
      break;
    case "tool.end":
      selected.timeline = selected.timeline.map((item) =>
        item.kind === "tool" && item.id === event.callId
          ? { ...item, state: event.ok ? "success" : "error", preview: event.preview || item.preview }
          : item,
      );
      break;
    case "queue":
      selected.queue = { steering: event.steering, followUp: event.followUp };
      break;
    case "run.state":
      selected.runState = event.state;
      if (event.state === "idle") selected.live = { ...selected.live, active: false };
      break;
    case "notice":
      selected.timeline = [...selected.timeline, {
        kind: "notice",
        id: `n${selected.timeline.length}-${event.text.slice(0, 16)}`,
        noticeKind: event.kind,
        text: event.text,
      }];
      break;
    case "config":
      selected.config = event.config;
      break;
    case "ext.request":
      selected.ext = {
        requestId: event.requestId,
        method: event.method,
        title: event.title,
        message: event.message,
        options: event.options,
        prefill: event.prefill,
        placeholder: event.placeholder,
      };
      break;
    case "ext.clear":
      if (selected.ext?.requestId === event.requestId) selected.ext = null;
      break;
    default:
      break;
  }
}

export function applyServerEvent(state: AppState, event: ServerEvent, seen: Set<string>): void {
  switch (event.type) {
    case "hello":
      break;
    case "chat.updated":
      state.chats = [...state.chats.filter((chat) => chat.id !== event.chat.id), {
        ...event.chat,
        lease: leaseFromSummaryUpdate(
          state.chats.find((chat) => chat.id === event.chat.id)?.lease ?? null,
          event.chat.lease,
        ),
      }].sort((left, right) => right.updatedAt - left.updatedAt);
      if (state.selected?.id === event.chat.id) {
        state.selected.summary = {
          ...event.chat,
          lease: leaseFromSummaryUpdate(state.selected.summary.lease, event.chat.lease),
        };
      }
      break;
    case "chat.status":
      state.chats = state.chats.map((chat) => chat.id === event.chatId ? { ...chat, status: event.status } : chat);
      if (state.selected?.id === event.chatId) state.selected.summary = { ...state.selected.summary, status: event.status };
      break;
    case "chat.lease":
      recordControlLoss(state, event.chatId, event.lease);
      state.chats = state.chats.map((chat) =>
        chat.id === event.chatId ? { ...chat, lease: mergeClientLease(chat.lease, event.lease) } : chat,
      );
      if (state.selected?.id === event.chatId) {
        state.selected.summary = {
          ...state.selected.summary,
          lease: mergeClientLease(state.selected.summary.lease, event.lease),
        };
      }
      break;
    case "chat.presence": {
      const current = state.presence[event.chatId];
      if (!current || event.observedAt > current.observedAt
        || (event.observedAt === current.observedAt && event.revision > current.revision)) {
        state.presence = {
          ...state.presence,
          [event.chatId]: {
            revision: event.revision,
            observedAt: event.observedAt,
            participants: event.participants.map((participant) => ({
              actor: { ...participant.actor },
              viewerCount: participant.viewerCount,
            })),
          },
        };
      }
      break;
    }
    case "chat.removed": {
      state.chats = state.chats.filter((chat) => chat.id !== event.chatId);
      const { [event.chatId]: _removed, ...remainingPresence } = state.presence;
      state.presence = remainingPresence;
      break;
    }
    default:
      applyToSelected(state, event, seen);
      break;
  }
}
