import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { inspectInstalledManifest, loadInstalledManifest } from "./uninstall.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";
import { canonicalOwnerHome } from "./owner-home.js";
import { parseConfig } from "../server/config.js";
import { RepositoryDiscovery, canonicalSharedFolders, validateSharedFolders } from "../server/workspace-policy.js";
import type { CurrentWorkspaceManagementState, WorkspaceManagementRequest } from "../privileged/workspaces-core.js";

const APP_CONFIG = "/etc/pi-together/config.json";
const MANIFEST = "/var/lib/pi-together/install-manifest.json";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function readConfig(path: string, uid: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 2 * 1024 * 1024) throw new Error("app config has unsafe metadata");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export async function loadWorkspaceManagementState(
  uid = process.getuid?.(),
  paths?: { appConfig: string; manifest: string },
  inspectManifest?: (invokingUid: number) => ReturnType<typeof inspectInstalledManifest>,
): Promise<CurrentWorkspaceManagementState> {
  if (uid === undefined || uid === 0) throw new Error("workspace management must run as the non-root Pi service user");
  const effectivePaths = paths ?? { appConfig: APP_CONFIG, manifest: MANIFEST };
  const [appConfig, loaded] = await Promise.all([
    readConfig(effectivePaths.appConfig, uid),
    inspectManifest ? inspectManifest(uid)
      : paths ? loadInstalledManifest(effectivePaths.manifest) : inspectInstalledManifest(uid),
  ]);
  parseConfig(JSON.parse(appConfig));
  return { appConfig, manifest: `${JSON.stringify(loaded.manifest, null, 2)}\n`, appConfigOwnerUid: uid };
}

export interface WorkspaceCommandOptions {
  uid?: number;
  loadCurrent?: () => Promise<CurrentWorkspaceManagementState>;
  confirm?: (message: string) => Promise<boolean>;
  text?: (message: string) => Promise<string>;
  write?: (message: string) => void;
  invoke?: (request: WorkspaceManagementRequest) => Promise<void>;
}

async function terminalText(message: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question(`${message}: `)).trim(); } finally { prompt.close(); }
}
async function terminalConfirm(message: string): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return /^(?:y|yes)$/i.test((await prompt.question(`${message} [y/N] `)).trim()); } finally { prompt.close(); }
}
function usage(): Error { return new Error("Usage: pi-together workspaces list [--json] | detect [--json] | configure [--folders <comma-separated>] [--yes]"); }

export async function runWorkspacesCommand(args: string[], options: WorkspaceCommandOptions = {}): Promise<boolean> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error("workspace management must run as the non-root Pi service user");
  const write = options.write ?? ((message: string) => stdout.write(message));
  const current = await (options.loadCurrent ?? (() => loadWorkspaceManagementState(uid)))();
  const config = parseConfig(JSON.parse(current.appConfig));
  const [command, ...rest] = args;

  if (command === "list") {
    if (rest.some((arg) => arg !== "--json") || rest.filter((arg) => arg === "--json").length > 1) throw usage();
    const result = await new RepositoryDiscovery(config.sharedRepositoryFolders).refresh();
    const report = { sharedRepositoryFolders: config.sharedRepositoryFolders, repositoryCount: result.repositories.length, truncated: result.truncated };
    if (rest.includes("--json")) write(`${JSON.stringify(report)}\n`);
    else {
      write(`Shared repository folders (${report.sharedRepositoryFolders.length})\n`);
      report.sharedRepositoryFolders.forEach((folder) => write(`${folder}\n`));
      write(`Discovered repositories: ${report.repositoryCount}${report.truncated ? " (scan truncated)" : ""}\n`);
    }
    return true;
  }

  if (command === "detect") {
    if (rest.some((arg) => arg !== "--json") || rest.filter((arg) => arg === "--json").length > 1) throw usage();
    const [currentResult, candidates] = await Promise.all([
      new RepositoryDiscovery(config.sharedRepositoryFolders).refresh(),
      RepositoryDiscovery.detectCandidates(await canonicalOwnerHome(uid)),
    ]);
    const report = {
      candidates,
      configuredFolderCount: config.sharedRepositoryFolders.length,
      repositoryCount: currentResult.repositories.length,
      truncated: currentResult.truncated || candidates.some((candidate) => candidate.truncated),
    };
    if (rest.includes("--json")) write(`${JSON.stringify(report)}\n`);
    else {
      write("Detected shared-folder candidates (read-only; policy unchanged)\n");
      candidates.forEach((candidate) => write(`${candidate.folder}  ${candidate.repositoryCount} repositories${candidate.truncated ? " (truncated)" : ""}\n`));
      write(`Current policy: ${report.configuredFolderCount} folders, ${report.repositoryCount} repositories${report.truncated ? " (scan truncated)" : ""}\n`);
    }
    return true;
  }

  if (command !== "configure") throw usage();
  let foldersInput: string | undefined;
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--yes") { if (yes) throw usage(); yes = true; }
    else if (rest[index] === "--folders" && rest[index + 1]) { if (foldersInput) throw usage(); foldersInput = rest[++index]; }
    else throw usage();
  }
  foldersInput ??= await (options.text ?? terminalText)("Complete shared repository folder set, comma-separated");
  const folders = canonicalSharedFolders(foldersInput.split(",").map((item) => item.trim()).filter(Boolean));
  await validateSharedFolders(folders, uid);
  const before = await new RepositoryDiscovery(config.sharedRepositoryFolders).refresh();
  const after = await new RepositoryDiscovery(folders).refresh();
  write(`Replace the complete shared repository folder policy\nBefore (${config.sharedRepositoryFolders.length}):\n${config.sharedRepositoryFolders.map((folder) => `  - ${folder}`).join("\n")}\nAfter (${folders.length}):\n${folders.map((folder) => `  - ${folder}`).join("\n")}\nRepositories now/after: ${before.repositories.length}/${after.repositories.length}${after.truncated ? " (scan truncated)" : ""}\nEvery allowed collaborator receives every repository in these folders. GitHub repository membership is not checked, and Pi is not a filesystem sandbox.\n`);
  if (!yes && !await (options.confirm ?? terminalConfirm)("Apply this exact complete-set replacement")) {
    write("Workspace policy change cancelled; no mutation was attempted.\n");
    return false;
  }
  const request: WorkspaceManagementRequest = {
    protocolVersion: 1,
    action: "manage-workspaces",
    invokingUid: uid,
    sharedRepositoryFolders: folders,
    expected: { appConfigSha256: sha256(current.appConfig), manifestSha256: sha256(current.manifest) },
  };
  await (options.invoke ?? ((value) => runPrivilegedLifecycle(value, "workspace management")))(request);
  write("Shared repository folder policy replaced. Repositories and Pi sessions were preserved.\n");
  return true;
}
