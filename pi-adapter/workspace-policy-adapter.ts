import type {
  AdapterChatDetail, AdapterEvent, CatalogEntry, ChatConfig, ChatSummary, DurableLeaseEvent,
  ExtensionUiReply, ModelInfo, PiAdapter, ToolMode, WebAttribution,
} from "../shared/protocol.js";
import { RepositoryDiscovery, WorkspaceNotFoundError, type RepositoryFact } from "../server/workspace-policy.js";

function chatId(event: AdapterEvent): string | null {
  if (event.type === "hello") return null;
  return event.type === "chat.updated" ? event.chat.id : event.chatId;
}

/** Enforces one deployment-wide repository policy before adapter detail/runtime/event boundaries. */
export class WorkspacePolicyAdapter implements PiAdapter {
  readonly kind: "real" | "fake";
  private readonly knownAuthorized = new Set<string>();

  constructor(readonly inner: PiAdapter, readonly policy: RepositoryDiscovery) {
    this.kind = inner.kind;
  }

  private async fact(summary: ChatSummary): Promise<RepositoryFact> {
    return this.policy.authorize(summary.workspaceRoot);
  }

  private async summary(id: string): Promise<ChatSummary> {
    const summary = (await this.inner.listChats()).find((candidate) => candidate.id === id);
    if (!summary) throw new WorkspaceNotFoundError();
    await this.fact(summary);
    this.knownAuthorized.add(id);
    return summary;
  }

  async listChats(): Promise<ChatSummary[]> {
    const visible: ChatSummary[] = [];
    for (const summary of await this.inner.listChats()) {
      try {
        const fact = await this.fact(summary);
        visible.push({ ...summary, repoRoot: fact.mainWorktree });
        this.knownAuthorized.add(summary.id);
      } catch { this.knownAuthorized.delete(summary.id); }
    }
    return visible;
  }

  async getChat(id: string): Promise<AdapterChatDetail | null> {
    try { await this.summary(id); } catch { return null; }
    const detail = await this.inner.getChat(id);
    if (!detail) return null;
    try {
      const fact = await this.fact(detail);
      this.knownAuthorized.add(id);
      return { ...detail, repoRoot: fact.mainWorktree };
    } catch { this.knownAuthorized.delete(id); return null; }
  }

  private async guarded<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await this.summary(id);
    return operation();
  }
  resume(id: string): Promise<ChatSummary> { return this.guarded(id, () => this.inner.resume(id)); }
  detach(id: string): Promise<ChatSummary> { return this.guarded(id, () => this.inner.detach(id)); }
  compact(id: string): Promise<ChatSummary> { return this.guarded(id, () => this.inner.compact(id)); }
  rename(id: string, name: string): Promise<ChatSummary> { return this.guarded(id, () => this.inner.rename(id, name)); }
  send(id: string, text: string, mode: "normal" | "steer" | "followUp", attribution?: WebAttribution): Promise<{ accepted: boolean; queued: boolean }> {
    return this.guarded(id, () => this.inner.send(id, text, mode, attribution));
  }
  abort(id: string): Promise<void> { return this.guarded(id, () => this.inner.abort(id)); }
  getConfig(id: string): Promise<ChatConfig> { return this.guarded(id, () => this.inner.getConfig(id)); }
  setConfig(id: string, change: { model?: { provider: string; id: string }; thinking?: string; toolMode?: ToolMode }): Promise<ChatConfig> {
    return this.guarded(id, () => this.inner.setConfig(id, change));
  }
  extensionUiResponse(id: string, requestId: string, reply: ExtensionUiReply): Promise<void> {
    return this.guarded(id, () => this.inner.extensionUiResponse(id, requestId, reply));
  }
  recordLeaseEvent(id: string, event: DurableLeaseEvent): Promise<void> {
    return this.guarded(id, () => this.inner.recordLeaseEvent(id, event));
  }

  async listWorkspaces(): Promise<string[]> {
    const discovery = await this.policy.refresh();
    return [...new Set(discovery.repositories.flatMap((repo) => [repo.mainWorktree, ...repo.linkedWorktrees]))].sort();
  }

  async openWorkspace(root: string): Promise<ChatSummary> {
    const fact = await this.policy.authorize(root);
    if (fact.worktree !== root) throw new WorkspaceNotFoundError();
    const result = await this.inner.openWorkspace(root);
    this.knownAuthorized.add(result.id);
    return { ...result, repoRoot: fact.mainWorktree };
  }

  async createChat(workspaceRoot: string, name?: string): Promise<ChatSummary> {
    const fact = await this.policy.authorize(workspaceRoot);
    if (fact.worktree !== workspaceRoot) throw new WorkspaceNotFoundError();
    const result = await this.inner.createChat(workspaceRoot, name);
    this.knownAuthorized.add(result.id);
    return { ...result, repoRoot: fact.mainWorktree };
  }

  async refreshWorkspaces(): Promise<{ truncated: boolean }> {
    const result = await this.policy.refresh();
    return { truncated: result.truncated };
  }

  async catalog(): Promise<CatalogEntry[]> {
    const chats = await this.listChats();
    const counts = new Map<string, number>();
    for (const chat of chats) counts.set(chat.repoRoot, (counts.get(chat.repoRoot) ?? 0) + 1);
    const entries: CatalogEntry[] = [];
    const discovery = await this.policy.refresh();
    for (const repo of discovery.repositories) {
      for (const worktree of [repo.mainWorktree, ...repo.linkedWorktrees]) {
        entries.push({ workspaceRoot: worktree, label: worktree === repo.mainWorktree ? repo.label : `${repo.label} · ${worktree.split("/").pop()}`, source: "root", sessionCount: counts.get(worktree) ?? 0 });
      }
    }
    for (const folder of this.policy.approvedFolders()) {
      if (!discovery.repositories.some((repository) => repository.sourceFolder === folder)) {
        entries.push({ workspaceRoot: folder, label: folder.split("/").filter(Boolean).pop() ?? folder, source: "folder", sessionCount: 0 });
      }
    }
    return entries.sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  }

  models(refresh = false): Promise<ModelInfo[]> { return this.inner.models(refresh); }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    let active = true;
    let queue = Promise.resolve();
    const unsubscribe = this.inner.subscribe((event) => {
      queue = queue.then(async () => {
        if (!active) return;
        if (event.type === "hello") { listener(event); return; }
        if (event.type === "chat.updated") {
          try {
            const fact = await this.fact(event.chat);
            this.knownAuthorized.add(event.chat.id);
            listener({ ...event, chat: { ...event.chat, repoRoot: fact.mainWorktree } });
          } catch { this.knownAuthorized.delete(event.chat.id); }
          return;
        }
        const id = chatId(event)!;
        if (event.type === "chat.removed") {
          if (this.knownAuthorized.delete(id)) listener(event);
          return;
        }
        try { await this.summary(id); listener(event); } catch { /* drop before registry/replay */ }
      }).catch(() => undefined);
    });
    return () => { active = false; unsubscribe(); };
  }

  close(): Promise<void> { this.knownAuthorized.clear(); return this.inner.close(); }
}
