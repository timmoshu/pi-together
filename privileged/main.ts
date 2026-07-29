#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyValidated, validateApplyRequest } from "./apply-core.js";
import { RootApplyIo } from "./apply-io.js";
import { uninstallValidated, validateUninstallRequest } from "./uninstall-core.js";
import { RootUninstallIo } from "./uninstall-io.js";
import { loadInstalledOrRecoveryManifest, UninstallInventoryRequestSchema } from "./uninstall-inventory.js";
import { validateUpgradeRequest } from "./upgrade-request.js";
import { candidateRelease, runUpgrade } from "../cli/upgrade-core.js";
import { RootUpgradeIo } from "./upgrade-io.js";
import { applyUserManagement, UserManagementRequestSchema } from "./users-core.js";
import { RootUsersIo } from "./users-io.js";
import { applyWorkspaceManagement, WorkspaceManagementRequestSchema } from "./workspaces-core.js";
import { RootWorkspaceIo } from "./workspaces-io.js";
import { interruptedActionBlocking, pendingPrivilegedActions, PrivilegedLifecycleLock, type PrivilegedAction } from "./lifecycle-lock.js";
import { applyShare, RootShareIo, ShareRequestSchema } from "./share.js";
import { loginTailscale, LoginTailscaleRequestSchema, prepareTailscale, PrepareTailscaleRequestSchema, recoverTailscalePreparation } from "./tailscale-prepare.js";
import { inspectRecovery, requireExactRecoveryAction } from "./recovery.js";
import { RecoveryInspectionRequestSchema, RecoveryRequestSchema } from "../shared/recovery-protocol.js";
import { inspectCertificateLineage } from "./certificate-inventory.js";
import { CertificateInspectionRequestSchema } from "../shared/certificate-protocol.js";
import { FunnelActivationInspectionRequestSchema } from "../shared/funnel-activation-protocol.js";
import { inspectFunnelActivation } from "./funnel-activation.js";

declare const __PI_TOGETHER_VERSION__: string;
const VERSION = typeof __PI_TOGETHER_VERSION__ === "string" ? __PI_TOGETHER_VERSION__ : "0.1.0";

async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new Error("privileged lifecycle request exceeds size limit");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

try {
  if (process.getuid?.() !== 0) throw new Error("privileged lifecycle helper must run as root");
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("privileged lifecycle helper requires root-owned system Node 18 or newer");
  const systemNode = await realpath("/usr/bin/node");
  const runningNode = await realpath(process.execPath);
  const nodeInfo = await lstat(systemNode);
  if (runningNode !== systemNode || !nodeInfo.isFile() || nodeInfo.uid !== 0 || (nodeInfo.mode & 0o022) !== 0) {
    throw new Error("privileged lifecycle helper requires the root-owned non-writable /usr/bin/node interpreter");
  }
  if (process.argv.length !== 2) throw new Error("privileged lifecycle helper accepts no command-line arguments");
  const request = await readRequest();
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const requested = request && typeof request === "object" ? (request as { action?: unknown }).action : undefined;
  const action: PrivilegedAction = requested === "inspect-uninstall" ? "uninstall"
    : requested === "inspect-funnel-activation" ? "share"
      : requested === "inspect-recovery" || requested === "recover" ? "recover"
      : requested === "login-tailscale" || requested === "manage-users" || requested === "manage-workspaces" || requested === "prepare-tailscale" || requested === "share" || requested === "upgrade" || requested === "uninstall" ? requested : "apply";
  const lock = new PrivilegedLifecycleLock();
  await lock.acquire(action);
  try {
    const pending = await pendingPrivilegedActions();
    const interrupted = interruptedActionBlocking(action, pending);
    if (interrupted) throw new Error(`interrupted privileged ${interrupted} operation must be recovered with \`pi-together recover\` before ${action}`);
    if (request && typeof request === "object" && (request as { action?: unknown }).action === "inspect-funnel-activation") {
      const inspection = FunnelActivationInspectionRequestSchema.parse(request);
      if (Number(process.env.SUDO_UID) !== inspection.invokingUid) throw new Error("Funnel activation inspection identity does not match sudo provenance");
      process.stdout.write(`${JSON.stringify(await inspectFunnelActivation(inspection.invokingUid, inspection.dnsName))}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "inspect-certificate") {
      const inspection = CertificateInspectionRequestSchema.parse(request);
      if (Number(process.env.SUDO_UID) !== inspection.invokingUid) throw new Error("certificate inspection identity does not match sudo provenance");
      process.stderr.write(`Pi Together privileged boundary: inspecting exact Certbot lineage for ${inspection.domain}\n`);
      process.stdout.write(`${JSON.stringify(await inspectCertificateLineage(inspection.domain))}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "inspect-recovery") {
      const inspection = RecoveryInspectionRequestSchema.parse(request);
      if (Number(process.env.SUDO_UID) !== inspection.invokingUid) throw new Error("recovery inspection identity does not match sudo provenance");
      process.stderr.write("Pi Together privileged boundary: inspecting exact recovery journals\n");
      process.stdout.write(`${JSON.stringify(await inspectRecovery())}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "recover") {
      const recovery = RecoveryRequestSchema.parse(request);
      if (Number(process.env.SUDO_UID) !== recovery.invokingUid) throw new Error("recovery identity does not match sudo provenance");
      await requireExactRecoveryAction(recovery.expectedAction, recovery.expectedJournalSha256);
      process.stderr.write(`Pi Together privileged boundary: recovering interrupted ${recovery.expectedAction} operation\n`);
      if (recovery.expectedAction === "apply") await new RootApplyIo({ packageRoot }).recoverPending();
      else if (recovery.expectedAction === "manage-users") await new RootUsersIo({ request: recovery }).recoverPending();
      else if (recovery.expectedAction === "manage-workspaces") await new RootWorkspaceIo(recovery).recoverPending();
      else if (recovery.expectedAction === "prepare-tailscale") await recoverTailscalePreparation(recovery.invokingUid);
      else if (recovery.expectedAction === "share") await new RootShareIo(recovery).recoverPending();
      else if (recovery.expectedAction === "upgrade") await new RootUpgradeIo({ request: recovery }).recoverPending();
      process.stderr.write(`Pi Together recovery complete: ${recovery.expectedAction}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "inspect-uninstall") {
      const inspection = UninstallInventoryRequestSchema.parse(request);
      if (Number(process.env.SUDO_UID) !== inspection.invokingUid) throw new Error("uninstall inventory identity does not match sudo provenance");
      process.stderr.write("Pi Together privileged boundary: inspecting uninstall inventory or exact recovery journal\n");
      process.stdout.write(`${JSON.stringify(await loadInstalledOrRecoveryManifest(VERSION))}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "login-tailscale") {
      const validated = LoginTailscaleRequestSchema.parse(request);
      process.stderr.write("Pi Together privileged boundary: opening current-profile Tailscale login\n");
      await loginTailscale(validated);
      process.stderr.write("Pi Together Tailscale login complete\n");
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "prepare-tailscale") {
      const validated = PrepareTailscaleRequestSchema.parse(request);
      process.stderr.write("Pi Together privileged boundary: preparing pinned Tailscale package\n");
      await prepareTailscale(validated);
      process.stderr.write("Pi Together Tailscale preparation complete\n");
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "share") {
      const validated = ShareRequestSchema.parse(request);
      process.stderr.write(`Pi Together privileged boundary: ${validated.operation} Tailscale Funnel sharing\n`);
      await applyShare(validated, new RootShareIo(validated));
      process.stderr.write(`Pi Together sharing complete: ${validated.operation}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "manage-users") {
      const validated = UserManagementRequestSchema.parse(request);
      process.stderr.write(`Pi Together privileged boundary: ${validated.operation.kind} GitHub user ${validated.operation.login}\n`);
      await applyUserManagement(validated, new RootUsersIo({ request: validated }));
      process.stderr.write(`Pi Together user management complete: ${validated.operation.kind} ${validated.operation.login}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "manage-workspaces") {
      const validated = WorkspaceManagementRequestSchema.parse(request);
      process.stderr.write("Pi Together privileged boundary: replacing shared repository folder policy\n");
      await applyWorkspaceManagement(validated, new RootWorkspaceIo(validated));
      process.stderr.write("Pi Together workspace management complete\n");
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "upgrade") {
      const validated = validateUpgradeRequest(request);
      const target = candidateRelease(validated.candidate);
      process.stderr.write(`Pi Together privileged boundary: upgrading to signed release ${target}\n`);
      await runUpgrade(validated.candidate, new RootUpgradeIo({ request: validated }));
      process.stderr.write(`Pi Together upgrade complete: ${target}\n`);
    } else if (request && typeof request === "object" && (request as { action?: unknown }).action === "uninstall") {
      const validated = validateUninstallRequest(request);
      process.stderr.write(`Pi Together privileged boundary: uninstalling reviewed inventory ${validated.request.manifestSha256}\n`);
      await uninstallValidated(request, new RootUninstallIo({ invokingUid: validated.request.invokingUid }));
      process.stderr.write(`Pi Together uninstall complete: ${validated.request.manifestSha256}\n`);
    } else {
      const validated = validateApplyRequest(request);
      process.stderr.write(`Pi Together privileged boundary: applying reviewed plan ${validated.plan.planDigest}\n`);
      const applyIo = new RootApplyIo({ packageRoot });
      await applyIo.recoverPending();
      await applyValidated(request, applyIo);
      process.stderr.write(`Pi Together apply complete: ${validated.plan.planDigest}\n`);
    }
  } finally { await lock.release(); }
} catch (error) {
  process.stderr.write(`Pi Together privileged lifecycle refused or failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
