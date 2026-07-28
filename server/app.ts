// server/app.ts — HTTP surface: JSON API + SSE `/events`, behind the security gate, serving the
// built client for everything else. Returns a non-listening http.Server so tests can bind an
// ephemeral port and index.ts can bind the configured one.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BootstrapPayload, PiAdapter, WorkspaceRefreshPayload } from "../shared/protocol.js";
import {
  CloseReq,
  ConfigReq,
  CreateChatReq,
  ExtensionUiResponseReq,
  OpenWorkspaceReq,
  RenameReq,
  ResumeReq,
  SendReq,
  ViewerId,
  ViewerReq,
} from "../shared/protocol.js";
import { authorize, authorizeOrigin, type AuthenticatedPrincipal, type SecurityConfig } from "./security.js";
import { CollaborationLeases } from "./collaboration-leases.js";
import { publicChatDetail, publicChatSummary } from "./public-projection.js";
import type { LeaseManager } from "./lease.js";
import { applySecurityHeaders, handleEvents, readJson, sendJson, serveStatic } from "./http-surface.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { buildCatalog } from "./catalog.js";
import { SessionPresence } from "./presence.js";

export interface RequestContext {
  principal: AuthenticatedPrincipal;
}

export interface AppOptions {
  adapter: PiAdapter;
  security: SecurityConfig;
  origin: string;
  sharedRepositoryFolders: string[];
  clientDir?: string;
  /** Test/observability hook receives identity only, never security configuration. */
  onRequestContext?: (context: RequestContext) => void;
  /** Called only after an authenticated browser bootstrap reaches the normal API route. */
  onAuthenticatedBootstrap?: (principal: AuthenticatedPrincipal) => void;
  /** Deterministic test hooks; production uses the five-minute/30-second policy. */
  leaseTtlMs?: number;
  leaseReaperMs?: number;
  presenceStaleMs?: number;
  presenceReaperMs?: number;
}

export interface App {
  server: Server;
  registry: RuntimeRegistry;
  lease: LeaseManager;
  presence: SessionPresence;
  close: () => Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const { adapter, security, origin, clientDir } = opts;
  const registry = new RuntimeRegistry(adapter);
  const collaboration = new CollaborationLeases(adapter, registry, opts.leaseTtlMs, opts.leaseReaperMs);
  const presence = new SessionPresence(registry, { staleAfterMs: opts.presenceStaleMs, reapIntervalMs: opts.presenceReaperMs });
  const lease = collaboration.lease;
  const holder = (context: RequestContext, viewerId: string) => collaboration.holder(context, viewerId);
  const broadcastLease = (chatId: string) => collaboration.broadcast(chatId);
  const requireLease = (chatId: string, viewerId: string, context: RequestContext) =>
    collaboration.requireMutation(chatId, viewerId, context);
  const controller = collaboration.controller.bind(collaboration);
  const sameHolder = collaboration.sameHolder.bind(collaboration);
  const latestDurableController = collaboration.latestDurableController.bind(collaboration);
  const leaseEvent = collaboration.event.bind(collaboration);
  const persistLease = collaboration.persist.bind(collaboration);
  const flushExpiries = collaboration.flushExpiries.bind(collaboration);
  let refreshInFlight: Promise<WorkspaceRefreshPayload> | null = null;
  let lastRefresh: { at: number; value: WorkspaceRefreshPayload } | null = null;
  const refreshCatalog = (): Promise<WorkspaceRefreshPayload> => {
    if (refreshInFlight) return refreshInFlight;
    if (lastRefresh && Date.now() - lastRefresh.at < 750) return Promise.resolve(lastRefresh.value);
    refreshInFlight = (async () => {
      const status = await adapter.refreshWorkspaces?.() ?? { truncated: false };
      const [chats, catalog] = await Promise.all([adapter.listChats(), buildCatalog(adapter)]);
      const value = {
        chats: chats.map((chat) => ({ ...publicChatSummary(chat), lease: lease.get(chat.id) })),
        catalog: catalog.catalog,
        workspaces: catalog.workspaces,
        truncated: status.truncated,
      };
      lastRefresh = { at: Date.now(), value };
      return value;
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  };

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    context: RequestContext,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Resolve chat IDs through the policy-filtered summary set before parsing bodies, touching leases,
    // loading transcript detail, or invoking any adapter mutation. Unknown and unauthorized are identical.
    const guardedChat = path.match(/^\/api\/chats\/([^/]+)(?:\/|$)/);
    if (guardedChat && !(path === "/api/chats/resume" && method === "POST")) {
      const id = decodeURIComponent(guardedChat[1]!);
      if (!(await adapter.listChats()).some((chat) => chat.id === id)) {
        sendJson(res, 404, { error: "no such chat" });
        return true;
      }
    }

    if (path === "/api/health" && method === "GET") {
      sendJson(res, 200, { ok: true, adapter: adapter.kind });
      return true;
    }

    if (path === "/api/bootstrap" && method === "GET") {
      opts.onAuthenticatedBootstrap?.(context.principal);
      const includeModels = url.searchParams.get("models") !== "0";
      const [chats, cat, models] = await Promise.all([
        adapter.listChats(),
        buildCatalog(adapter),
        includeModels ? adapter.models().catch(() => []) : Promise.resolve([]),
      ]);
      const withLeases = chats.map((c) => ({ ...publicChatSummary(c), lease: lease.get(c.id) }));
      const payload: BootstrapPayload = {
        owner: context.principal.login,
        principal: context.principal,
        origin,
        adapter: adapter.kind,
        chats: withLeases,
        catalog: cat.catalog,
        workspaces: cat.workspaces,
        models,
      };
      sendJson(res, 200, payload);
      return true;
    }

    if (path === "/api/models" && method === "GET") {
      sendJson(res, 200, { models: await adapter.models().catch(() => []) });
      return true;
    }

    if (path === "/api/chats" && method === "GET") {
      const chats = (await adapter.listChats()).map((c) => ({ ...publicChatSummary(c), lease: lease.get(c.id) }));
      sendJson(res, 200, { chats });
      return true;
    }

    if (path === "/api/chats" && method === "POST") {
      const body = CreateChatReq.parse(await readJson(req));
      // Session creation is the explicit refresh boundary for credentials/models changed by `pi /login`
      // while this long-lived server process was already running.
      const models = await adapter.models(true).catch(() => []);
      const summary = publicChatSummary(await adapter.createChat(body.workspaceRoot, body.name));
      const creator = holder(context, body.viewer);
      const next = controller(creator);
      const acquisition = await lease.runAcquisition(summary.id, creator, false, async () => {
        if (next) await persistLease(summary.id, leaseEvent("acquired", undefined, next));
        return summary;
      });
      if (!acquisition) throw new Error("adapter returned a chat ID with an existing controller");
      await registry.broadcast({ type: "chat.updated", chat: { ...summary, lease: lease.get(summary.id) } });
      sendJson(res, 201, { chat: { ...summary, lease: acquisition.lease }, models });
      return true;
    }

    if (path === "/api/chats/resume" && method === "POST") {
      const body = ResumeReq.parse(await readJson(req));
      if (!await adapter.getChat(body.chatId)) {
        sendJson(res, 404, { error: "no such chat" });
        return true;
      }
      // Passive control attempts never steal a lease. Only an explicit Resume/Take over action from
      // the UI sets takeover=true, which transfers this server-side runtime between browser devices.
      const nextHolder = holder(context, body.viewer);
      const next = controller(nextHolder);
      const acquisition = await lease.runAcquisition(
        body.chatId,
        nextHolder,
        body.takeover,
        async (actualPrevious) => {
          await flushExpiries(body.chatId);
          const durable = await adapter.getChat(body.chatId);
          if (!durable) throw new Error("chat disappeared while acquiring control");
          const previous = controller(actualPrevious);
          const recovered = latestDurableController(durable.leaseHistory);
          const transition = sameHolder(actualPrevious, nextHolder)
            ? undefined
            : previous
              ? leaseEvent("takenOver", previous, next)
              : recovered
                ? leaseEvent("recovered", recovered, next)
                : leaseEvent("acquired", undefined, next);
          const resumed = publicChatSummary(await adapter.resume(body.chatId));
          if (transition && next) await persistLease(body.chatId, transition);
          return resumed;
        },
      );
      if (!acquisition) {
        sendJson(res, 409, { error: "chat is leased by another viewer", lease: lease.get(body.chatId) });
        return true;
      }
      await broadcastLease(body.chatId);
      sendJson(res, 200, { chat: { ...acquisition.value, lease: acquisition.lease } });
      return true;
    }

    // config change (idle-only enforced by the adapter) — PATCH
    const cfgOp = path.match(/^\/api\/chats\/([^/]+)\/config$/);
    if (cfgOp && method === "PATCH") {
      const id = decodeURIComponent(cfgOp[1]!);
      const body = ConfigReq.parse(await readJson(req));
      await requireLease(id, body.viewer, context);
      const config = await adapter.setConfig(id, {
        model: body.model,
        thinking: body.thinking,
        toolMode: body.toolMode,
      });
      sendJson(res, 200, { config });
      return true;
    }

    // send a prompt / steer / follow-up — accepted (202) then streamed over SSE
    const sendOp = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (sendOp && method === "POST") {
      const id = decodeURIComponent(sendOp[1]!);
      const body = SendReq.parse(await readJson(req));
      await requireLease(id, body.viewer, context);
      const result = await adapter.send(
        id,
        body.text,
        body.mode,
        context.principal.provider === "github"
          ? {
              requestId: `req_${randomUUID()}`,
              actor: context.principal,
              viewerId: body.viewer,
            }
          : undefined,
      );
      sendJson(res, 202, { accepted: result.accepted, queued: result.queued });
      return true;
    }

    // abort the current run
    const abortOp = path.match(/^\/api\/chats\/([^/]+)\/abort$/);
    if (abortOp && method === "POST") {
      const id = decodeURIComponent(abortOp[1]!);
      const body = ViewerReq.parse(await readJson(req));
      await requireLease(id, body.viewer, context);
      await adapter.abort(id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const heartbeatOp = path.match(/^\/api\/chats\/([^/]+)\/heartbeat$/);
    if (heartbeatOp && method === "POST") {
      const id = decodeURIComponent(heartbeatOp[1]!);
      const body = ViewerReq.parse(await readJson(req));
      const renewed = lease.heartbeat(id, holder(context, body.viewer));
      if (!renewed) {
        sendJson(res, 409, { error: "chat is controlled by another viewer", lease: lease.get(id) });
        return true;
      }
      await broadcastLease(id);
      sendJson(res, 200, { lease: renewed });
      return true;
    }

    const chatOp = path.match(/^\/api\/chats\/([^/]+)\/(compact|close|rename|extension-ui-response)$/);
    if (chatOp && method === "POST") {
      const id = decodeURIComponent(chatOp[1]!);
      const op = chatOp[2]!;
      if (op === "close") {
        const body = CloseReq.parse(await readJson(req));
        await requireLease(id, body.viewer, context);
        const current = holder(context, body.viewer);
        const previous = controller(current);
        if (previous) await persistLease(id, leaseEvent("released", previous));
        lease.release(id, current);
        await broadcastLease(id);
        const chat = publicChatSummary(await adapter.detach(id));
        await registry.broadcast({ type: "chat.updated", chat: { ...chat, lease: null } });
        sendJson(res, 200, { chat: { ...chat, lease: null } });
        return true;
      }
      if (op === "rename") {
        const { name, viewer } = RenameReq.parse(await readJson(req));
        await requireLease(id, viewer, context);
        const chat = publicChatSummary(await adapter.rename(id, name));
        await registry.broadcast({ type: "chat.updated", chat: { ...chat, lease: lease.get(id) } });
        sendJson(res, 200, { chat: { ...chat, lease: lease.get(id, holder(context, viewer)) } });
        return true;
      }
      if (op === "compact") {
        const { viewer } = ViewerReq.parse(await readJson(req));
        await requireLease(id, viewer, context);
        const chat = publicChatSummary(await adapter.compact(id));
        await registry.broadcast({ type: "chat.updated", chat: { ...chat, lease: lease.get(id) } });
        sendJson(res, 200, { chat: { ...chat, lease: lease.get(id, holder(context, viewer)) } });
        return true;
      }
      // extension-ui-response
      const reply = ExtensionUiResponseReq.parse(await readJson(req));
      await requireLease(id, reply.viewer, context);
      const { viewer: _viewer, ...extensionReply } = reply;
      await adapter.extensionUiResponse(id, reply.requestId, extensionReply);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const chatGet = path.match(/^\/api\/chats\/([^/]+)$/);
    if (chatGet && method === "GET") {
      const id = decodeURIComponent(chatGet[1]!);
      const detail = await adapter.getChat(id);
      if (!detail) {
        sendJson(res, 404, { error: "no such chat" });
        return true;
      }
      const viewers = url.searchParams.getAll("viewer");
      if (viewers.length > 1) throw Object.assign(new Error("duplicate viewer"), { httpStatus: 400 });
      const requester = viewers.length === 1 ? holder(context, ViewerId.parse(viewers[0])) : undefined;
      sendJson(res, 200, { chat: { ...publicChatDetail(detail), lease: lease.get(id, requester) } });
      return true;
    }

    if (path === "/api/workspaces" || path === "/api/workspaces/") {
      if (method === "GET") {
        sendJson(res, 200, { workspaces: await adapter.listWorkspaces() });
        return true;
      }
    }
    if (path === "/api/workspaces/refresh" && method === "POST") {
      sendJson(res, 200, await refreshCatalog());
      return true;
    }
    if (path === "/api/workspaces/open" && method === "POST") {
      const { root, viewer } = OpenWorkspaceReq.parse(await readJson(req));
      const summary = publicChatSummary(await adapter.openWorkspace(root));
      const creator = holder(context, viewer);
      const next = controller(creator);
      const acquisition = await lease.runAcquisition(summary.id, creator, false, async () => {
        if (next) await persistLease(summary.id, leaseEvent("acquired", undefined, next));
        return summary;
      });
      if (!acquisition) throw new Error("adapter returned a chat ID with an existing controller");
      await registry.broadcast({ type: "chat.updated", chat: { ...summary, lease: lease.get(summary.id) } });
      sendJson(res, 201, { chat: { ...summary, lease: acquisition.lease } });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        applySecurityHeaders(res);
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const gated = url.pathname.startsWith("/api/") || url.pathname === "/events";
        let context: RequestContext | undefined;
        if (gated) {
          const authz = authorize({
            headers: req.headers,
            rawHeaders: req.rawHeaders,
            remoteAddress: req.socket.remoteAddress,
          }, security);
          if (authz.status !== 200 || !authz.principal) {
            sendJson(res, authz.status, { error: authz.status === 401 ? "unauthorized" : "forbidden" });
            return;
          }
          const presenceSubscription = url.pathname === "/events" && url.searchParams.has("chatId");
          // Presence uses GET for EventSource compatibility but mutates ephemeral collaboration state,
          // so it receives the same exact-Origin gate as unsafe methods before validation or joining.
          if (security.mode === "reverse-proxy"
            && (presenceSubscription || !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET"))) {
            if (authorizeOrigin(req.headers, origin, req.rawHeaders) !== 200) {
              sendJson(res, 403, { error: "forbidden" });
              return;
            }
          }
          context = { principal: authz.principal };
          opts.onRequestContext?.(context);
        }
        if (url.pathname === "/events" && req.method === "GET") {
          const chatValues = url.searchParams.getAll("chatId");
          const viewerValues = url.searchParams.getAll("viewer");
          const presenceOnlyValues = url.searchParams.getAll("presenceOnly");
          if (chatValues.length > 1 || viewerValues.length > 1 || presenceOnlyValues.length > 1
            || (presenceOnlyValues.length === 1 && presenceOnlyValues[0] !== "1")
            || (chatValues.length === 1) !== (viewerValues.length === 1)
            || (presenceOnlyValues.length === 1 && chatValues.length !== 1)) {
            sendJson(res, 400, { error: "invalid presence subscription" });
            return;
          }
          if (!chatValues.length) return handleEvents(req, res, registry);
          const chatId = chatValues[0]!;
          if (!chatId || chatId.length > 256 || /[\u0000-\u001f\u007f]/.test(chatId)) {
            sendJson(res, 400, { error: "invalid presence subscription" });
            return;
          }
          const viewerId = ViewerId.parse(viewerValues[0]);
          if (!(await adapter.listChats()).some((chat) => chat.id === chatId)) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          const principal = context!.principal;
          return handleEvents(req, res, registry, {
            opened: (connectionId) => presence.join({ chatId, connectionId, principal, viewerId }),
            heartbeat: (connectionId) => {
              if (!presence.touch(connectionId)) presence.join({ chatId, connectionId, principal, viewerId });
            },
            ...(presenceOnlyValues.length ? { accept: (event: { type: string }) => event.type === "chat.presence" } : {}),
          });
        }
        if (url.pathname.startsWith("/api/")) {
          await handleApi(req, res, url, context!);
          return;
        }
        await serveStatic(res, url, clientDir);
      } catch (err) {
        const typed = err as { httpStatus?: number; name?: string; responseBody?: unknown; message: string };
        const status = typed.httpStatus ?? (typed.name === "ZodError" ? 400 : 500);
        if (!res.headersSent) sendJson(res, status, typed.responseBody ?? { error: typed.message });
        else res.end();
      }
    })();
  });

  const close = async () => {
    presence.close();
    await collaboration.close();
    registry.close();
    await adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, registry, lease, presence, close };
}
