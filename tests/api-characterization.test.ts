import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseInfo } from "../shared/protocol.js";
import { jsonReq, startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

const resume = (viewer: string) =>
  jsonReq(t.base, "/api/chats/resume", {
    method: "POST",
    body: JSON.stringify({ chatId: "c_beta", viewer }),
  });

const send = (viewer: string, text: string, mode: "normal" | "steer" | "followUp" = "normal") =>
  jsonReq<{ accepted: boolean; queued: boolean }>(t.base, "/api/chats/c_beta/messages", {
    method: "POST",
    body: JSON.stringify({ viewer, text, mode }),
  });

describe("mutation-route lease characterization", () => {
  it("queues follow-up through the holder and reports 202", async () => {
    await resume("holder");
    expect((await send("holder", "first")).status).toBe(202);

    const followUp = await send("holder", "then summarize", "followUp");
    expect(followUp.status).toBe(202);
    expect(followUp.body).toEqual({ accepted: true, queued: true });
  });

  it("rejects abort and config mutations from a non-holder with 409", async () => {
    await resume("holder");

    const abort = await jsonReq<{ error: string; lease: LeaseInfo }>(t.base, "/api/chats/c_beta/abort", {
      method: "POST",
      body: JSON.stringify({ viewer: "other" }),
    });
    expect(abort.status).toBe(409);
    expect(abort.body).toMatchObject({
      error: "chat is controlled by another viewer",
      lease: { actor: { provider: "github", subject: "1234567", login: "octocat" } },
    });
    expect(abort.body.lease).not.toHaveProperty("viewerId");
    expect(abort.body.lease).not.toHaveProperty("isHolder");

    const config = await jsonReq(t.base, "/api/chats/c_beta/config", {
      method: "PATCH",
      body: JSON.stringify({ viewer: "other", thinking: "low" }),
    });
    expect(config.status).toBe(409);
    expect(config.body).toMatchObject({ error: "chat is controlled by another viewer" });
  });

  it("rejects rename, compact, and extension UI mutations from a non-holder", async () => {
    await resume("holder");

    const attempts = [
      ["/api/chats/c_beta/rename", { viewer: "other", name: "must not rename" }],
      ["/api/chats/c_beta/compact", { viewer: "other" }],
      ["/api/chats/c_beta/extension-ui-response", { viewer: "other", requestId: "ext-1", cancelled: true }],
    ] as const;
    for (const [path, body] of attempts) {
      const response = await jsonReq(t.base, path, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: "chat is controlled by another viewer" });
    }
  });

  it("permits rename, compact, and extension UI mutations for the exact holder", async () => {
    await resume("holder");
    expect((await jsonReq(t.base, "/api/chats/c_beta/rename", {
      method: "POST",
      body: JSON.stringify({ viewer: "holder", name: "holder rename" }),
    })).status).toBe(200);
    expect((await jsonReq(t.base, "/api/chats/c_beta/compact", {
      method: "POST",
      body: JSON.stringify({ viewer: "holder" }),
    })).status).toBe(200);
    const extensionResponse = vi.spyOn(t.adapter, "extensionUiResponse");
    expect((await jsonReq(t.base, "/api/chats/c_beta/extension-ui-response", {
      method: "POST",
      body: JSON.stringify({ viewer: "holder", requestId: "ext-1", cancelled: true }),
    })).status).toBe(200);
    expect(extensionResponse).toHaveBeenCalledWith("c_beta", "ext-1", { requestId: "ext-1", cancelled: true });
  });

  it("opens an allowed workspace as a new controlled chat", async () => {
    const response = await jsonReq<{ chat: { id: string; lease: LeaseInfo } }>(t.base, "/api/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ root: "/home/example/projects/atlas", viewer: "holder" }),
    });
    expect(response.status).toBe(201);
    expect(response.body.chat.lease).toMatchObject({
      actor: { provider: "github", subject: "1234567", login: "octocat" },
      isHolder: true,
    });
    expect(t.app.lease.get(response.body.chat.id)).toMatchObject({ actor: { subject: "1234567" } });
  });
});
