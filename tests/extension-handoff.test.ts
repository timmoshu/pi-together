import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../pi-adapter/fake.js";
import type { ChatDetail } from "../shared/protocol.js";
import { jsonReq, startTestApp } from "./helpers.js";

describe("extension request handoff", () => {
  it("keeps a pending request in snapshots and clears it for every subscriber after response", async () => {
    const adapter = new FakeAdapter();
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    adapter.emitForTest({
      type: "ext.request",
      chatId: "c_alpha",
      requestId: "ext_1",
      method: "confirm",
      title: "Continue?",
    });
    expect((await adapter.getChat("c_alpha"))?.pendingExtension).toMatchObject({ requestId: "ext_1" });
    expect(JSON.stringify(await adapter.listChats())).not.toContain("pendingExtension");
    expect(JSON.stringify(await adapter.listChats())).not.toContain("Continue?");

    await adapter.extensionUiResponse("c_alpha", "ext_1", { requestId: "ext_1", confirmed: true });
    expect((await adapter.getChat("c_alpha"))?.pendingExtension).toBeUndefined();
    expect(events).toContain("ext.clear");
    await adapter.close();
  });

  it("clears a pending request when the run is stopped", async () => {
    const adapter = new FakeAdapter();
    adapter.emitForTest({
      type: "ext.request", chatId: "c_alpha", requestId: "ext_abort", method: "confirm", title: "Allow?",
    });

    await adapter.abort("c_alpha");
    expect((await adapter.getChat("c_alpha"))?.pendingExtension).toBeUndefined();
    await adapter.close();
  });

  it("keeps the request available to a takeover holder and clears every snapshot after response", async () => {
    const app = await startTestApp();
    try {
      await jsonReq(app.base, "/api/chats/resume", {
        method: "POST", body: JSON.stringify({ chatId: "c_alpha", viewer: "viewer_a" }),
      });
      app.adapter.emitForTest({
        type: "ext.request", chatId: "c_alpha", requestId: "ext_2", method: "input", title: "Value",
      });
      const reader = await jsonReq<{ chat: ChatDetail }>(app.base, "/api/chats/c_alpha?viewer=viewer_b");
      expect(reader.body.chat.pendingExtension?.requestId).toBe("ext_2");

      await jsonReq(app.base, "/api/chats/resume", {
        method: "POST", body: JSON.stringify({ chatId: "c_alpha", viewer: "viewer_b", takeover: true }),
      });
      await jsonReq(app.base, "/api/chats/c_alpha/extension-ui-response", {
        method: "POST", body: JSON.stringify({ viewer: "viewer_b", requestId: "ext_2", value: "ok" }),
      });
      const after = await jsonReq<{ chat: ChatDetail }>(app.base, "/api/chats/c_alpha?viewer=viewer_b");
      expect(after.body.chat.pendingExtension).toBeUndefined();
    } finally {
      await app.close();
    }
  });

});
