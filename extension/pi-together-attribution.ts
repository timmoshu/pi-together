import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { ARM_COMMAND, AttributionExtensionCore, LEASE_COMMAND, type InputEventLike } from "./attribution-core.js";
import { TurnGitIdentityState, type BotGitIdentity, type ManagedGitIdentity } from "./git-identity-core.js";
import { destructiveCommandReason, type DestructiveGuardConfig } from "./destructive-guard-core.js";
export { ARM_COMMAND, LEASE_COMMAND } from "./attribution-core.js";

const NO_CONTROLS = /^[^\u0000-\u001f\u007f<>]+$/;
const MANAGED_ENV_KEYS = [
  "PATH", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "PI_TOGETHER_REAL_GIT", "PI_TOGETHER_MANAGED_GIT_AUTHOR_NAME", "PI_TOGETHER_MANAGED_GIT_AUTHOR_EMAIL",
  "PI_TOGETHER_MANAGED_GIT_COMMITTER_NAME", "PI_TOGETHER_MANAGED_GIT_COMMITTER_EMAIL",
  "PI_TOGETHER_MANAGED_GIT_AGENT",
] as const;

type ModelLike = { provider: string; id: string };
type ContextLike = { sessionManager: { getSessionId(): string }; model?: ModelLike; isIdle?(): boolean };
type ToolEventLike = { toolName: string; input?: { command?: unknown } };
type MessageEventLike = { message: { role: string } };
type ModelEventLike = { model: ModelLike };
interface ExtensionApiLike {
  appendEntry(customType: string, data?: unknown): void;
  registerCommand(name: string, options: {
    description?: string;
    handler(args: string, context: ContextLike): Promise<void> | void;
  }): void;
  on(event: string, handler: (event: unknown, context: ContextLike) => unknown): void;
}

function verificationKeyFromEnvironment(): ReturnType<typeof createPublicKey> {
  const encoded = process.env.PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY;
  if (!encoded) throw new Error("Pi Together attribution verification key is required");
  return createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
}

function destructiveGuardFromEnvironment(): DestructiveGuardConfig {
  const encoded = process.env.PI_TOGETHER_DESTRUCTIVE_GUARD;
  if (!encoded) return { home: homedir(), protectedAnchors: [] };
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { home?: unknown; protectedAnchors?: unknown };
  if (typeof value.home !== "string" || !isAbsolute(value.home) || !Array.isArray(value.protectedAnchors)
    || !value.protectedAnchors.every((path) => typeof path === "string" && isAbsolute(path))) {
    throw new Error("Pi Together destructive guard configuration is invalid");
  }
  return { home: value.home, protectedAnchors: value.protectedAnchors as string[] };
}

function botIdentityFromEnvironment(): BotGitIdentity {
  const name = process.env.PI_TOGETHER_GIT_COMMITTER_NAME ?? "Pi Together";
  const email = process.env.PI_TOGETHER_GIT_COMMITTER_EMAIL ?? "";
  if (name.length > 128 || !NO_CONTROLS.test(name)) throw new Error("Pi Together Git committer name is invalid");
  if (email && !/^[1-9]\d{0,31}\+[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?@users\.noreply\.github\.com$/.test(email)) {
    throw new Error("Pi Together Git committer email is not a verified GitHub noreply identity");
  }
  return { name, email };
}

function executable(path: string): string {
  if (!isAbsolute(path)) throw new Error("managed Git executable path must be absolute");
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  if (!info.isFile()) throw new Error("managed Git executable must be a regular file");
  accessSync(canonical, constants.X_OK);
  return canonical;
}

function originalGit(pathValue = process.env.PATH ?? ""): string {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "git");
    try { return executable(candidate); }
    catch { /* continue through the Pi child PATH */ }
  }
  throw new Error("Git executable is unavailable");
}

function managedEnvironment(identity: ManagedGitIdentity, model: ModelLike): NodeJS.ProcessEnv {
  const launcher = executable(process.env.PI_TOGETHER_GIT_LAUNCHER ?? "");
  const git = originalGit(process.env.PATH);
  if (!model.provider || !model.id || model.provider.length > 128 || model.id.length > 256
    || !NO_CONTROLS.test(model.provider) || !NO_CONTROLS.test(model.id)) {
    throw new Error("managed Git identity requires a valid active Pi model");
  }
  return {
    PATH: [dirname(launcher), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    GIT_AUTHOR_NAME: identity.author.name,
    GIT_AUTHOR_EMAIL: identity.author.email,
    GIT_COMMITTER_NAME: identity.committer.name,
    GIT_COMMITTER_EMAIL: identity.committer.email,
    PI_TOGETHER_REAL_GIT: git,
    PI_TOGETHER_MANAGED_GIT_AUTHOR_NAME: identity.author.name,
    PI_TOGETHER_MANAGED_GIT_AUTHOR_EMAIL: identity.author.email,
    PI_TOGETHER_MANAGED_GIT_COMMITTER_NAME: identity.committer.name,
    PI_TOGETHER_MANAGED_GIT_COMMITTER_EMAIL: identity.committer.email,
    PI_TOGETHER_MANAGED_GIT_AGENT: `Pi (${model.provider}/${model.id})`,
  };
}

export default function piTogetherAttributionExtension(pi: ExtensionApiLike): void {
  let sessionId = "";
  let model: ModelLike | null = null;
  let activeBashCalls = 0;
  let savedEnvironment: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>> | null = null;
  const managed = process.env.PI_TOGETHER_ATTRIBUTION_MANAGED !== "0";
  const destructiveGuard = destructiveGuardFromEnvironment();
  const turnIdentity = new TurnGitIdentityState(botIdentityFromEnvironment());
  const core = new AttributionExtensionCore({
    publicKey: verificationKeyFromEnvironment(),
    sessionId: () => sessionId,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    reserveMessage: (data) => turnIdentity.reserve(data),
    managed,
  });

  const restoreEnvironment = () => {
    if (savedEnvironment) {
      for (const key of MANAGED_ENV_KEYS) {
        const value = savedEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    savedEnvironment = null;
    activeBashCalls = 0;
  };
  const applyForBash = (context: ContextLike) => {
    // Pi preflights sibling tool calls before execution. They share one delivered turn and one
    // environment window; never resolve Git again through the already-prepended launcher PATH.
    if (activeBashCalls > 0) {
      activeBashCalls++;
      return;
    }
    const currentModel = context.model ?? model;
    if (!currentModel) throw new Error("managed Git identity requires an active Pi model");
    const values = managedEnvironment(turnIdentity.identity, currentModel);
    savedEnvironment = Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    activeBashCalls = 1;
  };

  pi.on("session_start", (_event, context) => {
    restoreEnvironment();
    core.clear();
    turnIdentity.settle();
    sessionId = context.sessionManager.getSessionId();
    model = context.model ? { provider: context.model.provider, id: context.model.id } : null;
  });
  pi.on("session_shutdown", () => {
    restoreEnvironment();
    core.clear();
    turnIdentity.settle();
    sessionId = "";
    model = null;
  });
  pi.on("model_select", (raw) => {
    const event = raw as ModelEventLike;
    model = { provider: event.model.provider, id: event.model.id };
  });
  pi.on("message_start", (raw, context) => {
    const event = raw as MessageEventLike;
    if (event.message.role !== "user") return;
    turnIdentity.deliverUserMessage();
    model = context.model ? { provider: context.model.provider, id: context.model.id } : null;
  });
  pi.on("tool_call", (raw, context) => {
    const event = raw as ToolEventLike;
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (typeof command !== "string") return { block: true, reason: "Blocked malformed Bash command at the Pi Together safety boundary" };
    const reason = destructiveCommandReason(command, process.cwd(), destructiveGuard);
    if (reason) return { block: true, reason };
    applyForBash(context);
  });
  pi.on("tool_result", (raw) => {
    const event = raw as ToolEventLike;
    if (event.toolName !== "bash" || activeBashCalls <= 0) return;
    activeBashCalls--;
    if (activeBashCalls === 0) restoreEnvironment();
  });
  pi.on("agent_settled", () => {
    restoreEnvironment();
    turnIdentity.settle();
  });

  if (managed) {
    pi.registerCommand(ARM_COMMAND, {
      description: "Reserved Pi Together attribution arm",
      handler: (args, context) => {
        sessionId = context.sessionManager.getSessionId();
        core.arm(args.trim());
      },
    });
    pi.registerCommand(LEASE_COMMAND, {
      description: "Reserved Pi Together lease event",
      handler: (args, context) => {
        sessionId = context.sessionManager.getSessionId();
        core.appendLease(args.trim());
      },
    });

    pi.on("input", (raw, context) => {
      try {
        const event = raw as InputEventLike;
        const actionAllowed = event.streamingBehavior !== undefined || (context.isIdle?.() ?? true);
        return core.handleInput(event, actionAllowed);
      } catch { return { action: "handled" as const }; }
    });
  }
}
