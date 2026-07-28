import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveNameFromTurns, normalizeSessionEntries, type RawSessionEntry } from "../pi-adapter/normalize.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): RawSessionEntry[] {
  const raw = readFileSync(join(HERE, "fixtures", name), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawSessionEntry);
}

describe("normalizeSessionEntries — synthetic Pi session", () => {
  it("parses the synthetic fixture into id/name/cwd + turns", () => {
    const n = normalizeSessionEntries(loadFixture("pi-session-sample.jsonl"));
    expect(n.id).toBe("sample-0001");
    expect(n.name).toBe("sample chat");
    expect(n.cwd).toBe("/home/example/projects/atlas");
    expect(n.status).toBe("idle"); // status is never derived from the file
    expect(n.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Reply with exactly: ok"],
      ["agent", "ok"],
    ]);
    expect(n.updatedAt).toBeGreaterThan(1.7e12);
  });
});

describe("normalizeSessionEntries — units", () => {
  it("maps roles and flattens multi-part text content", () => {
    const n = normalizeSessionEntries([
      { type: "session", id: "s1", cwd: "/home/example/projects/atlas" },
      { type: "session_info", name: "chat one" },
      {
        type: "message",
        id: "m1",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1_700_000_001_000 },
      },
      {
        type: "message",
        id: "m2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello " }, { type: "text", text: "there" }],
          timestamp: 1_700_000_002_000,
        },
      },
    ]);
    expect(n.name).toBe("chat one");
    expect(n.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "hi"],
      ["agent", "hello there"],
    ]);
    expect(n.updatedAt).toBe(1_700_000_002_000);
  });

  it("reconstructs durable thinking and correlated tool traces without fake transcript text", () => {
    const n = normalizeSessionEntries([
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "inspect the files" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
          ],
          timestamp: 1_700_000_001_000,
        },
      },
      {
        type: "message",
        id: "r",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "README.md\nsrc/" }],
          isError: false,
          timestamp: 1_700_000_002_000,
        },
      },
      { type: "message", id: "b", message: { role: "user", content: [] } },
    ]);

    expect(n.turns).toEqual([expect.objectContaining({ id: "b", role: "user", text: "" })]);
    expect(n.timeline).toEqual([
      expect.objectContaining({ kind: "thinking", text: "inspect the files" }),
      expect.objectContaining({
        kind: "tool",
        id: "call-1",
        name: "bash",
        argsSummary: "bash: ls -la",
        state: "success",
        preview: "README.md\nsrc/",
      }),
      expect.objectContaining({ kind: "turn", id: "b", role: "user", text: "" }),
    ]);
  });

  it("derives a readable name from the first meaningful user message", () => {
    const mk = (text: string) => [{ id: "m", role: "user" as const, text, ts: 1 }];
    expect(deriveNameFromTurns(mk("Refactor the auth module please"))).toBe("Refactor the auth module please");
    // strips a leading system-injected block and keeps the real instruction
    expect(
      deriveNameFromTurns(mk("<kandev-system>KANDEV MCP TOOLS …</kandev-system>\nFix the flaky test in ci")),
    ).toBe("Fix the flaky test in ci");
    // truncates very long text
    expect(deriveNameFromTurns(mk("x".repeat(200)))!.length).toBeLessThanOrEqual(64);
    // nothing usable → null (caller falls back to workspace · date)
    expect(deriveNameFromTurns([{ id: "a", role: "agent", text: "hi", ts: 1 }])).toBeNull();
  });

  it("session with no session_info falls back to a derived name, not the uuid", () => {
    const n = normalizeSessionEntries([
      { type: "session", id: "019f-uuid", cwd: "/home/example/projects/pi-together" },
      { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "Add a dark mode toggle" }] } },
    ]);
    expect(n.name).toBe("Add a dark mode toggle");
    expect(n.name).not.toBe(n.id);
  });

  it("selects the current root-to-leaf branch across compaction", () => {
    const n = normalizeSessionEntries([
      { type: "session", id: "tree-session", cwd: "/tmp/example" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "root prompt", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "old branch", timestamp: 2 } },
      { type: "message", id: "u-abandoned", parentId: "u1", message: { role: "user", content: "alternate branch", timestamp: 3 } },
      { type: "compaction", id: "compact", parentId: "u-abandoned", summary: "summary", tokensBefore: 100 },
      { type: "message", id: "u2", parentId: "compact", message: { role: "user", content: "after compaction", timestamp: 4 } },
    ]);

    expect(n.turns.map((turn) => [turn.id, turn.text])).toEqual([
      ["u1", "root prompt"],
      ["u-abandoned", "alternate branch"],
      ["u2", "after compaction"],
    ]);
  });

  it("ignores model_change / thinking_level_change records", () => {
    const n = normalizeSessionEntries([
      { type: "model_change", provider: "example-ai", modelId: "example-model" },
      { type: "thinking_level_change" },
    ]);
    expect(n.turns).toHaveLength(0);
  });
});
