// server/runtime-registry.ts — the live-event hub. Tracks connected SSE clients, bridges
// adapter-originated events to them, assigns each a monotonic id, and keeps a bounded replay buffer
// so a client reconnecting with Last-Event-ID resumes without gaps or duplicates.
import type { ServerEvent, PiAdapter } from "../shared/protocol.js";
import { publicAdapterEvent } from "./public-projection.js";

export interface SseClient {
  id: string;
  /** Deliver an event frame with its monotonic id (for `id:` SSE lines / Last-Event-ID replay). */
  send: (eventId: number, event: ServerEvent) => void;
}

const REPLAY_BUFFER = 512; // recent events retained for reconnect replay

export class RuntimeRegistry {
  private clients = new Map<string, SseClient>();
  private unsubscribeAdapter: (() => void) | null = null;
  private nextId = 1;
  private buffer: Array<{ id: number; event: ServerEvent }> = [];

  constructor(private readonly adapter: PiAdapter) {
    // Production adapters enforce repository policy before invoking subscribers. This callback records
    // only that already-authorized stream; server-originated broadcasts are independently checked below.
    this.unsubscribeAdapter = adapter.subscribe((e) => this.broadcastTrusted(publicAdapterEvent(e)));
  }

  /**
   * Register a client. If `lastEventId` is provided and still within the buffer, replay everything
   * after it; otherwise the caller is expected to have sent a fresh snapshot (resnapshot path).
   */
  add(client: SseClient, lastEventId?: number): () => void {
    this.clients.set(client.id, client);
    if (lastEventId != null && this.buffer.length && lastEventId >= this.buffer[0]!.id - 1) {
      for (const b of this.buffer) if (b.id > lastEventId) client.send(b.id, b.event);
    } else {
      client.send(this.record({ type: "hello", now: Date.now() }), { type: "hello", now: Date.now() });
    }
    return () => this.clients.delete(client.id);
  }

  private record(event: ServerEvent): number {
    const id = this.nextId++;
    this.buffer.push({ id, event });
    if (this.buffer.length > REPLAY_BUFFER) this.buffer.shift();
    return id;
  }

  private broadcastTrusted(event: ServerEvent, replay = true): void {
    const id = replay ? this.record(event) : this.nextId++;
    for (const c of this.clients.values()) {
      try { c.send(id, event); }
      catch { this.clients.delete(c.id); }
    }
  }

  private async authorized(event: ServerEvent): Promise<boolean> {
    if (event.type === "hello") return true;
    const id = event.type === "chat.updated" ? event.chat.id : event.chatId;
    return (await this.adapter.listChats()).some((chat) => chat.id === id);
  }

  async broadcast(event: ServerEvent): Promise<void> {
    if (await this.authorized(event)) this.broadcastTrusted(event);
  }

  /** Ephemeral state reaches live clients but is intentionally absent from reconnect replay. */
  async broadcastEphemeral(event: Extract<ServerEvent, { type: "chat.presence" }>): Promise<void> {
    if (await this.authorized(event)) this.broadcastTrusted(event, false);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    this.unsubscribeAdapter?.();
    this.clients.clear();
    this.buffer = [];
  }
}
