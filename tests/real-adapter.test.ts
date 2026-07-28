// Exercises the RealAdapter read path against real pi session files on disk (the fixture placed in a
// temp PI_SESSIONS_DIR laid out like ~/.pi/agent/sessions/<project>/<file>.jsonl).
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiAdapter } from "../shared/protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let adapter: PiAdapter;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  const proj = join(dir, "--home-example-projects-atlas--");
  mkdirSync(proj);
  const sessionFile = join(proj, "2025-01-02T03-04-05-000Z_sample-0001.jsonl");
  copyFileSync(join(HERE, "fixtures", "pi-session-sample.jsonl"), sessionFile);
  // Characterize the read path's tolerance of a crash-partial trailing JSONL record.
  appendFileSync(sessionFile, "{\"type\":\"message\",\"id\":\"partial");
  process.env.PI_SESSIONS_DIR = dir;
  const { RealAdapter } = await import("../pi-adapter/real.js");
  adapter = new RealAdapter();
});

afterAll(async () => {
  await adapter?.close();
});

describe("RealAdapter read path (real pi session on disk)", () => {
  it("lists the session parsed from the project dir", async () => {
    const chats = await adapter.listChats();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      id: "sample-0001",
      name: "sample chat",
      workspaceRoot: "/home/example/projects/atlas",
      turnCount: 2,
      status: "idle",
    });
  });

  it("returns detail with turns for a known id", async () => {
    const d = await adapter.getChat("sample-0001");
    expect(d).not.toBeNull();
    expect(d!.turns.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(d!.turns[1]!.text).toBe("ok");
  });

  it("returns null for an unknown id", async () => {
    expect(await adapter.getChat("does-not-exist")).toBeNull();
  });

  it("mutating ops reject unknown ids before spawning a runtime", async () => {
    // known-id resume/compact/rename spawn a live `pi --mode rpc` process — covered by
    // scripts/smoke-runtime.ts (needs pi + a provider key), not this deterministic suite.
    await expect(adapter.resume("does-not-exist")).rejects.toThrow(/no such chat/);
    await expect(adapter.detach("does-not-exist")).rejects.toThrow(/no such chat/);
    await expect(adapter.compact("does-not-exist")).rejects.toThrow(/no such chat/);
    await expect(adapter.rename("does-not-exist", "x")).rejects.toThrow(/no such chat/);
  });

  it("extensionUiResponse fails when no live runtime is attached", async () => {
    await expect(
      adapter.extensionUiResponse("sample-0001", "req", { requestId: "req", cancelled: true }),
    ).rejects.toThrow(/no live runtime/);
  });
});
