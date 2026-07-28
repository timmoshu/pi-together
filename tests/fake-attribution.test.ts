import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../pi-adapter/fake.js";
import type { WebAttribution } from "../shared/protocol.js";

const actor = { provider: "github" as const, subject: "1001", login: "alice" };
const attribution = (requestId: string, viewerId: string): WebAttribution => ({ requestId, actor, viewerId });

describe("fake collaboration contract", () => {
  it("preserves actor and action for prompt, queued steer, and queued follow-up", async () => {
    const adapter = new FakeAdapter();
    const chat = await adapter.createChat("/home/example/projects/atlas");
    await adapter.send(chat.id, "first", "normal", attribution("req_prompt", "viewer_secret"));
    await adapter.send(chat.id, "steer now", "steer", attribution("req_steer", "viewer_secret"));
    await adapter.send(chat.id, "follow later", "followUp", attribution("req_follow", "viewer_secret"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const detail = await adapter.getChat(chat.id);
    const users = detail!.turns.filter((turn) => turn.role === "user");
    expect(users.map((turn) => turn.attribution?.action)).toEqual(["prompt", "steer", "followUp"]);
    expect(users.map((turn) => turn.attribution?.actor)).toEqual([actor, actor, actor]);
    expect(detail!.turns.find((turn) => turn.text === "first")?.attribution?.requestId).toBe("req_prompt");
    await adapter.close();
  });

  it("leaves native fixture turns visibly unattributed", async () => {
    const adapter = new FakeAdapter();
    const seeded = await adapter.getChat("c_alpha");
    expect(seeded!.turns.filter((turn) => turn.role === "user").every((turn) => !turn.attribution)).toBe(true);
    await adapter.close();
  });
});
