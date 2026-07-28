// pi-adapter/runtime.ts — drive a live pi session over its rpc protocol (`pi --mode rpc`).
//
// One PiRuntime = one spawned `pi` child bound to a session. Commands are LF-framed JSON on stdin
// (`{"type":"prompt"|"steer"|"follow_up"|"abort"|"set_model"|...}`), pi streams events on stdout,
// and this bridges them into ServerEvents — including the streamed text/thinking/tool deltas the
// dashboard renders live. Per pi's rpc.md: split stdout on "\n" ONLY (never a Unicode-aware line
// reader) and strip a trailing "\r".
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ModelInfo, ServerEvent } from "../shared/protocol.js";
import { ARM_COMMAND, LEASE_COMMAND } from "../extension/attribution-core.js";
import { messageToTurn, previewToolContent, renderContent, renderThinking, summarizeToolArgs, type RawMessage } from "./normalize.js";

export interface PiRuntimeOptions {
  sessionDir: string;
  sessionId: string;
  cwd?: string;
  provider?: string;
  model?: string;
  tools?: string[]; // allowlist; when set, passed as --tools (used for read-only mode)
  thinking?: string;
  piBin?: string;
  noTools?: boolean; // smokes/tests
  env?: NodeJS.ProcessEnv;
  responseTimeoutMs?: number;
  attribution?: {
    extensionPath: string;
    publicKey: string;
    gitIdentity?: { committerName: string; committerEmail: string; launcherPath: string };
    destructiveGuard?: { home: string; protectedAnchors: string[] };
    managed?: boolean;
  };
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiRuntime {
  readonly sessionId: string;
  private child: ChildProcess;
  private bus = new EventEmitter();
  private buf = "";
  private pending = new Map<string, Pending>();
  private seq = 0;
  private itemSeq = 0;
  private curItemId: string | null = null;
  private alive = true;
  private timeout: number;
  private readonly attribution?: PiRuntimeOptions["attribution"];
  private attributionReady: Promise<void> | null = null;
  private extensionCommands = new Set<string>();
  private attributionQueue: Promise<void> = Promise.resolve();

  constructor(opts: PiRuntimeOptions) {
    this.sessionId = opts.sessionId;
    this.timeout = opts.responseTimeoutMs ?? 120_000;
    this.attribution = opts.attribution;
    // --session-id (not --session): uses the exact project session if it exists, creates it if not —
    // correct for both resume-existing and openWorkspace-new. `--session` would error on a new id.
    const args = ["--mode", "rpc", "--session-dir", opts.sessionDir, "--session-id", opts.sessionId];
    if (opts.provider) args.push("--provider", opts.provider);
    if (opts.model) args.push("--model", opts.model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    if (opts.attribution) args.push("-e", resolve(opts.attribution.extensionPath));
    if (opts.noTools) args.push("--no-tools");
    else if (opts.tools && opts.tools.length) args.push("--tools", opts.tools.join(","));
    this.child = spawn(opts.piBin ?? "pi", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.attribution
        ? {
            ...(opts.env ?? process.env),
            PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY: opts.attribution.publicKey,
            PI_TOGETHER_ATTRIBUTION_MANAGED: opts.attribution.managed === false ? "0" : "1",
            ...(opts.attribution.destructiveGuard ? {
              PI_TOGETHER_DESTRUCTIVE_GUARD: Buffer.from(JSON.stringify(opts.attribution.destructiveGuard)).toString("base64url"),
            } : {}),
            ...(opts.attribution.gitIdentity ? {
              PI_TOGETHER_GIT_COMMITTER_NAME: opts.attribution.gitIdentity.committerName,
              PI_TOGETHER_GIT_COMMITTER_EMAIL: opts.attribution.gitIdentity.committerEmail,
              PI_TOGETHER_GIT_LAUNCHER: opts.attribution.gitIdentity.launcherPath,
            } : {}),
          }
        : (opts.env ?? process.env),
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onStdout(d));
    if (process.env.PI_RUNTIME_DEBUG) {
      this.child.stderr!.setEncoding("utf8");
      this.child.stderr!.on("data", (d: string) => process.stderr.write(`[pi ${this.sessionId}] ${d}`));
    }
    this.child.on("exit", (code) => {
      this.alive = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("pi runtime exited"));
      }
      this.pending.clear();
      this.emit({ type: "chat.status", chatId: this.sessionId, status: code === 0 ? "idle" : "error" });
      this.bus.emit("exit", code);
    });
    this.child.on("error", (err) => {
      this.alive = false;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      this.bus.emit("spawn_error", err);
    });
  }

  private emit(e: ServerEvent): void {
    this.bus.emit("event", e);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON banner / partial line
      }
      this.handle(msg);
    }
  }

  private handle(msg: Record<string, unknown>): void {
    const type = msg["type"];
    if (type === "response") {
      const id = msg["id"] as string | undefined;
      const p = id ? this.pending.get(id) : undefined;
      if (p && id) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg["success"]) p.resolve(msg);
        else p.reject(Object.assign(new Error(String(msg["error"] ?? "rpc error")), { rpc: msg }));
      }
      return;
    }
    const chatId = this.sessionId;
    switch (type) {
      case "agent_start":
      case "turn_start":
        this.emit({ type: "run.state", chatId, state: "running" });
        this.emit({ type: "chat.status", chatId, status: "running" });
        break;
      case "agent_settled":
        this.emit({ type: "run.state", chatId, state: "idle" });
        this.emit({ type: "chat.status", chatId, status: "waiting" });
        break;
      case "message_start": {
        const m = msg["message"] as RawMessage | undefined;
        // Pi emits message events for user and toolResult messages too; only assistant messages own
        // the live assistant preview.
        if (String(m?.role ?? "").toLowerCase() !== "assistant") break;
        this.curItemId = `${chatId}-a${this.itemSeq++}`;
        this.emit({ type: "msg.start", chatId, itemId: this.curItemId, role: "agent" });
        break;
      }
      case "message_update": {
        const ev = msg["assistantMessageEvent"] as { type?: string; delta?: string } | undefined;
        if (!ev) break;
        const itemId = this.curItemId ?? `${chatId}-a${this.itemSeq++}`;
        this.curItemId = itemId;
        if (ev.type === "text_delta" && typeof ev.delta === "string")
          this.emit({ type: "msg.delta", chatId, itemId, text: ev.delta });
        else if (ev.type === "thinking_delta" && typeof ev.delta === "string")
          this.emit({ type: "thinking.delta", chatId, itemId, text: ev.delta });
        break;
      }
      case "message_end": {
        const m = msg["message"] as RawMessage | undefined;
        const itemId = this.curItemId ?? `${chatId}-a${this.itemSeq++}`;
        this.curItemId = null;
        // Only the ASSISTANT message becomes a transcript turn here. Pi also emits message_end for the
        // USER message it just accepted, but the user turn is already surfaced by the send() path, so
        // re-emitting it would double the user's message in the conversation.
        if (m && String(m.role ?? "").toLowerCase() === "assistant") {
          const text = renderContent(m.content);
          const thinking = renderThinking(m.content);
          // Emit even for a pure tool-call response so the client can finalize its thinking preview.
          this.emit({ type: "msg.end", chatId, itemId, role: "agent", text, ...(thinking ? { thinking } : {}) });
          const turn = messageToTurn(m, `${chatId}-${this.seq++}`, Date.now());
          if (turn) this.emit({ type: "chat.turn", chatId, turn });
        }
        break;
      }
      case "tool_execution_start": {
        const callId = String(msg["toolCallId"] ?? "");
        const name = String(msg["toolName"] ?? "tool");
        if (callId) this.emit({ type: "tool.start", chatId, callId, name, argsSummary: summarizeToolArgs(name, msg["args"]) });
        break;
      }
      case "tool_execution_update": {
        const callId = String(msg["toolCallId"] ?? "");
        if (callId) {
          const content = (msg["partialResult"] as { content?: RawMessage["content"] } | undefined)?.content;
          this.emit({ type: "tool.update", chatId, callId, preview: previewToolContent(content) });
        }
        break;
      }
      case "tool_execution_end": {
        const callId = String(msg["toolCallId"] ?? "");
        const name = String(msg["toolName"] ?? "tool");
        if (callId)
          this.emit({
            type: "tool.end",
            chatId,
            callId,
            name,
            ok: !msg["isError"],
            preview: previewToolContent((msg["result"] as { content?: RawMessage["content"] } | undefined)?.content),
          });
        break;
      }
      case "queue_update":
        this.emit({
          type: "queue",
          chatId,
          steering: (msg["steering"] as string[]) ?? [],
          followUp: (msg["followUp"] as string[]) ?? [],
        });
        break;
      case "compaction_start":
        this.emit({ type: "run.state", chatId, state: "compacting" });
        this.emit({ type: "notice", chatId, kind: "compaction", text: `compacting (${String(msg["reason"] ?? "manual")})` });
        break;
      case "compaction_end":
        this.emit({ type: "run.state", chatId, state: "idle" });
        this.emit({ type: "notice", chatId, kind: "compaction", text: "compaction complete" });
        break;
      case "auto_retry_start":
        this.emit({ type: "run.state", chatId, state: "retrying" });
        this.emit({
          type: "notice",
          chatId,
          kind: "retry",
          text: `retrying (attempt ${String(msg["attempt"] ?? "?")}/${String(msg["maxAttempts"] ?? "?")})`,
        });
        break;
      case "auto_retry_end":
        this.emit({ type: "run.state", chatId, state: "running" });
        if (msg["success"] === false)
          this.emit({ type: "notice", chatId, kind: "error", text: `retry failed: ${String(msg["finalError"] ?? "")}` });
        break;
      case "extension_error":
        this.emit({ type: "notice", chatId, kind: "extension", text: String(msg["error"] ?? "extension error") });
        break;
      case "extension_ui_request": {
        const method = msg["method"];
        if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
          this.emit({
            type: "ext.request",
            chatId,
            requestId: String(msg["id"] ?? ""),
            method,
            title: String(msg["title"] ?? ""),
            message: typeof msg["message"] === "string" ? (msg["message"] as string) : undefined,
            options: Array.isArray(msg["options"]) ? (msg["options"] as string[]) : undefined,
            prefill: typeof msg["prefill"] === "string" ? (msg["prefill"] as string) : undefined,
            placeholder: typeof msg["placeholder"] === "string" ? (msg["placeholder"] as string) : undefined,
          });
        } else if (method === "notify") {
          const nt = String(msg["notifyType"] ?? "info");
          this.emit({ type: "notice", chatId, kind: nt === "error" ? "error" : "info", text: String(msg["message"] ?? "") });
        }
        // other fire-and-forget methods (setStatus/setWidget/…) are ignored in the web UI
        break;
      }
      default:
        break;
    }
  }

  private send(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error("pi runtime is not alive"));
    const rid = `rq${this.seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`rpc ${String(cmd["type"])} timed out`));
      }, this.timeout);
      this.pending.set(rid, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ id: rid, ...cmd })}\n`);
    });
  }

  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<Record<string, unknown>> {
    return this.send({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  private async ensureAttributionReady(): Promise<void> {
    if (!this.attribution) throw new Error("attribution is not configured for this runtime");
    if (this.attributionReady) return this.attributionReady;
    this.attributionReady = (async () => {
      const response = await this.send({ type: "get_commands" });
      const commands = ((response["data"] as { commands?: unknown[] } | undefined)?.commands ?? []) as Array<Record<string, unknown>>;
      const extensionPath = resolve(this.attribution!.extensionPath);
      const isOwned = (command: Record<string, unknown>) => {
        const sourceInfo = command["sourceInfo"] as Record<string, unknown> | undefined;
        return command["source"] === "extension" && resolve(String(sourceInfo?.["path"] ?? "")) === extensionPath;
      };
      for (const reserved of [ARM_COMMAND, LEASE_COMMAND]) {
        const matches = commands.filter((command) => {
          const name = String(command["name"] ?? "");
          return name === reserved || name.startsWith(`${reserved}:`);
        });
        if (matches.length !== 1 || String(matches[0]?.["name"] ?? "") !== reserved || !isOwned(matches[0]!)) {
          throw new Error("Pi Together attribution commands are missing, duplicated, or from the wrong source");
        }
      }
      this.extensionCommands = new Set(
        commands.filter((command) => command["source"] === "extension").map((command) => String(command["name"] ?? "")),
      );
    })();
    try {
      await this.attributionReady;
    } catch (error) {
      this.attributionReady = null;
      throw error;
    }
  }

  private async hasCustomRequest(customType: string, requestId: string): Promise<boolean> {
    const entriesResponse = await this.send({ type: "get_entries" });
    const entries = ((entriesResponse["data"] as { entries?: unknown[] } | undefined)?.entries ?? []) as Array<Record<string, unknown>>;
    return entries.some((entry) => {
      const data = entry["data"] as Record<string, unknown> | undefined;
      return entry["type"] === "custom" && entry["customType"] === customType && data?.["requestId"] === requestId;
    });
  }

  private hasAttribution(requestId: string): Promise<boolean> {
    return this.hasCustomRequest("pi-together.attribution.v1", requestId);
  }

  private enqueueAttribution<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.attributionQueue.then(operation);
    this.attributionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  sendAttributed(
    encodedArm: string,
    requestId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<Record<string, unknown>> {
    return this.enqueueAttribution(() => this.performAttributedSend(encodedArm, requestId, message, streamingBehavior));
  }

  private async performAttributedSend(
    encodedArm: string,
    requestId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<Record<string, unknown>> {
    try {
      await this.ensureAttributionReady();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    const commandName = message.match(/^\/([^\s]+)/)?.[1];
    if (commandName && this.extensionCommands.has(commandName)) {
      throw new Error("installed extension commands are not supported for collaborative browser input");
    }
    try {
      await this.prompt(`/${ARM_COMMAND} ${encodedArm}`);
    } catch (error) {
      await this.close().catch(() => undefined); // arm state is unknown; never reuse this extension instance
      throw error;
    }

    let response: Record<string, unknown>;
    try {
      response = await this.prompt(message, streamingBehavior);
    } catch (error) {
      // A response can be lost after input acceptance. Durable marker read-back disambiguates it.
      try {
        if (await this.hasAttribution(requestId)) {
          return { type: "response", command: "prompt", success: true, data: { recovered: true } };
        }
      } catch {
        // Runtime death or a second timeout leaves acceptance unknown; close below.
      }
      await this.close().catch(() => undefined);
      throw error;
    }

    try {
      if (!await this.hasAttribution(requestId)) throw new Error("Pi did not persist the expected attribution marker");
      return response;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  appendAttributedLease(encodedLease: string, requestId: string): Promise<void> {
    return this.enqueueAttribution(() => this.performAttributedLease(encodedLease, requestId));
  }

  private async performAttributedLease(encodedLease: string, requestId: string): Promise<void> {
    try {
      await this.ensureAttributionReady();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    try {
      await this.prompt(`/${LEASE_COMMAND} ${encodedLease}`);
      if (!await this.hasCustomRequest("pi-together.lease.v1", requestId)) {
        throw new Error("Pi did not persist the expected lease marker");
      }
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async getEntries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    const response = await this.send({ type: "get_entries" });
    const data = (response["data"] as { entries?: unknown[]; leafId?: unknown } | undefined) ?? {};
    return { entries: data.entries ?? [], leafId: typeof data.leafId === "string" ? data.leafId : null };
  }
  compact(customInstructions?: string): Promise<Record<string, unknown>> {
    return this.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
  }
  setName(name: string): Promise<Record<string, unknown>> {
    return this.send({ type: "set_session_name", name });
  }
  async abort(pendingExtensionRequestId?: string): Promise<Record<string, unknown>> {
    // Pi's abort waits for the agent to become idle, but an extension can be awaiting UI inside a
    // tool call and will not observe the agent abort signal. Cancel that dialog first so the tool
    // can unwind and the abort command can complete.
    if (pendingExtensionRequestId) {
      await this.extensionUiResponse(pendingExtensionRequestId, { cancelled: true });
    }
    return this.send({ type: "abort" });
  }
  setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    return this.send({ type: "set_model", provider, modelId });
  }
  setThinkingLevel(level: string): Promise<Record<string, unknown>> {
    return this.send({ type: "set_thinking_level", level });
  }
  async getAvailableModels(): Promise<ModelInfo[]> {
    const r = await this.send({ type: "get_available_models" });
    const data = (r["data"] as { models?: unknown[] } | undefined)?.models ?? [];
    return (data as Array<Record<string, unknown>>).map((m) => ({
      provider: String(m["provider"] ?? ""),
      id: String(m["id"] ?? ""),
      name: String(m["name"] ?? m["id"] ?? ""),
      reasoning: Boolean(m["reasoning"]),
    }));
  }
  async getAvailableThinkingLevels(): Promise<string[]> {
    const r = await this.send({ type: "get_available_thinking_levels" });
    const data = (r["data"] as { levels?: unknown } | undefined)?.levels;
    return Array.isArray(data) ? (data as string[]) : ["off"];
  }
  async getState(): Promise<Record<string, unknown>> {
    const r = await this.send({ type: "get_state" });
    return (r["data"] as Record<string, unknown>) ?? {};
  }
  extensionUiResponse(requestId: string, reply: Record<string, unknown>): Promise<void> {
    if (!this.alive) return Promise.reject(new Error("pi runtime is not alive"));
    const stdin = this.child.stdin;
    if (!stdin?.writable) return Promise.reject(new Error("pi runtime stdin is not writable"));
    // This is a response to Pi's extension UI sub-protocol, not an RPC command. Pi consumes the
    // matching request ID without emitting another correlated `response`, so resolve once the frame
    // has been written instead of adding an entry to the RPC pending-response map.
    return new Promise((resolve, reject) => {
      try {
        stdin.write(`${JSON.stringify({ ...reply, type: "extension_ui_response", id: requestId })}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  subscribe(listener: (e: ServerEvent) => void): () => void {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.bus.on("exit", listener);
  }
  get isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    const wasAlive = this.alive;
    this.alive = false;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    if (wasAlive) this.child.kill("SIGTERM");
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi runtime closed"));
    }
    this.pending.clear();
    this.bus.removeAllListeners();
  }
}

/** Tracks one live PiRuntime per session id and fans their events to a single sink. */
export class PiRuntimeManager {
  private runtimes = new Map<string, PiRuntime>();
  constructor(
    private defaults: Omit<PiRuntimeOptions, "sessionId" | "sessionDir" | "cwd">,
    private onEvent: (e: ServerEvent) => void,
  ) {}

  has(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.isAlive ?? false;
  }

  /** Get the live runtime for a session, spawning one if needed. */
  ensure(sessionId: string, sessionDir: string, cwd?: string, overrides?: Partial<PiRuntimeOptions>): PiRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing?.isAlive) return existing;
    const rt = new PiRuntime({ ...this.defaults, ...overrides, sessionId, sessionDir, cwd });
    rt.subscribe(this.onEvent);
    rt.onExit(() => {
      if (this.runtimes.get(sessionId) === rt) this.runtimes.delete(sessionId);
    });
    this.runtimes.set(sessionId, rt);
    return rt;
  }

  get(sessionId: string): PiRuntime | undefined {
    const rt = this.runtimes.get(sessionId);
    return rt?.isAlive ? rt : undefined;
  }

  async stop(sessionId: string): Promise<boolean> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return false;
    this.runtimes.delete(sessionId);
    await rt.close();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((r) => r.close()));
    this.runtimes.clear();
  }
}
