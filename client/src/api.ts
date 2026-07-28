// client/src/api.ts — same-origin fetch helpers + the stable per-tab viewer id.
//
// The dashboard is served same-origin behind the generated authenticated proxy path, so the browser
// sends no backend credentials itself — principal authentication is applied at the reverse proxy. Requests are
// same-origin; we send no cross-origin headers.
import { getViewerId } from "./viewer-identity";
import type {
  BootstrapPayload,
  ChatConfig,
  ChatDetail,
  ChatSummary,
  ToolMode,
  WorkspaceRefreshPayload,
} from "../../shared/protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, (body && body.error) || `${path} → ${res.status}`);
  return body as T;
}

// Session metadata should not wait for Pi's comparatively slow model probe. Models hydrate through
// their own request immediately after the rail is available.
export const getBootstrap = () => api<BootstrapPayload>("/api/bootstrap?models=0");
export const getModels = () => api<{ models: BootstrapPayload["models"] }>("/api/models").then((r) => r.models);
export const refreshWorkspaces = () => api<WorkspaceRefreshPayload>("/api/workspaces/refresh", { method: "POST", body: "{}" });

export const getChat = async (id: string) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatDetail }>(`/api/chats/${encodeURIComponent(id)}?viewer=${encodeURIComponent(viewer)}`).then((r) => r.chat);
};

export const createChat = async (workspaceRoot: string, name?: string) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatDetail; models: BootstrapPayload["models"] }>("/api/chats", {
    method: "POST",
    body: JSON.stringify({ workspaceRoot, viewer, name }),
  });
};

export const resumeChat = async (chatId: string, takeover = false) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatDetail }>("/api/chats/resume", {
    method: "POST",
    body: JSON.stringify({ chatId, viewer, takeover }),
  }).then((r) => r.chat);
};

export const sendMessage = async (id: string, text: string, mode: "normal" | "steer" | "followUp") => {
  const viewer = await getViewerId();
  return api<{ accepted: boolean; queued: boolean }>(`/api/chats/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ viewer, text, mode }),
  });
};

export const abortChat = async (id: string) => {
  const viewer = await getViewerId();
  return api<{ ok: boolean }>(`/api/chats/${encodeURIComponent(id)}/abort`, {
    method: "POST",
    body: JSON.stringify({ viewer }),
  });
};

export const setConfig = async (
  id: string,
  change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode },
) => {
  const viewer = await getViewerId();
  return api<{ config: ChatConfig }>(`/api/chats/${encodeURIComponent(id)}/config`, {
    method: "PATCH",
    body: JSON.stringify({ viewer, ...change }),
  }).then((r) => r.config);
};

export const renameChat = async (id: string, name: string) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatSummary }>(`/api/chats/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    body: JSON.stringify({ viewer, name }),
  }).then((r) => r.chat);
};

export const compactChat = async (id: string) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatSummary }>(`/api/chats/${encodeURIComponent(id)}/compact`, {
    method: "POST",
    body: JSON.stringify({ viewer }),
  }).then((r) => r.chat);
};

export const heartbeatChat = async (id: string) => {
  const viewer = await getViewerId();
  return api<{ lease: ChatSummary["lease"] }>(`/api/chats/${encodeURIComponent(id)}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ viewer }),
  }).then((r) => r.lease);
};

export const closeChat = async (id: string) => {
  const viewer = await getViewerId();
  return api<{ chat: ChatSummary }>(`/api/chats/${encodeURIComponent(id)}/close`, {
    method: "POST",
    body: JSON.stringify({ viewer }),
  }).then((r) => r.chat);
};

export const respondExtension = async (
  id: string,
  requestId: string,
  reply: { value?: string; confirmed?: boolean; cancelled?: boolean },
) => {
  const viewer = await getViewerId();
  return api<{ ok: boolean }>(`/api/chats/${encodeURIComponent(id)}/extension-ui-response`, {
    method: "POST",
    body: JSON.stringify({ viewer, requestId, ...reply }),
  });
};
