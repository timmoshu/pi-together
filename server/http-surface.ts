import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { ServerEvent } from "../shared/protocol.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

// Native EventSource defaults to a multi-second retry. This service is local/private and restarts
// quickly, so advertise a short retry without replacing the browser's well-tested SSE machinery.
const SSE_RETRY_MS = 500;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "));
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw Object.assign(new Error("payload too large"), { httpStatus: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface EventStreamLifecycle {
  opened(connectionId: string): (() => void) | void;
  heartbeat?(connectionId: string): void;
  accept?(event: ServerEvent): boolean;
}

export function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  registry: RuntimeRegistry,
  lifecycle?: EventStreamLifecycle,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.write(`retry: ${SSE_RETRY_MS}\n\n`);
  const id = `sse_${randomUUID()}`;
  const send = (eventId: number, event: ServerEvent) =>
    lifecycle?.accept && !lifecycle.accept(event)
      ? true
      : response.write(`id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  const rawLastId = request.headers["last-event-id"];
  const lastId = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
  const replayFrom = lastId != null && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
  const unregister = registry.add({ id, send }, replayFrom);
  const leavePresence = lifecycle?.opened(id);
  const heartbeat = setInterval(() => {
    lifecycle?.heartbeat?.(id);
    response.write(": ping\n\n");
  }, 20_000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    leavePresence?.();
    unregister();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);
}

export async function serveStatic(response: ServerResponse, url: URL, clientDirectory?: string): Promise<void> {
  if (!clientDirectory) {
    response.writeHead(404).end("not found");
    return;
  }
  const relativePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(clientDirectory, relativePath);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    await stat(file);
  } catch {
    file = join(clientDirectory, "index.html");
  }
  try {
    await stat(file);
  } catch {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}
