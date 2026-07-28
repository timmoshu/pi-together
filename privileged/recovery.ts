import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { pendingPrivilegedActions } from "./lifecycle-lock.js";
import { readBoundedRegular } from "./bounded-file.js";
import { RecoveryInspectionSchema, type RecoverableAction, type RecoveryInspection } from "../shared/recovery-protocol.js";

const fixed = [
  ["prepare-tailscale", "/var/lib/pi-together/tailscale-prepare-journal.json"],
  ["manage-users", "/var/lib/pi-together/user-management-journal.json"],
  ["manage-workspaces", "/var/lib/pi-together/policy-journal.json"],
  ["share", "/var/lib/pi-together/share-journal.json"],
  ["upgrade", "/var/lib/pi-together/upgrade-journal.json"],
  ["uninstall", "/var/lib/pi-together/uninstall-journal.json"],
] as const;

async function journalInventory(): Promise<RecoveryInspection> {
  const candidates: Array<{ action: RecoveryInspection["pending"][number]["action"]; path: string }> = fixed.map(([action, path]) => ({ action, path }));
  let temporary: string[] = [];
  try { temporary = await readdir("/var/tmp"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (temporary.length > 100_000) throw new Error("temporary recovery journal inventory is unexpectedly large");
  for (const name of temporary.filter((value) => /^pi-together-apply-[a-f0-9]{64}\.json$/.test(value))) candidates.push({ action: "apply", path: `/var/tmp/${name}` });
  const pending: RecoveryInspection["pending"] = [];
  for (const candidate of candidates) {
    try {
      const { bytes, info } = await readBoundedRegular(candidate.path, 2 * 1024 * 1024, "recovery journal is not a bounded stable regular file");
      if (info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o600) throw new Error("recovery journal metadata is unsafe");
      pending.push({ action: candidate.action, journalSha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return RecoveryInspectionSchema.parse({ pending: pending.sort((a, b) => a.action.localeCompare(b.action)) });
}

export async function inspectRecovery(): Promise<RecoveryInspection> { return journalInventory(); }

export async function requireExactRecoveryAction(expected: RecoverableAction, expectedJournalSha256: string): Promise<void> {
  const pendingActions = await pendingPrivilegedActions();
  const inventory = await journalInventory();
  if (pendingActions.size !== 1 || !pendingActions.has(expected) || inventory.pending.length !== 1
    || inventory.pending[0]!.action !== expected || inventory.pending[0]!.journalSha256 !== expectedJournalSha256) {
    throw new Error("privileged recovery journal changed after review");
  }
}
