import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { InstallManifestSchema, renderInstallManifest } from "./install-manifest.js";
import type { UninstallRequest } from "../privileged/uninstall-core.js";
import { runPrivilegedLifecycle, runPrivilegedQuery } from "./privileged-runner.js";
import { loadInstalledManifest } from "../privileged/uninstall-inventory.js";

export { loadInstalledManifest } from "../privileged/uninstall-inventory.js";

export interface UninstallPrompt { confirm(message: string): Promise<boolean>; write(message: string): void; close?(): void }
class TerminalPrompt implements UninstallPrompt {
  private readonly input = createInterface({ input: stdin, output: stdout });
  async confirm(message: string): Promise<boolean> { return /^(?:y|yes)$/i.test((await this.input.question(`${message} [y/N] `)).trim()); }
  write(message: string): void { stdout.write(message); }
  close(): void { this.input.close(); }
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
type InstalledInventory = Awaited<ReturnType<typeof loadInstalledManifest>>;
type InstallationInspection = InstalledInventory | { absent: true };

export async function inspectInstallationInventory(invokingUid: number): Promise<InstallationInspection> {
  const response = await runPrivilegedQuery({ protocolVersion: 1, action: "inspect-uninstall", invokingUid }, "uninstall inventory inspection");
  const value = JSON.parse(response) as { absent?: unknown; manifest?: unknown; manifestSha256?: unknown; recovery?: unknown };
  if (value.absent === true && Object.keys(value).length === 1) return { absent: true };
  const manifest = InstallManifestSchema.parse(value.manifest);
  const canonical = renderInstallManifest(manifest);
  if (typeof value.manifestSha256 !== "string" || value.manifestSha256 !== sha256(canonical)) {
    throw new Error("privileged uninstall inventory response hash mismatch");
  }
  if (value.recovery !== undefined && value.recovery !== "journal") throw new Error("privileged uninstall inventory response has an invalid source");
  return { manifest, manifestSha256: value.manifestSha256, ...(value.recovery === "journal" ? { recovery: "journal" as const } : {}) };
}

export async function inspectInstalledManifest(invokingUid: number): Promise<InstalledInventory> {
  const inspected = await inspectInstallationInventory(invokingUid);
  if ("absent" in inspected) throw new Error("Pi Together is not installed");
  return inspected;
}
export async function runUninstall(
  args: string[],
  prompt: UninstallPrompt = new TerminalPrompt(),
  invoke?: (request: UninstallRequest) => Promise<void>,
  manifestPath?: string,
  expectedRoot = { uid: 0, gid: 0 },
  inspectInventory: (invokingUid: number) => Promise<InstallationInspection> = inspectInstallationInventory,
): Promise<boolean> {
  try {
    const allowed = new Set(["--purge-config", "--yes"]);
    if (args.some((arg) => !allowed.has(arg))) throw new Error("unknown uninstall option");
    const purgeConfig = args.includes("--purge-config");
    const invokingUid = process.getuid?.();
    if (invokingUid === undefined || invokingUid <= 0) throw new Error("uninstall must be invoked by the installation's non-root owner");
    const loaded = manifestPath === undefined ? await inspectInventory(invokingUid) : await loadInstalledManifest(manifestPath, expectedRoot);
    if ("absent" in loaded) {
      prompt.write("Pi Together is already uninstalled. No managed integration markers were found; preserved data was not changed.\n");
      return true;
    }
    const removeCount = loaded.manifest.entries.filter((entry) => entry.uninstall === "remove").length;
    prompt.write(`Uninstall Pi Together ${loaded.manifest.version}\nManaged integration entries to remove: ${removeCount}\nPi sessions, Pi credentials, workspaces, and backups: preserved\nPi Together config: ${purgeConfig ? "REMOVE (explicit purge)" : "preserved"}\nInventory ${loaded.manifestSha256}${loaded.recovery === "journal" ? " (recovered from the root-owned interrupted-uninstall journal)" : ""}\n`);
    if (!args.includes("--yes") && !await prompt.confirm("Continue with the exact reviewed uninstall inventory?")) {
      prompt.write("Uninstall cancelled; no mutation was attempted.\n");
      return false;
    }
    const request: UninstallRequest = { protocolVersion: 1, action: "uninstall", invokingUid, ...loaded, purgeConfig };
    if (invoke) await invoke(request);
    else await runPrivilegedLifecycle(request, "uninstall");
    prompt.write("Uninstall complete. Preserved data remains in its documented locations.\n");
    return true;
  } finally { prompt.close?.(); }
}
