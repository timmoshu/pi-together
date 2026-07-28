import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import piTogetherAttributionExtension, {
  ARM_COMMAND,
  LEASE_COMMAND,
} from "../extension/pi-together-attribution.js";
import {
  encodeSignedEnvelope,
  hashContent,
  type InputEventLike,
} from "../extension/attribution-core.js";
import { signEnvelope } from "../pi-adapter/attribution-signer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const managedEnvironmentKeys = [
  "PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY", "PI_TOGETHER_ATTRIBUTION_MANAGED", "PI_TOGETHER_DESTRUCTIVE_GUARD", "PI_TOGETHER_GIT_COMMITTER_NAME", "PI_TOGETHER_GIT_LAUNCHER",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "PI_TOGETHER_REAL_GIT", "PI_TOGETHER_MANAGED_GIT_AUTHOR_NAME", "PI_TOGETHER_MANAGED_GIT_AUTHOR_EMAIL",
  "PI_TOGETHER_MANAGED_GIT_COMMITTER_NAME", "PI_TOGETHER_MANAGED_GIT_COMMITTER_EMAIL", "PI_TOGETHER_MANAGED_GIT_AGENT",
] as const;
const originalEnvironment = Object.fromEntries(managedEnvironmentKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of managedEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Pi attribution extension registration", () => {
  it("registers reserved commands, consumes one RPC input, and clears on shutdown", async () => {
    process.env.PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const commands = new Map<string, (args: string, context: Context) => unknown>();
    const handlers = new Map<string, Array<(event: unknown, context: Context) => unknown>>();
    const appended: Array<{ customType: string; data: unknown }> = [];
    type Context = { sessionManager: { getSessionId(): string }; model?: { provider: string; id: string } };
    const context: Context = { sessionManager: { getSessionId: () => "session_1" }, model: { provider: "synthetic", id: "test-model" } };
    const pi = {
      appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
      registerCommand: (name: string, options: { handler: (args: string, context: Context) => unknown }) => commands.set(name, options.handler),
      on: (event: string, handler: (event: unknown, context: Context) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    };

    piTogetherAttributionExtension(pi as Parameters<typeof piTogetherAttributionExtension>[0]);
    expect([...commands.keys()]).toEqual([ARM_COMMAND, LEASE_COMMAND]);
    await handlers.get("session_start")?.[0]?.({}, context);

    const now = Date.now();
    const payload = {
      version: 1 as const,
      kind: "message" as const,
      sessionId: "session_1",
      requestId: "req_1",
      actor: { provider: "github" as const, subject: "12345", login: "octocat" },
      action: "prompt" as const,
      viewerId: "viewer_a",
      issuedAt: new Date(now - 100).toISOString(),
      expiresAt: new Date(now + 10_000).toISOString(),
      nonce: "nonce_1234567890123456",
      contentSha256: hashContent("hello"),
    };
    await commands.get(ARM_COMMAND)?.(encodeSignedEnvelope(signEnvelope(payload, privateKey)), context);
    const input = handlers.get("input")?.[0];
    expect(await input?.({ text: "hello", source: "rpc" } satisfies InputEventLike, context)).toEqual({ action: "continue" });
    expect(appended).toHaveLength(1);
    expect(await handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "rm -rf ." } }, context)).toEqual({
      block: true, reason: "Blocked destructive command targeting a protected directory anchor",
    });

    await handlers.get("session_shutdown")?.[0]?.({}, context);
    expect(await input?.({ text: "unarmed", source: "rpc" } satisfies InputEventLike, context)).toEqual({ action: "handled" });
    expect(appended).toHaveLength(1);
  });

  it("scopes delivered turn identity to bash execution and restores the host environment", async () => {
    process.env.PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    process.env.PI_TOGETHER_GIT_COMMITTER_NAME = "Pi Together Bot";
    process.env.PI_TOGETHER_GIT_LAUNCHER = process.execPath;
    const commands = new Map<string, (args: string, context: Context) => unknown>();
    const handlers = new Map<string, Array<(event: unknown, context: Context) => unknown>>();
    type Context = { sessionManager: { getSessionId(): string }; model?: { provider: string; id: string } };
    const context: Context = { sessionManager: { getSessionId: () => "session_1" }, model: { provider: "synthetic", id: "model-1" } };
    const pi = {
      appendEntry() {},
      registerCommand: (name: string, options: { handler: (args: string, context: Context) => unknown }) => commands.set(name, options.handler),
      on: (event: string, handler: (event: unknown, context: Context) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    };
    piTogetherAttributionExtension(pi as unknown as Parameters<typeof piTogetherAttributionExtension>[0]);
    await handlers.get("session_start")?.[0]?.({}, context);
    const now = Date.now();
    const payload = {
      version: 1 as const, kind: "message" as const, sessionId: "session_1", requestId: "req_git_1",
      actor: { provider: "github" as const, subject: "12345", login: "octocat" }, action: "prompt" as const,
      viewerId: "viewer_a", issuedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 10_000).toISOString(),
      nonce: "nonce_git_123456789012", contentSha256: hashContent("make a commit"),
    };
    await commands.get(ARM_COMMAND)?.(encodeSignedEnvelope(signEnvelope(payload, privateKey)), context);
    await handlers.get("input")?.[0]?.({ text: "make a commit", source: "rpc" }, context);
    await handlers.get("message_start")?.[0]?.({ message: { role: "user" } }, context);
    const originalAuthor = originalEnvironment.GIT_AUTHOR_NAME;
    await handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "git status" } }, context);
    await handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "git diff" } }, context);
    expect(process.env.GIT_AUTHOR_NAME).toBe("octocat");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(process.env.GIT_COMMITTER_NAME).toBe("Pi Together Bot");
    expect(process.env.GIT_COMMITTER_EMAIL).toBe("");
    expect(process.env.PI_TOGETHER_MANAGED_GIT_AGENT).toBe("Pi (synthetic/model-1)");
    await handlers.get("tool_result")?.[0]?.({ toolName: "bash" }, context);
    expect(process.env.GIT_AUTHOR_NAME).toBe("octocat");
    await handlers.get("tool_result")?.[0]?.({ toolName: "bash" }, context);
    expect(process.env.GIT_AUTHOR_NAME).toBe(originalAuthor);
  });

  it("uses the email-less bot without reserving attribution commands in unmanaged local mode", async () => {
    process.env.PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    process.env.PI_TOGETHER_ATTRIBUTION_MANAGED = "0";
    process.env.PI_TOGETHER_GIT_LAUNCHER = process.execPath;
    const commands: string[] = [];
    const handlers = new Map<string, Array<(event: unknown, context: Context) => unknown>>();
    type Context = { sessionManager: { getSessionId(): string }; model?: { provider: string; id: string } };
    const context: Context = { sessionManager: { getSessionId: () => "local_session" }, model: { provider: "synthetic", id: "local-model" } };
    piTogetherAttributionExtension({
      appendEntry() {},
      registerCommand: (name) => { commands.push(name); },
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler as (event: unknown, context: Context) => unknown]),
    });
    expect(commands).toEqual([]);
    expect(handlers.has("input")).toBe(false);
    await handlers.get("session_start")?.[0]?.({}, context);
    await handlers.get("message_start")?.[0]?.({ message: { role: "user" } }, context);
    await handlers.get("tool_call")?.[0]?.({ toolName: "bash", input: { command: "git status" } }, context);
    expect(process.env.GIT_AUTHOR_NAME).toBe("Pi Together");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe("");
    expect(process.env.GIT_COMMITTER_NAME).toBe("Pi Together");
    await handlers.get("tool_result")?.[0]?.({ toolName: "bash" }, context);
  });

  it("refuses to initialize without a verification key", () => {
    delete process.env.PI_TOGETHER_ATTRIBUTION_PUBLIC_KEY;
    expect(() => piTogetherAttributionExtension({
      appendEntry() {},
      registerCommand() {},
      on() {},
    })).toThrow(/verification key/);
  });
});
