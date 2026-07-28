import { randomUUID } from "node:crypto";
import type { DurableLeaseEvent, PiAdapter } from "../shared/protocol.js";
import { LeaseManager, type LeaseHolder } from "./lease.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { publicLeaseHistoryEvent } from "./public-projection.js";
import type { AuthenticatedPrincipal } from "./security.js";

interface LeaseRequestContext { principal: AuthenticatedPrincipal }

export class CollaborationLeases {
  readonly lease: LeaseManager;
  private readonly pendingExpiries = new Map<string, DurableLeaseEvent>();
  private expiryFlush: Promise<void> = Promise.resolve();
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private readonly adapter: PiAdapter,
    private readonly registry: RuntimeRegistry,
    leaseTtlMs?: number,
    leaseReaperMs = 30_000,
  ) {
    this.lease = new LeaseManager(leaseTtlMs);
    this.reaper = setInterval(() => void this.flushExpiries(), leaseReaperMs);
    this.reaper.unref();
  }

  holder(context: LeaseRequestContext, viewerId: string): LeaseHolder {
    return { principal: context.principal, viewerId };
  }

  async broadcast(chatId: string): Promise<void> {
    if (!(await this.adapter.listChats()).some((chat) => chat.id === chatId)) return;
    await this.registry.broadcast({ type: "chat.lease", chatId, lease: this.lease.get(chatId) });
  }

  async requireMutation(chatId: string, viewerId: string, context: LeaseRequestContext): Promise<void> {
    if (!this.lease.authorizeMutation(chatId, this.holder(context, viewerId))) {
      throw Object.assign(new Error("chat is controlled by another viewer"), {
        httpStatus: 409,
        responseBody: { error: "chat is controlled by another viewer", lease: this.lease.get(chatId) },
      });
    }
    await this.broadcast(chatId);
  }

  controller(value: LeaseHolder | null): DurableLeaseEvent["next"] | undefined {
    if (!value || value.principal.provider !== "github") return undefined;
    return {
      actor: {
        provider: "github",
        subject: value.principal.subject,
        login: value.principal.login,
      },
      viewerId: value.viewerId,
    };
  }

  sameHolder(left: LeaseHolder | null, right: LeaseHolder): boolean {
    return !!left
      && left.principal.provider === right.principal.provider
      && left.principal.subject === right.principal.subject
      && left.viewerId === right.viewerId;
  }

  latestDurableController(history: DurableLeaseEvent[] | undefined): DurableLeaseEvent["next"] | undefined {
    let current: DurableLeaseEvent["next"] | undefined;
    for (const event of history ?? []) {
      current = event.event === "released" || event.event === "expired" ? undefined : event.next;
    }
    return current;
  }

  event(
    event: DurableLeaseEvent["event"],
    previous?: DurableLeaseEvent["previous"],
    next?: DurableLeaseEvent["next"],
    requestId = `lease_${randomUUID()}`,
  ): DurableLeaseEvent {
    return {
      requestId,
      event,
      occurredAt: new Date().toISOString(),
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
    };
  }

  async persist(chatId: string, event: DurableLeaseEvent): Promise<void> {
    await this.adapter.recordLeaseEvent(chatId, event);
    if ((await this.adapter.listChats()).some((chat) => chat.id === chatId)) {
      await this.registry.broadcast({ type: "lease.history", chatId, event: publicLeaseHistoryEvent(event) });
    }
  }

  flushExpiries(requiredChatId?: string): Promise<void> {
    const run = this.expiryFlush.then(async () => {
      for (const { chatId, previous } of this.lease.reapExpired()) {
        const prior = this.controller(previous);
        if (prior) this.pendingExpiries.set(chatId, this.event("expired", prior));
        await this.broadcast(chatId);
      }
      for (const [chatId, event] of this.pendingExpiries) {
        try {
          await this.persist(chatId, event);
          this.pendingExpiries.delete(chatId);
        } catch {
          // Keep the stable request ID for bounded retry; never recreate a live lock after expiry.
        }
      }
      if (requiredChatId && this.pendingExpiries.has(requiredChatId)) {
        throw new Error("expired lease history is not durable yet");
      }
    });
    this.expiryFlush = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    await this.expiryFlush;
  }
}
