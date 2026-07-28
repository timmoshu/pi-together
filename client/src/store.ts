// client/src/store.ts — the dashboard's live state: one authoritative SSE connection, one
// selected-chat presence stream, the chat list, and the selected timeline. Streaming deltas are
// batched into a ref and flushed on rAF so a token
// stream doesn't rerender the whole page per character.
//
// Reconciliation model (so reconnects never duplicate content):
//   - FINALIZED items (user/agent/system/tool turns, tool cards, notices) are appended in arrival
//     order and de-duplicated by a stable id — re-applying a replayed event is a no-op.
//   - The in-progress assistant text/thinking is a TRANSIENT "live" preview, cleared by msg.end /
//     run settle, because the finalized agent turn arrives separately via chat.turn.
//   - On SSE reconnect we resnapshot the selected chat (authoritative messages + persisted traces)
//     rather than trust non-idempotent delta replay.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatSummary, ServerEvent, ToolMode } from "../../shared/protocol";
import * as api from "./api";
import { applyServerEvent, controlLossNotice, detailToTimeline, upsertChat as upsertChatState } from "./store-events";
import { LEASE_HEARTBEAT_MS, mergeClientLease, shouldHeartbeat } from "./lease-heartbeat";
import type { AppState } from "./store-types";
import { getViewerId } from "./viewer-identity";
export type { AppState, Connection, ExtRequest, Live, SelectedState, TimelineItem, ToolCard } from "./store-types";
export function useChatApp() {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [presenceChatId, setPresenceChatId] = useState<string | null>(null);
  const state = useRef<AppState>({
    boot: null,
    connection: "connecting",
    chats: [],
    models: [],
    workspaceDiscoveryTruncated: false,
    presence: {},
    selected: null,
    error: null,
    pending: null,
    controlNotice: null,
  });

  // rAF-batched render: mutate state.current, call schedule(), render coalesces.
  const dirty = useRef(false);
  const raf = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (dirty.current) return;
    dirty.current = true;
    raf.current = requestAnimationFrame(() => {
      dirty.current = false;
      raf.current = null;
      forceRender();
    });
  }, []);

  const seen = useRef<Set<string>>(new Set()); // finalized-item ids for the selected chat

  const upsertChat = useCallback((chat: ChatSummary) => upsertChatState(state.current, chat), []);

  const onEvent = useCallback((event: ServerEvent) => {
    applyServerEvent(state.current, event, seen.current);
    schedule();
  }, [schedule]);

  // ---- SSE connection ----
  const resnapshot = useCallback(async () => {
    try {
      const boot = await api.getBootstrap();
      state.current.boot = boot;
      state.current.chats = boot.chats.map((chat) => {
        const previous = state.current.chats.find((candidate) => candidate.id === chat.id);
        return previous ? { ...chat, lease: mergeClientLease(previous.lease, chat.lease) } : chat;
      });
      if (boot.models.length) state.current.models = boot.models;
      if (!state.current.models.length) {
        void api.getModels()
          .then((models) => {
            state.current.models = models;
            schedule();
          })
          .catch(() => undefined);
      }
      const selId = state.current.selected?.id;
      if (selId) {
        const d = await api.getChat(selId);
        const timeline = detailToTimeline(d);
        seen.current = new Set(timeline.map((item) => item.id));
        const previousLease = state.current.selected?.summary.lease ?? null;
        state.current.controlNotice = controlLossNotice(
          previousLease, d.lease, boot.principal, selId, state.current.controlNotice,
        );
        if (d.lease?.isHolder) state.current.controlNotice = null;
        state.current.selected = {
          id: selId,
          summary: d,
          config: d.config ?? null,
          queue: d.queue ?? { steering: [], followUp: [] },
          runState: d.runState ?? "idle",
          timeline,
          live: { itemId: null, assistant: "", thinking: "", active: false },
          ext: d.pendingExtension ?? null,
          leaseHistory: d.leaseHistory ?? [],
        };
        upsertChat(d);
      }
      schedule();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, [schedule, upsertChat]);

  useEffect(() => { void resnapshot(); }, [resnapshot]);

  useEffect(() => {
    let es: EventSource | null = null;
    let erroredOnce = false;
    let closed = false;
    let connectionRevision = 0;

    const connect = () => {
      es = new EventSource("/events");
      es.onopen = () => {
        const reconnected = erroredOnce;
        const revision = ++connectionRevision;
        erroredOnce = false;
        if (!reconnected) {
          state.current.connection = "connected";
          schedule();
          return;
        }

        // Keep the chat frozen until its authoritative snapshot has caught up with the restored
        // event stream. A later stream error/reopen invalidates this completion via the revision.
        state.current.connection = "reattaching";
        schedule();
        void resnapshot().then((attached) => {
          if (!attached || closed || revision !== connectionRevision) return;
          state.current.connection = "connected";
          schedule();
        });
      };
      es.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data) as ServerEvent);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        erroredOnce = true;
        connectionRevision++;
        state.current.connection = "reconnecting";
        schedule();
        // EventSource auto-reconnects; nothing else to do.
      };
    };
    connect();

    return () => {
      closed = true;
      if (raf.current) cancelAnimationFrame(raf.current);
      es?.close();
    };
  }, [onEvent, resnapshot, schedule]);

  useEffect(() => {
    if (!presenceChatId) return;
    let closed = false;
    let stream: EventSource | null = null;
    void getViewerId().then((viewer) => {
      if (closed) return;
      const query = `chatId=${encodeURIComponent(presenceChatId)}&viewer=${encodeURIComponent(viewer)}&presenceOnly=1`;
      stream = new EventSource(`/events?${query}`);
      stream.onmessage = (message) => {
        try { onEvent(JSON.parse(message.data) as ServerEvent); }
        catch { /* ignore malformed presence frame */ }
      };
    });
    return () => {
      closed = true;
      stream?.close();
    };
  }, [onEvent, presenceChatId]);

  useEffect(() => {
    const heartbeat = async () => {
      const selected = state.current.selected;
      if (!selected || !shouldHeartbeat({
        visibility: document.visibilityState,
        connection: state.current.connection,
        isHolder: selected.summary.lease?.isHolder === true,
      })) return;
      try {
        const renewed = await api.heartbeatChat(selected.id);
        if (state.current.selected?.id !== selected.id) return;
        state.current.selected.summary = { ...state.current.selected.summary, lease: renewed };
        state.current.chats = state.current.chats.map((chat) =>
          chat.id === selected.id ? { ...chat, lease: renewed } : chat,
        );
        schedule();
      } catch {
        // Reconcile a takeover/expiry response without surfacing background network noise as an action error.
        await resnapshot();
      }
    };
    const timer = window.setInterval(() => void heartbeat(), LEASE_HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resnapshot, schedule]);

  // ---- actions ----
  const select = useCallback(
    async (id: string, showActiveLoading = true) => {
      if (state.current.controlNotice?.chatId !== id) state.current.controlNotice = null;
      const summary = state.current.chats.find((chat) => chat.id === id);
      const loading = !!(showActiveLoading && summary?.origin === "web" && summary.live && summary.status !== "idle");
      if (loading) {
        state.current.pending = summary.status === "running" ? "Attaching to running session…" : "Attaching to active session…";
        schedule();
      }
      try {
        const d = await api.getChat(id);
        const timeline = detailToTimeline(d);
        seen.current = new Set(timeline.map((item) => item.id));
        if (d.lease?.isHolder) state.current.controlNotice = null;
        state.current.selected = {
          id,
          summary: d,
          config: d.config ?? null,
          queue: d.queue ?? { steering: [], followUp: [] },
          runState: d.runState ?? "idle",
          timeline,
          live: { itemId: null, assistant: "", thinking: "", active: false },
          ext: d.pendingExtension ?? null,
          leaseHistory: d.leaseHistory ?? [],
        };
        setPresenceChatId(id);
        schedule();
      } catch (e) {
        setError(String(e));
      } finally {
        if (loading) {
          state.current.pending = null;
          schedule();
        }
      }
    },
    [schedule],
  );

  const withError = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        setError(null);
        await fn();
        return true;
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 409) {
          await resnapshot();
          setError("Control changed before that action completed. The current controller state is now shown.");
        } else {
          setError(e instanceof api.ApiError ? e.message : String(e));
        }
        return false;
      }
    },
    [resnapshot],
  );

  // Freeze the chat pane with a labelled overlay while a slow op (attach / switch model / change
  // tools) is in flight — these spawn or restart a `pi --mode rpc` process and take a moment.
  const heavy = useCallback(
    (label: string, fn: () => Promise<unknown>) =>
      withError(async () => {
        state.current.pending = label;
        schedule();
        try {
          await fn();
        } finally {
          state.current.pending = null;
          schedule();
        }
      }),
    [schedule, withError],
  );

  const refreshWorkspaces = useCallback(
    () => heavy("Refreshing repositories…", async () => {
      const refreshed = await api.refreshWorkspaces();
      if (state.current.boot) state.current.boot = {
        ...state.current.boot,
        chats: refreshed.chats,
        catalog: refreshed.catalog,
        workspaces: refreshed.workspaces,
      };
      state.current.chats = refreshed.chats;
      state.current.workspaceDiscoveryTruncated = refreshed.truncated;
      if (state.current.selected && !refreshed.chats.some((chat) => chat.id === state.current.selected!.id)) {
        state.current.selected = null;
        setPresenceChatId(null);
        seen.current.clear();
      }
      schedule();
    }),
    [heavy, schedule],
  );

  const create = useCallback(
    (workspaceRoot: string, name?: string) =>
      heavy("Starting session…", async () => {
        const { chat, models } = await api.createChat(workspaceRoot, name);
        state.current.models = models;
        upsertChat(chat);
        await select(chat.id, false);
      }),
    [heavy, select, upsertChat],
  );

  const resume = useCallback(
    (id: string) =>
      heavy("Taking control…", async () => {
        // Resume is an explicit user action, so it may transfer the browser lease from another
        // device. Automatic control acquisition (ensureControl below) remains non-takeover.
        await api.resumeChat(id, true);
        await select(id, false);
      }),
    [heavy, select],
  );

  // Controlling a chat needs its single-controller lease. Selecting a chat is a cheap read-only view;
  // the first control action transparently acquires the lease (resume), surfacing 409 if another
  // viewer already holds it.
  const ensureControl = useCallback(async () => {
    const selected = state.current.selected!;
    if (selected.summary.lease?.isHolder === true) return;
    const resumed = await api.resumeChat(selected.id);
    upsertChat(resumed);
    if (state.current.selected?.id === selected.id) {
      state.current.selected.summary = { ...state.current.selected.summary, ...resumed };
    }
    schedule();
  }, [schedule, upsertChat]);

  const send = useCallback(
    (text: string, mode: "normal" | "steer" | "followUp") => {
      const sel = state.current.selected!;
      const cold = !sel.summary.live; // first send on a cold chat spawns a runtime — freeze briefly
      const run = async () => {
        await ensureControl();
        await api.sendMessage(state.current.selected!.id, text, mode);
      };
      return cold ? heavy("Attaching runtime…", run) : withError(run);
    },
    [ensureControl, heavy, withError],
  );
  const abort = useCallback(() => withError(async () => {
    await ensureControl();
    const selected = state.current.selected!;
    selected.runState = "stopping";
    schedule();
    try { await api.abortChat(selected.id); }
    catch (error) { await resnapshot(); throw error; }
  }), [ensureControl, resnapshot, schedule, withError]);
  const rename = useCallback((name: string) => withError(async () => {
    await ensureControl();
    await api.renameChat(state.current.selected!.id, name);
  }), [ensureControl, withError]);
  const compact = useCallback(() => withError(async () => {
    await ensureControl();
    await api.compactChat(state.current.selected!.id);
  }), [ensureControl, withError]);
  const close = useCallback(
    () =>
      heavy("Closing session…", async () => {
        await ensureControl();
        const chat = await api.closeChat(state.current.selected!.id);
        upsertChat(chat);
        const selected = state.current.selected;
        if (selected?.id === chat.id) {
          selected.summary = chat;
          selected.config = null;
          selected.queue = { steering: [], followUp: [] };
          selected.runState = "idle";
          selected.live = { itemId: null, assistant: "", thinking: "", active: false };
          selected.ext = null;
        }
      }),
    [ensureControl, heavy, upsertChat],
  );
  const applyConfig = useCallback(
    (label: string, change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode }) =>
      heavy(label, async () => {
        await ensureControl();
        const cfg = await api.setConfig(state.current.selected!.id, change);
        if (state.current.selected) state.current.selected.config = cfg;
        schedule();
      }),
    [ensureControl, heavy, schedule],
  );
  const setModel = useCallback(
    (provider: string, id: string) => applyConfig("Switching model…", { model: { provider, id } }),
    [applyConfig],
  );
  const setThinking = useCallback((thinking: string) => applyConfig("Changing thinking level…", { thinking }), [applyConfig]);
  const setToolMode = useCallback(
    (toolMode: ToolMode) => applyConfig(toolMode === "full" ? "Enabling full tools…" : "Switching to read-only…", { toolMode }),
    [applyConfig],
  );
  const respondExtension = useCallback(
    (reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
      withError(async () => {
        const sel = state.current.selected;
        if (!sel?.ext) return;
        const chatId = sel.id;
        const requestId = sel.ext.requestId;
        await ensureControl();
        await api.respondExtension(chatId, requestId, reply);
        const current = state.current.selected;
        if (current?.id === chatId && current.ext?.requestId === requestId) current.ext = null;
        schedule();
      }),
    [ensureControl, schedule, withError],
  );

  return {
    state: state.current,
    error,
    clearError: () => setError(null),
    actions: {
      select,
      create,
      refreshWorkspaces,
      resume,
      send,
      abort,
      rename,
      compact,
      close,
      setModel,
      setThinking,
      setToolMode,
      respondExtension,
      dismissControlNotice: () => { state.current.controlNotice = null; schedule(); },
    },
  };
}
