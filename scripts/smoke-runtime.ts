// scripts/smoke-runtime.ts — LIVE smoke of the pi rpc runtime (needs pi on PATH + a provider key).
// Spawns a real `pi --mode rpc`, prompts it, and asserts the event bridge + command responses.
// Prints {"ok":true,"gotTurn":true,"gotRunning":true,"renamed":true,"compacted":...}.
//   SMOKE_PROVIDER=openai SMOKE_MODEL=gpt-4o-mini OPENAI_API_KEY=... npm run smoke:runtime
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime } from "../pi-adapter/runtime.js";
import { normalizeSessionEntries, type RawSessionEntry } from "../pi-adapter/normalize.js";
import type { ServerEvent } from "../shared/protocol.js";

function readSessionName(dir: string): string | null {
  const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (!file) return null;
  const entries = readFileSync(join(dir, file), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawSessionEntry);
  return normalizeSessionEntries(entries).name;
}

const dir = mkdtempSync(join(tmpdir(), "pi-rt-"));
const rt = new PiRuntime({
  sessionDir: dir,
  sessionId: "smoke-1",
  cwd: process.cwd(),
  provider: process.env.SMOKE_PROVIDER ?? "openai",
  model: process.env.SMOKE_MODEL ?? "gpt-4o-mini",
  noTools: true,
  responseTimeoutMs: 60_000,
});

let gotTurn = false;
let gotRunning = false;
rt.subscribe((e: ServerEvent) => {
  if (e.type === "chat.turn" && e.turn.role === "agent" && e.turn.text) gotTurn = true;
  if (e.type === "chat.status" && e.status === "running") gotRunning = true;
});

const waitForSettle = () =>
  new Promise<void>((resolve) => {
    const off = rt.subscribe((e: ServerEvent) => {
      if (e.type === "chat.status" && e.status === "waiting") {
        off();
        resolve();
      }
    });
    setTimeout(resolve, 50_000);
  });

async function run(): Promise<number> {
  await rt.prompt("Reply with exactly: ok");
  await waitForSettle();
  const renamed = await rt.setName("smoke renamed").then((r) => !!r["success"]).catch(() => false);
  const compacted = await rt.compact().then((r) => !!r["success"]).catch(() => false);
  // verify the rename landed in the session file (what the read path parses)
  const nameOk = readSessionName(dir) === "smoke renamed";
  const ok = gotTurn && renamed && nameOk;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok, gotTurn, gotRunning, renamed, compacted, nameOk }));
  await rt.close();
  return ok ? 0 : 1;
}

run()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error("smoke-runtime failed:", err);
    await rt.close();
    process.exit(1);
  });
