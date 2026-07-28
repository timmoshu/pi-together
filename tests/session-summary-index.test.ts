import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionSummaryIndex } from "../pi-adapter/session-summary-index.js";

const header = { type: "session", version: 3, id: "indexed-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/repo" };
const user = { type: "message", id: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Fast rail title" } };
const agent = { type: "message", id: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };

function makeIndex(dir: string): SessionSummaryIndex {
  return new SessionSummaryIndex(dir, ".summary-index.json", "/fallback", async (cwd) => cwd);
}

describe("SessionSummaryIndex", () => {
  it("persists summaries and indexes only newly appended complete records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-summary-index-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n${JSON.stringify(agent)}\n`);

    const first = await makeIndex(dir).refresh([file]);
    expect(first).toMatchObject([{ id: "indexed-1", cwd: "/work/repo", name: "Fast rail title", turnCount: 2 }]);
    expect(JSON.parse(await readFile(join(dir, ".summary-index.json"), "utf8")).version).toBe(1);

    // Simulate a writer observed halfway through a JSONL append. Incomplete records must not leak
    // into metadata, and the next refresh resumes at the previous complete newline.
    await appendFile(file, '{"type":"message","id":"u2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"');
    expect((await makeIndex(dir).refresh([file]))[0]?.turnCount).toBe(2);
    await appendFile(file, 'later"}}\n');
    const updated = await makeIndex(dir).refresh([file]);
    expect(updated[0]).toMatchObject({ turnCount: 3, updatedAt: Date.parse("2026-01-01T00:00:03.000Z") });

    await appendFile(file, `${JSON.stringify({ type: "session_info", id: "n1", timestamp: "2026-01-01T00:00:04.000Z", name: "Renamed" })}\n`);
    expect((await makeIndex(dir).refresh([file]))[0]?.name).toBe("Renamed");
  });
});
