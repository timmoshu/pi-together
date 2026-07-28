import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonReq, startTestApp, type TestApp } from "./helpers.js";
import type { BootstrapPayload, ChatSummary } from "../shared/protocol.js";

let t: TestApp;
beforeEach(async () => {
  t = await startTestApp();
});
afterEach(async () => {
  await t.close();
});

describe("api", () => {
  it("GET /api/health → 200", async () => {
    const { status, body } = await jsonReq<{ ok: boolean; adapter: string }>(t.base, "/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, adapter: "fake" });
  });

  it("GET /api/bootstrap returns owner, chats and catalog", async () => {
    const { status, body } = await jsonReq<BootstrapPayload>(t.base, "/api/bootstrap");
    expect(status).toBe(200);
    expect(body.owner).toBe("octocat");
    expect(body.adapter).toBe("fake");
    expect(body.chats.length).toBeGreaterThan(0);
    expect(body.catalog.length).toBeGreaterThan(0);
  });

  it("can hydrate the rail before loading models", async () => {
    const boot = await jsonReq<BootstrapPayload>(t.base, "/api/bootstrap?models=0");
    expect(boot.status).toBe(200);
    expect(boot.body.chats.length).toBeGreaterThan(0);
    expect(boot.body.models).toEqual([]);

    const models = await jsonReq<{ models: Array<{ id: string }> }>(t.base, "/api/models");
    expect(models.status).toBe(200);
    expect(models.body.models.length).toBeGreaterThan(0);
  });

  it("resume acquires a lease; passive conflicts are blocked but explicit takeover transfers it", async () => {
    const first = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerA" }),
    });
    expect(first.status).toBe(200);
    expect(first.body.chat.lease).toMatchObject({
      actor: { provider: "github", subject: "1234567", login: "octocat" },
      isHolder: true,
    });
    expect(first.body.chat.status).toBe("waiting"); // resume attaches a runtime; idle-but-ready

    const second = await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerB" }),
    });
    expect(second.status).toBe(409);

    const takeover = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerB", takeover: true }),
    });
    expect(takeover.status).toBe(200);
    expect(takeover.body.chat.lease?.isHolder).toBe(true);
  });

  it("close detaches the runtime, releases the lease, and preserves the session", async () => {
    await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_beta", viewer: "viewerA" }),
    });
    const blocked = await jsonReq(t.base, "/api/chats/c_beta/close", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewerB" }),
    });
    expect(blocked.status).toBe(409);

    const closed = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/c_beta/close", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewerA" }),
    });
    expect(closed.status).toBe(200);
    expect(closed.body.chat.live).toBe(false);
    expect(closed.body.chat.lease).toBeNull();

    const preserved = await jsonReq<{ chat: { turns: unknown[] } }>(t.base, "/api/chats/c_beta");
    expect(preserved.body.chat.turns.length).toBeGreaterThan(0);

    const retake = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_beta", viewer: "viewerB" }),
    });
    expect(retake.status).toBe(200);
    expect(retake.body.chat.lease?.isHolder).toBe(true);
  });

  it("rename changes the chat name", async () => {
    await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerA" }),
    });
    const { status, body } = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/c_alpha/rename", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewerA", name: "renamed!" }),
    });
    expect(status).toBe(200);
    expect(body.chat.name).toBe("renamed!");
  });

  it("compact reduces the turn count", async () => {
    const before = await jsonReq<{ chat: { turns: unknown[] } }>(t.base, "/api/chats/c_alpha");
    // seed one extra turn via resume so compaction has something to trim
    await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "v" }),
    });
    const { body } = await jsonReq<{ chat: ChatSummary }>(t.base, "/api/chats/c_alpha/compact", {
      method: "POST",
      body: JSON.stringify({ viewer: "v" }),
    });
    expect(body.chat.turnCount).toBeLessThanOrEqual(before.body.chat.turns.length + 1);
    expect(body.chat.turnCount).toBe(2);
  });

  it("threads the authenticated GitHub actor and viewer into message attribution", async () => {
    await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerA" }),
    });
    const send = vi.spyOn(t.adapter, "send");
    const result = await jsonReq(t.base, "/api/chats/c_alpha/messages", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewerA", text: "attributed prompt", mode: "normal" }),
    });
    expect(result.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      "c_alpha",
      "attributed prompt",
      "normal",
      expect.objectContaining({
        requestId: expect.stringMatching(/^req_/),
        actor: { provider: "github", subject: "1234567", login: "octocat" },
        viewerId: "viewerA",
      }),
    );
  });

  it("404 on unknown chat without leaving a phantom lease", async () => {
    expect((await jsonReq(t.base, "/api/chats/nope")).status).toBe(404);
    expect((await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "nope", viewer: "viewerA", takeover: true }),
    })).status).toBe(404);
    expect(t.app.lease.get("nope")).toBeNull();
  });

  it("400 on invalid resume body (zod)", async () => {
    const { status } = await jsonReq(t.base, "/api/chats/resume", {
      method: "POST",
      body: JSON.stringify({ chatId: "" }),
    });
    expect(status).toBe(400);
  });
});

describe("api request principals", () => {
  it("requires the reverse-proxy secret and canonical login together", async () => {
    const principal = { provider: "github" as const, subject: "1234567", login: "octocat" };
    const secret = "s".repeat(43);
    const prod = await startTestApp({
      security: {
        mode: "reverse-proxy",
        proxySecret: secret,
        principalsByLogin: new Map([[principal.login, principal]]),
      },
    });
    try {
      expect((await jsonReq(prod.base, "/api/health")).status).toBe(401);
      expect((await jsonReq(prod.base, "/api/health", {
        headers: { "x-pi-together-proxy-secret": secret },
      })).status).toBe(401);
      const ok = await jsonReq(prod.base, "/api/health", {
        headers: {
          "x-pi-together-proxy-secret": secret,
          "x-pi-together-login": principal.login,
        },
      });
      expect(ok.status).toBe(200);
    } finally {
      await prod.close();
    }
  });

  it("rejects an unsafe request without exact Origin before adapter side effects", async () => {
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
    const rename = vi.spyOn(prod.adapter, "rename");
    const headers = {
      "x-pi-together-proxy-secret": secret,
      "x-pi-together-login": principal.login,
    };
    try {
      expect((await jsonReq(prod.base, "/api/chats/c_alpha/rename", {
        method: "POST",
        headers,
        body: JSON.stringify({ viewer: "viewerA", name: "must not apply" }),
      })).status).toBe(403);
      expect(rename).not.toHaveBeenCalled();

      expect((await jsonReq(prod.base, "/api/chats/resume", {
        method: "POST",
        headers: { ...headers, origin: "https://agents.example.com" },
        body: JSON.stringify({ chatId: "c_alpha", viewer: "viewerA" }),
      })).status).toBe(200);
      expect((await jsonReq(prod.base, "/api/chats/c_alpha/rename", {
        method: "POST",
        headers: { ...headers, origin: "https://agents.example.com" },
        body: JSON.stringify({ viewer: "viewerA", name: "allowed rename" }),
      })).status).toBe(200);
      expect(rename).toHaveBeenCalledOnce();
    } finally {
      await prod.close();
    }
  });

  it("threads identity-only request context without serializing security config", async () => {
    const contexts: unknown[] = [];
    const secret = "not-returned-" + "s".repeat(43);
    const principal = { provider: "github" as const, subject: "1234567", login: "octocat" };
    const prod = await startTestApp({
      security: {
        mode: "reverse-proxy",
        proxySecret: secret,
        principalsByLogin: new Map([[principal.login, principal]]),
      },
      onRequestContext: (context) => contexts.push(context),
    });
    try {
      const result = await jsonReq(prod.base, "/api/bootstrap", {
        headers: {
          "x-pi-together-proxy-secret": secret,
          "x-pi-together-login": principal.login,
        },
      });
      expect(result.status).toBe(200);
      expect(contexts).toEqual([{ principal }]);
      expect(JSON.stringify(result.body)).not.toContain(secret);
      expect(result.body).not.toHaveProperty("security");
    } finally {
      await prod.close();
    }
  });

  it("sets restrictive browser headers without enabling CORS", async () => {
    const response = await fetch(t.base + "/api/health", { headers: { origin: "https://evil.invalid" } });
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const staticResponse = await fetch(t.base + "/");
    expect(staticResponse.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(staticResponse.headers.get("access-control-allow-origin")).toBeNull();
  });
});
