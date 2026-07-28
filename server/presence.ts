import type { PresenceSnapshot, PrincipalIdentity } from "../shared/protocol.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

export const MAX_PRESENCE_SESSIONS = 512;
export const MAX_PARTICIPANTS_PER_SESSION = 32;
export const MAX_VIEWERS_PER_PARTICIPANT = 16;
export const MAX_CONNECTIONS_PER_VIEWER = 2;
export const PRESENCE_STALE_AFTER_MS = 45_000;
export const PRESENCE_REAP_INTERVAL_MS = 10_000;

const NO_CONTROLS = /^[^\u0000-\u001f\u007f]+$/;
const VIEWER_ID = /^[A-Za-z0-9._:-]+$/;

interface JoinInput {
  chatId: string;
  connectionId: string;
  principal: PrincipalIdentity;
  viewerId: string;
}
interface ConnectionRecord extends JoinInput { principalKey: string; lastSeen: number }
interface ParticipantRecord {
  actor: PrincipalIdentity;
  viewers: Map<string, Set<string>>;
}
interface SessionRecord { participants: Map<string, ParticipantRecord> }

export interface PresenceManagerOptions {
  now?: () => number;
  staleAfterMs?: number;
  maxSessions?: number;
  maxParticipantsPerSession?: number;
  maxViewersPerParticipant?: number;
  maxConnectionsPerViewer?: number;
  onChange?: (chatId: string, snapshot: PresenceSnapshot) => void;
}

function bounded(value: string, label: string, max: number, pattern = NO_CONTROLS): void {
  if (!value || value.length > max || !pattern.test(value)) throw new Error(`${label} is invalid or too long`);
}
function principalKey(principal: PrincipalIdentity): string {
  return `${principal.provider}:${principal.subject}`;
}
function cloneActor(actor: PrincipalIdentity): PrincipalIdentity {
  return { provider: actor.provider, subject: actor.subject, login: actor.login };
}

/** Bounded, process-local presence state. It never touches Pi's native session tree. */
export class PresenceManager {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly maxSessions: number;
  private readonly maxParticipants: number;
  private readonly maxViewers: number;
  private readonly maxConnections: number;
  private readonly onChange?: PresenceManagerOptions["onChange"];
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly revisions = new Map<string, number>();
  private nextRevision = 1;

  constructor(options: PresenceManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? PRESENCE_STALE_AFTER_MS;
    this.maxSessions = options.maxSessions ?? MAX_PRESENCE_SESSIONS;
    this.maxParticipants = options.maxParticipantsPerSession ?? MAX_PARTICIPANTS_PER_SESSION;
    this.maxViewers = options.maxViewersPerParticipant ?? MAX_VIEWERS_PER_PARTICIPANT;
    this.maxConnections = options.maxConnectionsPerViewer ?? MAX_CONNECTIONS_PER_VIEWER;
    this.onChange = options.onChange;
    for (const [label, value] of [["stale timeout", this.staleAfterMs], ["session cap", this.maxSessions], ["participant cap", this.maxParticipants], ["viewer cap", this.maxViewers], ["connection cap", this.maxConnections]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    }
  }

  private validate(input: JoinInput): void {
    bounded(input.chatId, "chat ID", 256);
    bounded(input.connectionId, "connection ID", 128, VIEWER_ID);
    bounded(input.viewerId, "viewer ID", 128, VIEWER_ID);
    bounded(input.principal.subject, "principal subject", 128);
    bounded(input.principal.login, "principal login", 128);
    if (input.principal.provider !== "github" && input.principal.provider !== "local") throw new Error("principal provider is invalid");
  }

  join(input: JoinInput): boolean {
    this.validate(input);
    const existing = this.connections.get(input.connectionId);
    if (existing) {
      if (existing.chatId !== input.chatId || existing.viewerId !== input.viewerId || existing.principalKey !== principalKey(input.principal)) {
        throw new Error("connection ID is already bound to different presence metadata");
      }
      existing.lastSeen = this.now();
      return true;
    }

    let session = this.sessions.get(input.chatId);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) return false;
      session = { participants: new Map() };
    }
    const key = principalKey(input.principal);
    let participant = session.participants.get(key);
    if (!participant && session.participants.size >= this.maxParticipants) return false;
    participant ??= { actor: cloneActor(input.principal), viewers: new Map() };
    const connections = participant.viewers.get(input.viewerId);
    if (!connections && participant.viewers.size >= this.maxViewers) return false;
    if (connections && connections.size >= this.maxConnections) return false;

    const visibleChange = !session.participants.has(key) || !connections
      || participant.actor.login !== input.principal.login;
    participant.actor = cloneActor(input.principal);
    const viewerConnections = connections ?? new Set<string>();
    viewerConnections.add(input.connectionId);
    participant.viewers.set(input.viewerId, viewerConnections);
    session.participants.set(key, participant);
    this.sessions.set(input.chatId, session);
    this.connections.set(input.connectionId, { ...input, principal: cloneActor(input.principal), principalKey: key, lastSeen: this.now() });
    if (visibleChange) this.emit(input.chatId);
    return true;
  }

  touch(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    connection.lastSeen = this.now();
    return true;
  }

  private remove(connectionId: string): { chatId: string; visibleChange: boolean } | null {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    this.connections.delete(connectionId);
    const session = this.sessions.get(connection.chatId);
    const participant = session?.participants.get(connection.principalKey);
    const viewerConnections = participant?.viewers.get(connection.viewerId);
    if (!session || !participant || !viewerConnections) return { chatId: connection.chatId, visibleChange: false };
    viewerConnections.delete(connectionId);
    let visibleChange = false;
    if (!viewerConnections.size) {
      participant.viewers.delete(connection.viewerId);
      visibleChange = true;
    }
    if (!participant.viewers.size) session.participants.delete(connection.principalKey);
    if (!session.participants.size) this.sessions.delete(connection.chatId);
    return { chatId: connection.chatId, visibleChange };
  }

  leave(connectionId: string): boolean {
    const removed = this.remove(connectionId);
    if (!removed) return false;
    if (removed.visibleChange) this.emit(removed.chatId);
    return true;
  }

  reapStale(): number {
    const deadline = this.now() - this.staleAfterMs;
    const affected = new Set<string>();
    let removed = 0;
    for (const [connectionId, connection] of this.connections) {
      if (connection.lastSeen > deadline) continue;
      const result = this.remove(connectionId);
      if (result?.visibleChange) affected.add(result.chatId);
      removed++;
    }
    for (const chatId of affected) this.emit(chatId);
    return removed;
  }

  snapshot(chatId: string): PresenceSnapshot {
    const participants = [...(this.sessions.get(chatId)?.participants.values() ?? [])]
      .map((participant) => ({ actor: cloneActor(participant.actor), viewerCount: participant.viewers.size }))
      .sort((left, right) => `${left.actor.provider}:${left.actor.subject}`.localeCompare(`${right.actor.provider}:${right.actor.subject}`));
    return { revision: this.revisions.get(chatId) ?? 0, observedAt: this.now(), participants };
  }

  private emit(chatId: string): void {
    const revision = this.nextRevision++;
    if (this.nextRevision > Number.MAX_SAFE_INTEGER) this.nextRevision = 1;
    this.revisions.set(chatId, revision);
    this.onChange?.(chatId, this.snapshot(chatId));
    if (!this.sessions.has(chatId)) this.revisions.delete(chatId);
  }
}

export interface SessionPresenceOptions extends Omit<PresenceManagerOptions, "onChange"> {
  reapIntervalMs?: number;
}

/** Connects ephemeral presence snapshots to the existing SSE registry without replay persistence. */
export class SessionPresence {
  readonly manager: PresenceManager;
  private readonly reaper: NodeJS.Timeout;

  constructor(registry: RuntimeRegistry, options: SessionPresenceOptions = {}) {
    const interval = options.reapIntervalMs ?? PRESENCE_REAP_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("presence reap interval must be a positive integer");
    this.manager = new PresenceManager({
      ...options,
      onChange: (chatId, snapshot) => { void registry.broadcastEphemeral({ type: "chat.presence", chatId, ...snapshot }); },
    });
    this.reaper = setInterval(() => this.manager.reapStale(), interval);
    this.reaper.unref();
  }

  join(input: JoinInput): () => void {
    this.manager.join(input);
    return () => { this.manager.leave(input.connectionId); };
  }

  touch(connectionId: string): boolean { return this.manager.touch(connectionId); }
  close(): void { clearInterval(this.reaper); }
}
