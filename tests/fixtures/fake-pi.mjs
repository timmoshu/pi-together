#!/usr/bin/env node
// Canned `pi --mode rpc` stand-in. It supports ordinary prompts plus the Pi Together extension
// arm/get_commands/get_entries contract without invoking a model or loading extension code.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

let buf = "";
let armed = null;
let blockedExtensionRequest = null;
const entries = [];
const extensionFlag = process.argv.indexOf("-e");
const extensionPath = extensionFlag >= 0 ? resolve(process.argv[extensionFlag + 1]) : null;
const log = (record) => {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(record) + "\n");
};
log({
  kind: "startup",
  args: process.argv.slice(2),
  hasPrivateKey: Boolean(process.env.PI_TOGETHER_ATTRIBUTION_PRIVATE_KEY),
  gitCommitterName: process.env.PI_TOGETHER_GIT_COMMITTER_NAME,
  gitCommitterEmail: process.env.PI_TOGETHER_GIT_COMMITTER_EMAIL,
  gitLauncher: process.env.PI_TOGETHER_GIT_LAUNCHER,
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buf += data;
  let index;
  while ((index = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, index).replace(/\r$/, "");
    buf = buf.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const respond = (cmd, data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, ...(data ? { data } : {}) });

function decodeArm(message) {
  const encoded = message.split(/\s+/, 2)[1];
  if (!encoded) return null;
  try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).payload; }
  catch { return null; }
}

function handle(cmd) {
  log({ kind: "command", command: cmd });
  if (cmd.type === "get_commands") {
    const commands = extensionPath ? [
      {
        name: "pi-together-arm-v1",
        source: "extension",
        sourceInfo: { path: process.env.FAKE_PI_BAD_SOURCE ? "/tmp/wrong-extension.js" : extensionPath },
      },
      { name: "pi-together-lease-v1", source: "extension", sourceInfo: { path: extensionPath } },
      ...(process.env.FAKE_PI_DUPLICATE_COMMAND
        ? [{ name: "pi-together-arm-v1:1", source: "extension", sourceInfo: { path: "/tmp/collision.js" } }]
        : []),
      { name: "other-command", source: "extension", sourceInfo: { path: "/tmp/other.js" } },
      { name: "skill:example", source: "skill", sourceInfo: { path: "/tmp/SKILL.md" } },
    ] : [];
    respond(cmd, { commands });
    return;
  }
  if (cmd.type === "get_entries") {
    respond(cmd, { entries, leafId: entries.at(-1)?.id ?? null });
    return;
  }
  // Extension UI responses are a no-ack sub-protocol frame, not RPC commands. Real Pi consumes
  // them without emitting a correlated `response`.
  if (cmd.type === "extension_ui_response") {
    if (cmd.id === blockedExtensionRequest) blockedExtensionRequest = null;
    return;
  }
  if (cmd.type === "abort") {
    // Pi's abort waits for the agent to become idle. A tool blocked on extension UI cannot settle
    // until that request is cancelled first.
    if (blockedExtensionRequest) return;
    respond(cmd);
    out({ type: "agent_settled" });
    return;
  }
  if (cmd.type === "prompt") {
    if (String(cmd.message).startsWith("/pi-together-arm-v1 ")) {
      armed = decodeArm(cmd.message);
      respond(cmd);
      return;
    }
    if (String(cmd.message).startsWith("/pi-together-lease-v1 ")) {
      const lease = decodeArm(cmd.message);
      if (lease) {
        entries.push({
          type: "custom",
          id: `entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          customType: "pi-together.lease.v1",
          data: {
            kind: "lease",
            requestId: lease.requestId,
            event: lease.event,
            occurredAt: lease.issuedAt,
            previous: lease.previous,
            next: lease.next,
          },
        });
      }
      respond(cmd);
      return;
    }
    if (process.env.FAKE_PI_BLOCK_ON_EXTENSION) {
      respond(cmd);
      out({ type: "agent_start" });
      blockedExtensionRequest = "permission_1";
      out({ type: "extension_ui_request", id: blockedExtensionRequest, method: "confirm", title: "Allow?" });
      return;
    }
    if (armed) {
      if (process.env.FAKE_PI_FAIL_CONTENT) {
        armed = null;
        out({ type: "response", id: cmd.id, command: "prompt", success: false, error: "synthetic content rejection" });
        return;
      }
      if (!process.env.FAKE_PI_DROP_ATTRIBUTION) {
        entries.push({
          type: "custom",
          id: `entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          customType: "pi-together.attribution.v1",
          data: {
            kind: "message",
            requestId: armed.requestId,
            actor: armed.actor,
            action: armed.action,
            viewerId: armed.viewerId,
            issuedAt: armed.issuedAt,
          },
        });
      }
      armed = null;
    }
    if (!process.env.FAKE_PI_DROP_CONTENT_RESPONSE) respond(cmd);
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
    out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "pondering", contentIndex: 0 } });
    out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "ok", contentIndex: 0 } });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }, { type: "text", text: "ok" }] } });
    out({ type: "turn_end", message: { role: "assistant" } });
    out({ type: "agent_settled" });
    return;
  }
  respond(cmd);
}
