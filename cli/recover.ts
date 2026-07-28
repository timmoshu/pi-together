import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { runPrivilegedLifecycle, runPrivilegedQuery } from "./privileged-runner.js";
import { RecoveryInspectionSchema, RecoveryRequestSchema, RecoverableActionSchema, type RecoverableAction } from "../shared/recovery-protocol.js";

const descriptions: Record<RecoverableAction, string> = {
  apply: "installation apply (roll back journaled installation changes)",
  "manage-users": "GitHub user management (restore both previous allowlists)",
  "manage-workspaces": "workspace management (restore the previous shared-folder policy)",
  "prepare-tailscale": "Tailscale preparation (remove only the pinned temporary archive and journal)",
  share: "Funnel sharing (return sharing to disabled)",
  upgrade: "upgrade (restore the journaled previous release)",
};

export interface RecoverOptions {
  uid?: number;
  confirm?: (message: string) => Promise<boolean>;
  write?: (message: string) => void;
  inspect?: (uid: number) => Promise<unknown>;
  invoke?: (request: unknown) => Promise<void>;
}

async function defaultConfirm(message: string): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return /^(?:y|yes)$/i.test((await prompt.question(`${message} [y/N] `)).trim()); }
  finally { prompt.close(); }
}

async function inspect(uid: number): Promise<unknown> {
  return JSON.parse(await runPrivilegedQuery({ protocolVersion: 1, action: "inspect-recovery", invokingUid: uid }, "recovery inspection"));
}

export async function runRecover(args: string[], options: RecoverOptions = {}): Promise<boolean> {
  if (args.some((arg) => arg !== "--yes")) throw new Error("Usage: pi-together recover [--yes]");
  const uid = options.uid ?? process.getuid?.();
  if (!uid || uid === 0) throw new Error("recovery must run as the non-root Pi service user");
  const write = options.write ?? ((message: string) => stdout.write(message));
  const result = RecoveryInspectionSchema.parse(await (options.inspect ?? inspect)(uid));
  if (result.pending.length === 0) {
    write("No interrupted privileged operation was found. Nothing was changed.\n");
    return true;
  }
  if (result.pending.length !== 1) throw new Error("multiple privileged recovery journals require owner review; no recovery was attempted");
  const journal = result.pending[0]!;
  const parsed = RecoverableActionSchema.safeParse(journal.action);
  if (!parsed.success) {
    if (journal.action === "uninstall") throw new Error("an interrupted uninstall must be resumed with the same `pi-together uninstall` flags");
    throw new Error(`interrupted ${journal.action} operation has no standalone rollback; rerun its exact command`);
  }
  const action = parsed.data;
  write(`Interrupted operation: ${descriptions[action]}\nRecovery uses only its strict root-owned journal and does not run arbitrary commands.\n`);
  const confirmed = args.includes("--yes") || await (options.confirm ?? defaultConfirm)(`Recover interrupted ${action} operation now`);
  if (!confirmed) {
    write("Recovery cancelled; nothing was changed.\n");
    return false;
  }
  const request = RecoveryRequestSchema.parse({
    protocolVersion: 1, action: "recover", invokingUid: uid, expectedAction: action, expectedJournalSha256: journal.journalSha256,
  });
  await (options.invoke ?? ((value) => runPrivilegedLifecycle(value, "recovery")))(request);
  write(`Recovery complete: ${action}. Rerun the command you intended.\n`);
  return true;
}
