// tests/helpers.ts — spin up the real app wired to the FakeAdapter on an ephemeral port.
import type { AddressInfo } from "node:net";
import { createApp, type App, type AppOptions } from "../server/app.js";
import { FakeAdapter } from "../pi-adapter/fake.js";
import type { SecurityConfig } from "../server/security.js";

export interface TestApp {
  app: App;
  base: string;
  adapter: FakeAdapter;
  close: () => Promise<void>;
}

export async function startTestApp(opts: Partial<AppOptions> = {}): Promise<TestApp> {
  const adapter = (opts.adapter as FakeAdapter) ?? new FakeAdapter();
  const security: SecurityConfig = opts.security ?? {
    mode: "test",
    principal: { provider: "github", subject: "1234567", login: "octocat" },
  };
  const app = createApp({
    adapter,
    security,
    origin: "http://test.local",
    sharedRepositoryFolders: ["/home/example/projects"],
    ...opts,
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, adapter, close: app.close };
}

export async function jsonReq<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}

export interface SseFrame {
  id: number | null;
  event: Record<string, unknown>;
}

/** Minimal SSE client for tests: streams /events, parses id/data frames. */
export async function openSse(
  base: string,
  opts: { lastEventId?: number; chatId?: string; viewerId?: string; presenceOnly?: boolean; headers?: Record<string, string> } = {},
): Promise<{
  frames: SseFrame[];
  waitFor: (pred: (f: SseFrame) => boolean, timeoutMs?: number) => Promise<SseFrame>;
  close: () => void;
}> {
  const ac = new AbortController();
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.lastEventId != null) headers["last-event-id"] = String(opts.lastEventId);
  const query = new URLSearchParams();
  if (opts.chatId) query.set("chatId", opts.chatId);
  if (opts.viewerId) query.set("viewer", opts.viewerId);
  if (opts.presenceOnly) query.set("presenceOnly", "1");
  const res = await fetch(`${base}/events${query.size ? `?${query}` : ""}`, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const waiters: Array<{ pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];
  let buf = "";
  let curId: number | null = null;

  const emit = (event: Record<string, unknown>) => {
    const frame: SseFrame = { id: curId, event };
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(frame)) waiters.splice(i, 1)[0]!.resolve(frame);
    }
  };

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          curId = null;
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) curId = Number(line.slice(3).trim());
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) emit(JSON.parse(data) as Record<string, unknown>);
        }
      }
    } catch {
      /* aborted */
    }
  })();

  return {
    frames,
    waitFor: (pred, timeoutMs = 3000) =>
      new Promise<SseFrame>((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error("sse waitFor timed out")), timeoutMs);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
    close: () => ac.abort(),
  };
}
