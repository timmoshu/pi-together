// server/lease.ts — process-local, principal-aware single-controller leases.
import { randomUUID } from "node:crypto";
import type { LeaseInfo, PrincipalIdentity } from "../shared/protocol.js";

const DEFAULT_TTL_MS = 5 * 60_000;

interface LeaseRecord {
  leaseId: string;
  actor: PrincipalIdentity;
  viewerId: string;
  acquiredAt: number;
  expiresAt: number;
  revision: number;
  committed: boolean;
}

export interface LeaseHolder {
  principal: PrincipalIdentity;
  viewerId: string;
}

function samePrincipal(a: PrincipalIdentity, b: PrincipalIdentity): boolean {
  return a.provider === b.provider && a.subject === b.subject;
}

function sameHolder(record: LeaseRecord, holder: LeaseHolder): boolean {
  return samePrincipal(record.actor, holder.principal) && record.viewerId === holder.viewerId;
}

export class LeaseManager {
  private leases = new Map<string, LeaseRecord>();
  private recentlyExpired = new Map<string, LeaseHolder>();
  private revision = 0;

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("lease TTL must be a positive integer");
  }

  private live(chatId: string): LeaseRecord | null {
    const lease = this.leases.get(chatId);
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(chatId);
      this.recentlyExpired.set(chatId, { principal: { ...lease.actor }, viewerId: lease.viewerId });
      return null;
    }
    return lease;
  }

  private publicLease(record: LeaseRecord, requester?: LeaseHolder): LeaseInfo {
    return {
      leaseId: record.leaseId,
      actor: { ...record.actor },
      acquiredAt: record.acquiredAt,
      expiresAt: record.expiresAt,
      ...(record.committed && requester && sameHolder(record, requester) ? { isHolder: true } : {}),
    };
  }

  /** Server-only holder snapshot for durable transition records. */
  currentHolder(chatId: string): LeaseHolder | null {
    const record = this.live(chatId);
    return record ? { principal: { ...record.actor }, viewerId: record.viewerId } : null;
  }

  /** Return only client-safe state. Viewer IDs are never exposed. */
  get(chatId: string, requester?: LeaseHolder): LeaseInfo | null {
    const record = this.live(chatId);
    return record ? this.publicLease(record, requester) : null;
  }

  /** Acquire an unheld lease or renew the exact principal+viewer holder. */
  acquire(chatId: string, holder: LeaseHolder): LeaseInfo | null {
    const current = this.live(chatId);
    if (current && !sameHolder(current, holder)) return null;
    const now = this.now();
    const record: LeaseRecord = {
      leaseId: current?.leaseId ?? randomUUID(),
      actor: { ...holder.principal },
      viewerId: holder.viewerId,
      acquiredAt: current?.acquiredAt ?? now,
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
      committed: true,
    };
    this.leases.set(chatId, record);
    return this.publicLease(record, holder);
  }

  /** Renew only an existing exact holder; passive mutations never acquire an unheld lease. */
  authorizeMutation(chatId: string, holder: LeaseHolder): LeaseInfo | null {
    const current = this.live(chatId);
    if (!current || !current.committed || !sameHolder(current, holder)) return null;
    const now = this.now();
    const renewed: LeaseRecord = {
      ...current,
      actor: { ...holder.principal }, // preserve numeric authority while refreshing display login
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
      committed: true,
    };
    this.leases.set(chatId, renewed);
    return this.publicLease(renewed, holder);
  }

  heartbeat(chatId: string, holder: LeaseHolder): LeaseInfo | null {
    return this.authorizeMutation(chatId, holder);
  }

  /** Explicitly and atomically replace any live holder. */
  takeOver(chatId: string, holder: LeaseHolder): LeaseInfo {
    const current = this.live(chatId);
    if (!current || sameHolder(current, holder)) return this.acquire(chatId, holder)!;
    const now = this.now();
    const record: LeaseRecord = {
      leaseId: randomUUID(),
      actor: { ...holder.principal },
      viewerId: holder.viewerId,
      acquiredAt: now,
      expiresAt: now + this.ttlMs,
      revision: ++this.revision,
      committed: true,
    };
    this.leases.set(chatId, record);
    return this.publicLease(record, holder);
  }

  /** Apply acquire/takeover around an async attach and roll back only if no newer lease won a race. */
  async runAcquisition<T>(
    chatId: string,
    holder: LeaseHolder,
    takeover: boolean,
    operation: (previous: LeaseHolder | null) => Promise<T>,
  ): Promise<{ lease: LeaseInfo | null; value: T } | null> {
    const previous = this.live(chatId);
    if (previous && !previous.committed) return null;
    const previousHolder = previous
      ? { principal: { ...previous.actor }, viewerId: previous.viewerId }
      : null;
    const snapshot = previous ? { ...previous, actor: { ...previous.actor } } : null;
    const acquired = takeover ? this.takeOver(chatId, holder) : this.acquire(chatId, holder);
    if (!acquired) return null;
    const provisional = this.leases.get(chatId)!;
    provisional.committed = false;
    const appliedRevision = provisional.revision;
    try {
      const value = await operation(previousHolder);
      const current = this.leases.get(chatId);
      if (current?.revision === appliedRevision) current.committed = true;
      return { lease: this.get(chatId, holder), value };
    } catch (error) {
      if (this.leases.get(chatId)?.revision === appliedRevision) {
        if (snapshot) this.leases.set(chatId, snapshot);
        else this.leases.delete(chatId);
      }
      throw error;
    }
  }

  /** Release only for the exact holder (or an internal forced cleanup). */
  release(chatId: string, holder: LeaseHolder, force = false): boolean {
    const current = this.live(chatId);
    if (!current || (!force && !sameHolder(current, holder))) return false;
    this.leases.delete(chatId);
    return true;
  }

  /** Return every lease that crossed the strict expiry boundary since the last reap. */
  reapExpired(): Array<{ chatId: string; previous: LeaseHolder }> {
    for (const [chatId] of this.leases) this.live(chatId);
    const expired = [...this.recentlyExpired].map(([chatId, previous]) => ({ chatId, previous }));
    this.recentlyExpired.clear();
    return expired;
  }
}
