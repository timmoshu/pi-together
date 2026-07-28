// No-model current-Pi contract smoke: load the real extension, verify command provenance, append a
// signed lease entry through RPC prompt, and read it back through get_entries.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AttributionSigner } from "../pi-adapter/attribution-signer.js";
import { PiRuntime } from "../pi-adapter/runtime.js";

const directory = mkdtempSync(join(tmpdir(), "pi-together-attribution-smoke-"));
const sessionId = "attribution-smoke";
const signer = new AttributionSigner();
const runtime = new PiRuntime({
  piBin: process.env.PI_BIN ?? "pi",
  sessionId,
  sessionDir: directory,
  cwd: process.cwd(),
  noTools: true,
  responseTimeoutMs: 20_000,
  attribution: {
    extensionPath: resolve("extension/pi-together-attribution.ts"),
    publicKey: signer.publicKey,
  },
});

try {
  const requestId = "lease_smoke_1";
  const lease = signer.leaseEvent({
    sessionId,
    requestId,
    event: "acquired",
    next: {
      actor: { provider: "github", subject: "12345", login: "octocat" },
      viewerId: "viewer_smoke",
    },
  });
  await runtime.appendAttributedLease(lease, requestId);
  const { entries } = await runtime.getEntries();
  const found = entries.some((value) => {
    const entry = value as Record<string, unknown>;
    const data = entry.data as Record<string, unknown> | undefined;
    return entry.type === "custom" && entry.customType === "pi-together.lease.v1" && data?.requestId === requestId;
  });
  if (!found) throw new Error("real Pi did not return the signed lease entry");
  process.stdout.write(JSON.stringify({ ok: true, pi: "current", signedLease: true, noModelCall: true }) + "\n");
} finally {
  await runtime.close();
}
