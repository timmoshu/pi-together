// tests/runtime.test.ts — the rpc→ServerEvent bridge, driven by a canned fake `pi` (no real pi).
// Pins the fix for the duplicate user message: pi emits message_end for BOTH the user and assistant
// messages, but the runtime must only turn the ASSISTANT one into a transcript turn.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AttributionSigner } from "../pi-adapter/attribution-signer.js";
import { PiRuntime } from "../pi-adapter/runtime.js";
import type { ServerEvent } from "../shared/protocol.js";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");

async function runPrompt(message: string): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const rt = new PiRuntime({ piBin: FAKE_PI, sessionId: "s1", sessionDir: "/tmp", responseTimeoutMs: 4000 });
  rt.subscribe((e) => events.push(e));
  await rt.prompt(message);
  await new Promise((r) => setTimeout(r, 300)); // let the canned event stream drain
  await rt.close();
  return events;
}

describe("PiRuntime rpc bridge", () => {
  it("does NOT duplicate the user message (only the assistant becomes a transcript turn)", async () => {
    const events = await runPrompt("is this working properly now?");
    const turns = events.filter((e) => e.type === "chat.turn") as Extract<ServerEvent, { type: "chat.turn" }>[];
    // exactly one transcript turn, and it is the assistant's reply — the user turn is surfaced by send()
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turn.role).toBe("agent");
    expect(turns.some((t) => t.turn.role === "user")).toBe(false);
  });

  it("normalizes streaming thinking + text + settle", async () => {
    const events = await runPrompt("hi");
    const types = events.map((e) => e.type);
    expect(types.filter((type) => type === "msg.start")).toHaveLength(1); // assistant only, not user/toolResult
    expect(types).toContain("thinking.delta");
    expect(types).toContain("msg.delta");
    expect(events.find((e) => e.type === "msg.end")).toMatchObject({ type: "msg.end", thinking: "pondering" });
    expect(events.some((e) => e.type === "run.state" && e.state === "idle")).toBe(true); // agent_settled
  });

  it("cancels a blocking extension request before aborting the agent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-abort-"));
    const log = join(directory, "rpc.jsonl");
    const events: ServerEvent[] = [];
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 1000,
      env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_BLOCK_ON_EXTENSION: "1" },
    });
    rt.subscribe((event) => events.push(event));

    await rt.prompt("request permission");
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "ext.request", requestId: "permission_1",
    })));
    await expect(rt.abort("permission_1")).resolves.toMatchObject({ command: "abort", success: true });
    const commands = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).filter((record) => record.kind === "command").map((record) => record.command);
    expect(commands.slice(-2)).toEqual([
      { type: "extension_ui_response", id: "permission_1", cancelled: true },
      expect.objectContaining({ type: "abort" }),
    ]);
    await rt.close();
  });

  it("writes extension UI responses as no-ack protocol frames", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-extension-ui-"));
    const log = join(directory, "rpc.jsonl");
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 100,
      env: { ...process.env, FAKE_PI_LOG: log },
    });

    await expect(rt.extensionUiResponse("permission_1", { confirmed: true })).resolves.toBeUndefined();
    await vi.waitFor(() => {
      const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toContainEqual({
        kind: "command",
        command: { type: "extension_ui_response", id: "permission_1", confirmed: true },
      });
    });
    await rt.close();
  });

  it("arms and verifies attributed prompt/steer/follow-up using only RPC prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-"));
    const log = join(directory, "rpc.jsonl");
    const signer = new AttributionSigner();
    const extensionPath = join(directory, "pi-together-attribution-v1.js");
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 4000,
      env: { ...process.env, FAKE_PI_LOG: log },
      attribution: {
        extensionPath,
        publicKey: signer.publicKey,
        gitIdentity: { committerName: "Pi Together Bot", committerEmail: "", launcherPath: "/opt/pi-together/git-bin/git" },
      },
    });
    const actor = { provider: "github" as const, subject: "12345", login: "octocat" };
    for (const [action, text, behavior] of [
      ["prompt", "normal input", undefined],
      ["steer", "steering input", "steer"],
      ["followUp", "follow-up input", "followUp"],
    ] as const) {
      const requestId = `req_${action}`;
      const arm = signer.messageArm({ sessionId: "session_1", requestId, actor, action, viewerId: "viewer_a", text });
      await rt.sendAttributed(arm, requestId, text, behavior);
    }
    const leaseRequestId = "lease_acquired";
    const lease = signer.leaseEvent({
      sessionId: "session_1",
      requestId: leaseRequestId,
      event: "acquired",
      next: { actor, viewerId: "viewer_a" },
    });
    await rt.appendAttributedLease(lease, leaseRequestId);
    const durable = await rt.getEntries();
    expect(durable.entries).toHaveLength(4);
    await rt.close();

    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const startup = records.find((record) => record.kind === "startup");
    expect(startup.hasPrivateKey).toBe(false);
    expect(startup.gitCommitterName).toBe("Pi Together Bot");
    expect(startup.gitCommitterEmail).toBe("");
    expect(startup.gitLauncher).toBe("/opt/pi-together/git-bin/git");
    expect(startup.args).toContain("-e");
    const commands = records.filter((record) => record.kind === "command").map((record) => record.command);
    expect(commands.some((command) => command.type === "steer" || command.type === "follow_up")).toBe(false);
    expect(commands.filter((command) => command.type === "prompt" && !String(command.message).startsWith("/pi-together-arm-v1")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "normal input" }),
        expect.objectContaining({ message: "steering input", streamingBehavior: "steer" }),
        expect.objectContaining({ message: "follow-up input", streamingBehavior: "followUp" }),
      ]));
  });

  it("serializes concurrent arm/consume operations so envelopes cannot cross", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-concurrent-"));
    const signer = new AttributionSigner();
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 4000,
      attribution: { extensionPath: join(directory, "pi-together-attribution-v1.js"), publicKey: signer.publicKey },
    });
    const actor = { provider: "github" as const, subject: "12345", login: "octocat" };
    const sends = ["first concurrent input", "second concurrent input"].map((text, index) => {
      const requestId = `req_concurrent_${index}`;
      const arm = signer.messageArm({ sessionId: "session_1", requestId, actor, action: "prompt", viewerId: "viewer_a", text });
      return rt.sendAttributed(arm, requestId, text);
    });
    await expect(Promise.all(sends)).resolves.toHaveLength(2);
    expect((await rt.getEntries()).entries).toHaveLength(2);
    await rt.close();
  });

  it.each([
    ["wrong source", { FAKE_PI_BAD_SOURCE: "1" }, /wrong source/],
    ["duplicate command", { FAKE_PI_DUPLICATE_COMMAND: "1" }, /duplicated/],
    ["missing marker", { FAKE_PI_DROP_ATTRIBUTION: "1" }, /did not persist/],
    ["content rejection", { FAKE_PI_FAIL_CONTENT: "1" }, /synthetic content rejection/],
  ])("fails closed for %s", async (_name, extraEnv, error) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-fail-"));
    const signer = new AttributionSigner();
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 4000,
      env: { ...process.env, ...extraEnv },
      attribution: { extensionPath: join(directory, "pi-together-attribution-v1.js"), publicKey: signer.publicKey },
    });
    const text = "blocked input";
    const requestId = "req_blocked";
    const arm = signer.messageArm({
      sessionId: "session_1",
      requestId,
      actor: { provider: "github", subject: "12345", login: "octocat" },
      action: "prompt",
      viewerId: "viewer_a",
      text,
    });
    await expect(rt.sendAttributed(arm, requestId, text)).rejects.toThrow(error);
    expect(rt.isAlive).toBe(false);
    await rt.close();
  });

  it("recovers a lost content response by reading back the durable marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-recover-"));
    const signer = new AttributionSigner();
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 1000,
      env: { ...process.env, FAKE_PI_DROP_CONTENT_RESPONSE: "1" },
      attribution: { extensionPath: join(directory, "pi-together-attribution-v1.js"), publicKey: signer.publicKey },
    });
    const text = "accepted before response loss";
    const requestId = "req_recovered";
    const arm = signer.messageArm({
      sessionId: "session_1",
      requestId,
      actor: { provider: "github", subject: "12345", login: "octocat" },
      action: "prompt",
      viewerId: "viewer_a",
      text,
    });
    await expect(rt.sendAttributed(arm, requestId, text)).resolves.toMatchObject({ data: { recovered: true } });
    expect((await rt.getEntries()).entries).toHaveLength(1);
    await rt.close();
  });

  it("rejects installed extension command text before arming", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-runtime-command-"));
    const signer = new AttributionSigner();
    const rt = new PiRuntime({
      piBin: FAKE_PI,
      sessionId: "session_1",
      sessionDir: directory,
      responseTimeoutMs: 4000,
      attribution: { extensionPath: join(directory, "pi-together-attribution-v1.js"), publicKey: signer.publicKey },
    });
    const text = "/other-command do something";
    const requestId = "req_command";
    const arm = signer.messageArm({
      sessionId: "session_1",
      requestId,
      actor: { provider: "github", subject: "12345", login: "octocat" },
      action: "prompt",
      viewerId: "viewer_a",
      text,
    });
    await expect(rt.sendAttributed(arm, requestId, text)).rejects.toThrow(/extension commands/);
    await rt.close();
  });
});
