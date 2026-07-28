// tests/live.test.ts — the live agent-run loop over HTTP + SSE, against the deterministic fake.
// No paid model request is ever made; the fake streams a fixed sequence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonReq, openSse, startTestApp, type TestApp } from "./helpers.js";
import type { ChatConfig, ChatDetail } from "../shared/protocol.js";

let t: TestApp;
beforeEach(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await t.close();
});

const resume = (id: string, viewer: string) =>
  jsonReq(t.base, "/api/chats/resume", { method: "POST", body: JSON.stringify({ chatId: id, viewer }) });
const send = (id: string, viewer: string, text: string, mode = "normal") =>
  jsonReq<{ accepted: boolean; queued: boolean }>(t.base, `/api/chats/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ viewer, text, mode }),
  });

describe("live run loop", () => {
  it("send streams user turn → thinking → text deltas → tool → assistant → settled", async () => {
    await resume("c_beta", "vA");
    const sse = await openSse(t.base);
    const r = await send("c_beta", "vA", "list the files");
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: true, queued: false });

    await sse.waitFor((f) => f.event.type === "run.state" && f.event.state === "idle");
    const types = sse.frames.filter((f) => f.event.chatId === "c_beta").map((f) => f.event.type);
    expect(types).toContain("chat.turn"); // user + agent turns
    expect(types).toContain("msg.start");
    expect(types).toContain("thinking.delta");
    expect(types).toContain("msg.delta");
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.end");
    expect(types).toContain("msg.end");

    // assembled streamed text equals the final assistant turn text
    const streamed = sse.frames
      .filter((f) => f.event.type === "msg.delta")
      .map((f) => f.event.text as string)
      .join("");
    const end = sse.frames.find((f) => f.event.type === "msg.end")!;
    expect(end.event.text).toBe(streamed);
    sse.close();
  });

  it("steer while running queues and drains", async () => {
    await resume("c_beta", "vA");
    const sse = await openSse(t.base);
    await send("c_beta", "vA", "first");
    await sse.waitFor((f) => f.event.type === "run.state" && f.event.state === "running");
    const steer = await send("c_beta", "vA", "also do this", "steer");
    expect(steer.body.queued).toBe(true);
    const q = await sse.waitFor((f) => f.event.type === "queue" && (f.event.steering as string[]).length > 0);
    expect(q.event.steering).toContain("also do this");
    // the queued message runs after the first settles → a second run.state running occurs
    const runningCount = () => sse.frames.filter((f) => f.event.type === "run.state" && f.event.state === "running").length;
    await sse.waitFor(() => runningCount() >= 2, 4000);
    sse.close();
  });

  it("abort stops the run and clears the queue", async () => {
    await resume("c_beta", "vA");
    const sse = await openSse(t.base);
    await send("c_beta", "vA", "long task");
    await sse.waitFor((f) => f.event.type === "run.state" && f.event.state === "running");
    const ab = await jsonReq(t.base, "/api/chats/c_beta/abort", {
      method: "POST",
      body: JSON.stringify({ viewer: "vA" }),
    });
    expect(ab.status).toBe(200);
    await sse.waitFor((f) => f.event.type === "notice" && /abort/i.test(f.event.text as string));
    await sse.waitFor((f) => f.event.type === "run.state" && f.event.state === "idle");
    sse.close();
  });

  it("send requires the controller lease (409 for a non-holder)", async () => {
    await resume("c_alpha", "owner");
    const denied = await send("c_alpha", "intruder", "hi");
    expect(denied.status).toBe(409);
  });

  it("PATCH config changes model/thinking/toolMode", async () => {
    await resume("c_beta", "vA");
    const res = await jsonReq<{ config: ChatConfig }>(t.base, "/api/chats/c_beta/config", {
      method: "PATCH",
      body: JSON.stringify({ viewer: "vA", model: { provider: "example-ai", id: "example-fast" }, toolMode: "full" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.config.model?.id).toBe("example-fast");
    expect(res.body.config.toolMode).toBe("full");
    // The synthetic fast model is non-reasoning, so thinking levels collapse to ["off"].
    expect(res.body.config.thinkingLevels).toEqual(["off"]);
  });

  it("create refreshes available models, makes a new chat, and acquires its lease", async () => {
    const modelProbe = vi.spyOn(t.adapter, "models");
    const res = await jsonReq<{ chat: ChatDetail; models: Array<{ id: string }> }>(t.base, "/api/chats", {
      method: "POST",
      body: JSON.stringify({ workspaceRoot: "/home/example/projects/atlas", viewer: "vA" }),
    });
    expect(res.status).toBe(201);
    expect(modelProbe).toHaveBeenCalledWith(true);
    expect(res.body.models.length).toBeGreaterThan(0);
    expect(res.body.chat.lease).toMatchObject({
      actor: { provider: "github", subject: "1234567", login: "octocat" },
      isHolder: true,
    });
    expect(res.body.chat.workspaceRoot).toBe("/home/example/projects/atlas");
    expect(res.body.chat.origin).toBe("web"); // created here ⇒ web provenance
    expect(res.body.chat.live).toBe(true);
  });

  it("seeded (on-disk) sessions are external until taken over", async () => {
    const { body } = await jsonReq<{ chats: Array<{ id: string; origin: string; live: boolean }> }>(
      t.base,
      "/api/bootstrap",
    );
    const beta = body.chats.find((c) => c.id === "c_beta")!;
    expect(beta.origin).toBe("external");
    expect(beta.live).toBe(false);
    // taking over (resume) makes it live/drivable, but provenance stays external (no claiming)
    await resume("c_beta", "vA");
    const after = await jsonReq<{ chat: { origin: string; live: boolean } }>(t.base, "/api/chats/c_beta");
    expect(after.body.chat.live).toBe(true);
    expect(after.body.chat.origin).toBe("external");
  });

  it("bootstrap lists models from the adapter (never hard-coded)", async () => {
    const { body } = await jsonReq<{ models: Array<{ id: string }> }>(t.base, "/api/bootstrap");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((m) => m.id === "example-reasoner")).toBe(true);
  });
});

describe("SSE reconnect replay", () => {
  it("advertises a short native EventSource retry", async () => {
    const abort = new AbortController();
    const response = await fetch(`${t.base}/events`, { signal: abort.signal });
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("retry: 500");
    abort.abort();
  });

  it("replays only events after Last-Event-ID (no duplicates)", async () => {
    const sse = await openSse(t.base);
    await resume("c_beta", "vA");
    const statusFrame = await sse.waitFor((f) => f.event.type === "chat.status");
    const lastId = statusFrame.id!;
    sse.close();

    // reconnect with Last-Event-ID → we should NOT see the already-seen status frame again
    await jsonReq(t.base, "/api/chats/c_beta/rename", { method: "POST", body: JSON.stringify({ viewer: "vA", name: "after-reconnect" }) });
    const sse2 = await openSse(t.base, { lastEventId: lastId });
    const renamed = await sse2.waitFor((f) => f.event.type === "chat.updated");
    expect((renamed.event.chat as { name: string }).name).toBe("after-reconnect");
    expect(sse2.frames.every((f) => f.id == null || f.id > lastId)).toBe(true);
    sse2.close();
  });
});
