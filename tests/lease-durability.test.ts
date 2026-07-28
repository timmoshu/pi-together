import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../pi-adapter/fake.js";
import type { DurableLeaseEvent } from "../shared/protocol.js";
import { jsonReq, startTestApp, type TestApp } from "./helpers.js";

let running: TestApp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const resume = (app: TestApp, viewer: string, takeover = false) =>
  jsonReq(app.base, "/api/chats/resume", {
    method: "POST",
    body: JSON.stringify({ chatId: "c_alpha", viewer, takeover }),
  });

async function history(adapter: FakeAdapter): Promise<DurableLeaseEvent[]> {
  return (await adapter.getChat("c_alpha"))?.leaseHistory ?? [];
}

describe("durable lease transitions", () => {
  it("writes exactly one acquire/takeover/release event with previous and next controllers", async () => {
    running = await startTestApp();
    expect((await resume(running, "viewer_a")).status).toBe(200);
    expect((await resume(running, "viewer_a")).status).toBe(200); // exact renewal: no history event
    expect((await resume(running, "viewer_b", true)).status).toBe(200);
    expect((await jsonReq(running.base, "/api/chats/c_alpha/close", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewer_b" }),
    })).status).toBe(200);

    const events = await history(running.adapter);
    expect(events.map((event) => event.event)).toEqual(["acquired", "takenOver", "released"]);
    expect(events[0]).toMatchObject({ next: { actor: { subject: "1234567" }, viewerId: "viewer_a" } });
    expect(events[1]).toMatchObject({
      previous: { actor: { subject: "1234567" }, viewerId: "viewer_a" },
      next: { actor: { subject: "1234567" }, viewerId: "viewer_b" },
    });
    expect(events[2]).toMatchObject({ previous: { actor: { subject: "1234567" }, viewerId: "viewer_b" } });
    expect(new Set(events.map((event) => event.requestId)).size).toBe(3);
  });

  it("rolls back acquire and takeover when durable append fails", async () => {
    running = await startTestApp();
    const durable = vi.spyOn(running.adapter, "recordLeaseEvent").mockRejectedValueOnce(new Error("append failed"));
    expect((await resume(running, "viewer_a")).status).toBe(500);
    expect(running.app.lease.get("c_alpha")).toBeNull();
    expect(await history(running.adapter)).toEqual([]);

    durable.mockRestore();
    expect((await resume(running, "viewer_a")).status).toBe(200);
    const takeoverAppend = vi.spyOn(running.adapter, "recordLeaseEvent").mockRejectedValueOnce(new Error("takeover append failed"));
    expect((await resume(running, "viewer_b", true)).status).toBe(500);
    expect(running.app.lease.get("c_alpha", {
      principal: { provider: "github", subject: "1234567", login: "octocat" },
      viewerId: "viewer_a",
    })?.isHolder).toBe(true);
    expect((await history(running.adapter)).map((event) => event.event)).toEqual(["acquired"]);
    takeoverAppend.mockRestore();

    const detach = vi.spyOn(running.adapter, "detach");
    vi.spyOn(running.adapter, "recordLeaseEvent").mockRejectedValueOnce(new Error("release append failed"));
    expect((await jsonReq(running.base, "/api/chats/c_alpha/close", {
      method: "POST",
      body: JSON.stringify({ viewer: "viewer_a" }),
    })).status).toBe(500);
    expect(detach).not.toHaveBeenCalled();
    expect(running.app.lease.get("c_alpha", {
      principal: { provider: "github", subject: "1234567", login: "octocat" },
      viewerId: "viewer_a",
    })?.isHolder).toBe(true);
  });

  it("retries expiry append with one stable event and never restores the expired live lock", async () => {
    running = await startTestApp({ leaseTtlMs: 30, leaseReaperMs: 5 });
    expect((await resume(running, "viewer_a")).status).toBe(200);
    const append = vi.spyOn(running.adapter, "recordLeaseEvent").mockRejectedValueOnce(new Error("first expiry append failed"));

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !(await history(running.adapter)).some((event) => event.event === "expired")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = await history(running.adapter);
    expect(events.map((event) => event.event)).toEqual(["acquired", "expired"]);
    expect(events[1]).toMatchObject({ previous: { actor: { subject: "1234567" }, viewerId: "viewer_a" } });
    const expiryAttempts = append.mock.calls.map((call) => call[1]).filter((event) => event.event === "expired");
    expect(expiryAttempts).toHaveLength(2);
    expect(new Set(expiryAttempts.map((event) => event.requestId)).size).toBe(1);
    expect(running.app.lease.get("c_alpha")).toBeNull();
  });

  it("flushes a just-observed expiry before granting a new controller", async () => {
    running = await startTestApp({ leaseTtlMs: 20, leaseReaperMs: 10_000 });
    expect((await resume(running, "viewer_a")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await resume(running, "viewer_b")).status).toBe(200);
    const events = await history(running.adapter);
    expect(events.map((event) => event.event)).toEqual(["acquired", "expired", "acquired"]);
    expect(events[1]?.previous?.viewerId).toBe("viewer_a");
    expect(events[2]?.next?.viewerId).toBe("viewer_b");
  });

  it("treats held durable history as stale after restart and records recovery on the next grant", async () => {
    const adapter = new FakeAdapter();
    running = await startTestApp({ adapter });
    expect((await resume(running, "viewer_a")).status).toBe(200);
    expect((await history(adapter)).map((event) => event.event)).toEqual(["acquired"]);
    await running.close(); // process-local lease disappears without claiming a graceful release
    running = undefined;

    running = await startTestApp({
      adapter,
      security: {
        mode: "test",
        principal: { provider: "github", subject: "7654321", login: "hubot" },
      },
    });
    const before = await jsonReq(running.base, "/api/chats/c_alpha");
    expect(before.status).toBe(200); // durable history never acts as a live lock
    expect(running.app.lease.get("c_alpha")).toBeNull();
    expect((await resume(running, "viewer_b")).status).toBe(200);

    const events = await history(adapter);
    expect(events.map((event) => event.event)).toEqual(["acquired", "recovered"]);
    expect(events[1]).toMatchObject({
      previous: { actor: { subject: "1234567", login: "octocat" }, viewerId: "viewer_a" },
      next: { actor: { subject: "7654321", login: "hubot" }, viewerId: "viewer_b" },
    });
  });
});
