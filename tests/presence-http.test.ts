import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSse, startTestApp, type TestApp } from "./helpers.js";

describe("SSE session presence", () => {
  let testApp: TestApp;
  beforeEach(async () => { testApp = await startTestApp(); });
  afterEach(async () => { await testApp.close(); });

  it("associates an authenticated SSE subscription with a session and clears it on disconnect", async () => {
    const observer = await openSse(testApp.base);
    const participant = await openSse(testApp.base, { chatId: "c_alpha", viewerId: "viewer-one", presenceOnly: true });
    const joined = await observer.waitFor((frame) => frame.event.type === "chat.presence"
      && frame.event.chatId === "c_alpha"
      && Array.isArray(frame.event.participants)
      && frame.event.participants.length === 1);
    expect(joined.event).toMatchObject({
      participants: [{ actor: { provider: "github", subject: "1234567", login: "octocat" }, viewerCount: 1 }],
    });
    expect(JSON.stringify(joined.event)).not.toContain("viewer-one");
    await testApp.app.registry.broadcast({ type: "chat.status", chatId: "c_alpha", status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(participant.frames.some((frame) => frame.event.type === "chat.status")).toBe(false);

    participant.close();
    const left = await observer.waitFor((frame) => frame.event.type === "chat.presence"
      && frame.event.chatId === "c_alpha"
      && Array.isArray(frame.event.participants)
      && frame.event.participants.length === 0);
    expect(Number(left.event.revision)).toBeGreaterThan(Number(joined.event.revision));
    observer.close();
  });

  it("requires exact Origin before public presence subscription side effects", async () => {
    const principal = { provider: "github" as const, subject: "1234567", login: "octocat" };
    const secret = "s".repeat(43);
    const prod = await startTestApp({
      security: {
        mode: "reverse-proxy",
        proxySecret: secret,
        principalsByLogin: new Map([[principal.login, principal]]),
      },
      origin: "https://agents.example.com",
    });
    try {
      const response = await fetch(`${prod.base}/events?chatId=c_alpha&viewer=viewer-one&presenceOnly=1`, {
        headers: {
          "x-pi-together-proxy-secret": secret,
          "x-pi-together-login": principal.login,
        },
      });
      const status = response.status;
      await response.body?.cancel();
      expect(status).toBe(403);
      expect(prod.app.presence.manager.snapshot("c_alpha").participants).toEqual([]);

      const allowed = await openSse(prod.base, {
        chatId: "c_alpha",
        viewerId: "viewer-one",
        presenceOnly: true,
        headers: {
          "x-pi-together-proxy-secret": secret,
          "x-pi-together-login": principal.login,
          origin: "https://agents.example.com",
        },
      });
      await allowed.waitFor((frame) => frame.event.type === "chat.presence");
      allowed.close();
    } finally {
      await prod.close();
    }
  });

  it("refuses malformed or unauthorized session subscriptions without creating presence", async () => {
    const malformed = await fetch(`${testApp.base}/events?chatId=c_alpha&viewer=${"x".repeat(129)}`);
    expect(malformed.status).toBe(400);
    const missing = await fetch(`${testApp.base}/events?chatId=does-not-exist&viewer=viewer-one`);
    expect(missing.status).toBe(404);
    expect(testApp.app.presence.manager.snapshot("c_alpha").participants).toEqual([]);
  });
});
