import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatDetail } from "../shared/protocol.js";
import { jsonReq, openSse, startTestApp, type TestApp } from "./helpers.js";

describe("browser collaboration boundary", () => {
  let app: TestApp;
  beforeEach(async () => { app = await startTestApp(); });
  afterEach(async () => { await app.close(); });

  it("keeps durable viewer IDs out of chat JSON and SSE frames", async () => {
    const stream = await openSse(app.base);
    try {
      await jsonReq(app.base, "/api/chats/resume", {
        method: "POST",
        body: JSON.stringify({ chatId: "c_alpha", viewer: "viewer_private_a" }),
      });
      await jsonReq(app.base, "/api/chats/c_alpha/messages", {
        method: "POST",
        body: JSON.stringify({ viewer: "viewer_private_a", text: "boundary prompt", mode: "normal" }),
      });
      const turn = await stream.waitFor((frame) => frame.event.type === "chat.turn");

      await jsonReq(app.base, "/api/chats/resume", {
        method: "POST",
        body: JSON.stringify({ chatId: "c_alpha", viewer: "viewer_private_b", takeover: true }),
      });
      const takeover = await stream.waitFor((frame) =>
        frame.event.type === "lease.history"
          && (frame.event.event as { event?: string } | undefined)?.event === "takenOver",
      );
      expect((takeover.event.event as { sameActorViewerChanged?: boolean }).sameActorViewerChanged).toBe(true);

      const detail = await jsonReq<{ chat: ChatDetail }>(
        app.base,
        "/api/chats/c_alpha?viewer=viewer_private_b",
      );

      for (const browserValue of [turn.event, takeover.event, detail.body]) {
        const serialized = JSON.stringify(browserValue);
        expect(serialized).not.toContain("viewer_private_a");
        expect(serialized).not.toContain("viewer_private_b");
        expect(serialized).not.toContain("viewerId");
      }

      const durable = await app.adapter.getChat("c_alpha");
      expect(JSON.stringify(durable)).toContain("viewer_private_a");
      expect(JSON.stringify(durable)).toContain("viewer_private_b");
    } finally {
      stream.close();
    }
  });
});
