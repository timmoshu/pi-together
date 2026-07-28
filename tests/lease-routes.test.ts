import { afterEach, describe, expect, it } from "vitest";
import type { ChatDetail, LeaseInfo } from "../shared/protocol.js";
import { jsonReq, startTestApp, type TestApp } from "./helpers.js";

const secret = "s".repeat(43);
const origin = "https://agents.example.com";
const alice = { provider: "github" as const, subject: "1001", login: "alice" };
const bob = { provider: "github" as const, subject: "2002", login: "bob" };
let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const headers = (login: string) => ({
  "x-pi-together-proxy-secret": secret,
  "x-pi-together-login": login,
  origin,
});

describe("principal-aware mutation route matrix", () => {
  it("never acquires control through passive reads or an unheld mutation", async () => {
    app = await startTestApp();
    expect((await jsonReq(app.base, "/api/bootstrap")).status).toBe(200);
    expect((await jsonReq(app.base, "/api/chats")).status).toBe(200);
    expect((await jsonReq(app.base, "/api/chats/c_alpha?viewer=viewer_a")).status).toBe(200);
    expect(app.app.lease.get("c_alpha")).toBeNull();

    const rename = await jsonReq(app.base, "/api/chats/c_alpha/rename", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewer_a", name: "must not acquire" }),
    });
    expect(rename.status).toBe(409);
    expect(rename.body).toMatchObject({ lease: null });
    expect(app.app.lease.get("c_alpha")).toBeNull();
  });

  it("allows passive reads but denies every session mutation to another principal", async () => {
    app = await startTestApp({
      origin,
      security: {
        mode: "reverse-proxy",
        proxySecret: secret,
        principalsByLogin: new Map([[alice.login, alice], [bob.login, bob]]),
      },
    });
    const acquired = await jsonReq(app.base, "/api/chats/resume", {
      method: "POST",
      headers: headers(alice.login),
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewer_shared" }),
    });
    expect(acquired.status).toBe(200);

    const passive = await jsonReq<{ chat: ChatDetail }>(app.base, "/api/chats/c_alpha?viewer=viewer_shared", {
      headers: headers(bob.login),
    });
    expect(passive.status).toBe(200);
    expect(passive.body.chat.lease).toMatchObject({ actor: alice });
    expect(passive.body.chat.lease).not.toHaveProperty("isHolder");

    const attempts = [
      ["/api/chats/c_alpha/messages", { viewer: "viewer_shared", text: "blocked", mode: "normal" }],
      ["/api/chats/c_alpha/abort", { viewer: "viewer_shared" }],
      ["/api/chats/c_alpha/config", { viewer: "viewer_shared", thinking: "low" }, "PATCH"],
      ["/api/chats/c_alpha/rename", { viewer: "viewer_shared", name: "blocked" }],
      ["/api/chats/c_alpha/compact", { viewer: "viewer_shared" }],
      ["/api/chats/c_alpha/close", { viewer: "viewer_shared" }],
      ["/api/chats/c_alpha/extension-ui-response", { viewer: "viewer_shared", requestId: "ext_1", cancelled: true }],
      ["/api/chats/c_alpha/heartbeat", { viewer: "viewer_shared" }],
    ] as const;
    for (const [path, body, method = "POST"] of attempts) {
      const response = await jsonReq(app.base, path, {
        method,
        headers: headers(bob.login),
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(409);
      expect(response.body, path).toMatchObject({
        error: "chat is controlled by another viewer",
        lease: { actor: alice },
      });
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("viewer_shared");
      expect(serialized).not.toContain("viewer_other");
    }
  });

  it("keeps same-principal different-viewer conflicts visible and supports explicit takeover", async () => {
    app = await startTestApp({
      origin,
      security: {
        mode: "reverse-proxy",
        proxySecret: secret,
        principalsByLogin: new Map([[alice.login, alice], [bob.login, bob]]),
      },
    });
    await jsonReq(app.base, "/api/chats/resume", {
      method: "POST",
      headers: headers(alice.login),
      body: JSON.stringify({ chatId: "c_beta", viewer: "viewer_a" }),
    });
    const sibling = await jsonReq<{ lease: LeaseInfo }>(app.base, "/api/chats/c_beta/heartbeat", {
      method: "POST",
      headers: headers(alice.login),
      body: JSON.stringify({ viewer: "viewer_b" }),
    });
    expect(sibling.status).toBe(409);
    expect(sibling.body.lease).toMatchObject({ actor: alice });
    expect(JSON.stringify(sibling.body)).not.toContain("viewer_a");

    const takeover = await jsonReq<{ chat: ChatDetail }>(app.base, "/api/chats/resume", {
      method: "POST",
      headers: headers(bob.login),
      body: JSON.stringify({ chatId: "c_beta", viewer: "viewer_b", takeover: true }),
    });
    expect(takeover.status).toBe(200);
    expect(takeover.body.chat.lease).toMatchObject({ actor: bob, isHolder: true });
    const heartbeat = await jsonReq<{ lease: LeaseInfo }>(app.base, "/api/chats/c_beta/heartbeat", {
      method: "POST",
      headers: headers(bob.login),
      body: JSON.stringify({ viewer: "viewer_b" }),
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.lease).toMatchObject({ actor: bob, isHolder: true });
  });
});
