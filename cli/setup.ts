import checkboxPrompt from "@inquirer/checkbox";
import confirmPrompt from "@inquirer/confirm";
import inputPrompt from "@inquirer/input";
import passwordPrompt from "@inquirer/password";
import selectPrompt from "@inquirer/select";
import { isAbsolute, normalize } from "node:path";
import { runPrivilegedApply, type ApplyRunner } from "./apply.js";
import {
  discoverHost,
  nodeProbeIo,
  PI_INSTALL_COMMAND,
  probePiPrerequisite,
  type DiscoveryReport,
  type PiPrerequisite,
  type ProbeIo,
} from "./discovery.js";
import { buildSetupPlan, nodePlanIo, renderSetupPlan, type PlanIo, type SetupPlan } from "./operation-plan.js";
import {
  loadSecureAnswers,
  oauthApplicationUrls,
  redactAnswers,
  SetupAnswersSchema,
  type SetupAnswers,
} from "./setup-answers.js";
import { probeTailscale, type TailscaleProbe } from "./tailscale-discovery.js";
import { TAILSCALE_RELEASE } from "../deployment/tailscale-release.js";
import { runTailscaleLogin, runTailscalePrepare } from "./tailscale.js";
import { completeFunnelActivation } from "./funnel-activation.js";
import { canonicalOwnerHome } from "./owner-home.js";
import type { FolderCandidate } from "../server/workspace-policy.js";
import {
  canCreateWorkspaceFolder,
  nodeWorkspaceFolderCreationIo,
  type WorkspaceFolderCreationIo,
} from "./workspace-folder-creation.js";

export interface PromptChoice<T> {
  value: T;
  name: string;
  description?: string;
  disabled?: boolean | string;
}

export interface SetupRunOptions {
  guidedInstall?: boolean;
  createMissingWorkspaceFolders?: boolean;
}

export interface SetupPrompter {
  text(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
  select<T>(label: string, choices: readonly PromptChoice<T>[]): Promise<T>;
  checkbox<T>(label: string, choices: readonly PromptChoice<T>[]): Promise<T[]>;
  write(message: string): void;
  close?(): void;
}

export class TerminalPrompter implements SetupPrompter {
  async text(label: string, defaultValue?: string): Promise<string> {
    return (await inputPrompt({
      message: label,
      required: true,
      ...(defaultValue ? { default: defaultValue, prefill: "editable" as const } : {}),
    })).trim();
  }
  async secret(label: string): Promise<string> {
    return (await passwordPrompt({ message: label, mask: "*" })).trim();
  }
  confirm(label: string, defaultValue = false): Promise<boolean> {
    return confirmPrompt({ message: label, default: defaultValue });
  }
  select<T>(label: string, choices: readonly PromptChoice<T>[]): Promise<T> {
    return selectPrompt({ message: label, choices, loop: false, pageSize: 10 });
  }
  checkbox<T>(label: string, choices: readonly PromptChoice<T>[]): Promise<T[]> {
    return checkboxPrompt({ message: label, choices, required: true, loop: false, pageSize: 12 });
  }
  write(message: string): void { process.stdout.write(message); }
  close(): void { /* Inquirer prompts own and close their terminal resources per question. */ }
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

const CUSTOM_WORKSPACE = "__pi_together_custom_workspace__";
const CONTROLS = /[\u0000-\u001f\u007f]/;

function explicitWorkspacePath(value: string): boolean {
  return isAbsolute(value) && value !== "/" && normalize(value) === value && !CONTROLS.test(value);
}

export function expandHomePath(value: string, ownerHome?: string): string {
  if (!ownerHome) return value;
  if (value === "~") return ownerHome;
  if (value.startsWith("~/")) return `${ownerHome}/${value.slice(2)}`;
  return value;
}

async function chooseSharedFolders(
  prompt: SetupPrompter,
  candidates: readonly FolderCandidate[],
  ownerHome?: string,
  folderIo?: WorkspaceFolderCreationIo,
): Promise<string[]> {
  const choices: PromptChoice<string>[] = candidates.map((candidate) => ({
    value: candidate.folder,
    name: candidate.folder,
    description: candidate.unavailableReason
      ?? `${candidate.repositoryCount} ${candidate.repositoryCount === 1 ? "repository" : "repositories"}${candidate.truncated ? "; scan truncated" : ""}`,
    ...(candidate.unavailableReason ? { disabled: candidate.unavailableReason } : {}),
  }));
  choices.push({
    value: CUSTOM_WORKSPACE,
    name: "Enter another folder…",
    description: "Use an absolute path; you can add more than one.",
  });
  const selected = await prompt.checkbox("Shared repository folders", choices);
  const folders = selected.filter((folder) => folder !== CUSTOM_WORKSPACE);
  if (selected.includes(CUSTOM_WORKSPACE)) {
    do {
      let acceptedFolder: string | undefined;
      while (!acceptedFolder) {
        let folder = "";
        while (!explicitWorkspacePath(folder)) {
          const entered = await prompt.text("Absolute shared repository folder", candidates.length === 0 ? ownerHome : undefined);
          folder = expandHomePath(entered, ownerHome);
          if (!explicitWorkspacePath(folder)) prompt.write("Enter a canonical absolute path or a path beneath home such as ~/projects.\n");
        }
        if (folderIo) {
          const state = await folderIo.inspect(folder);
          if (state === "invalid") {
            prompt.write("That path exists but is not a canonical directory. Choose another folder.\n");
            continue;
          }
          if (state === "missing") {
            if (!canCreateWorkspaceFolder(folder, ownerHome)) {
              prompt.write("A missing folder can be created automatically only beneath your canonical home. Create this path yourself or choose a home-relative path.\n");
              continue;
            }
            if (!await prompt.confirm(`Create ${folder} now as your user`, true)) {
              prompt.write("Folder creation declined. Choose another folder.\n");
              continue;
            }
            await folderIo.create(folder, ownerHome!);
            if (await folderIo.inspect(folder) !== "directory") throw new Error("created workspace folder did not pass revalidation");
            prompt.write(`Created ${folder}.\n`);
          }
        }
        acceptedFolder = folder;
      }
      if (folders.includes(acceptedFolder)) prompt.write(`${acceptedFolder} is already selected; keeping one entry.\n`);
      else folders.push(acceptedFolder);
    } while (await prompt.confirm("Add another shared repository folder", false));
  }
  if (folders.length > 16) throw new Error("select no more than 16 shared repository folders");
  if (folderIo && ownerHome) {
    for (const folder of folders) {
      if (!await folderIo.empty(folder)) continue;
      prompt.write(`${folder} is empty. It can remain a container for repositories added later.\n`);
      if (await prompt.confirm(`Initialize ${folder} itself as a local Git repository`, false)) {
        await folderIo.initializeGit(folder, ownerHome);
        prompt.write(`Initialized local Git repository at ${folder}; no remote or commit was created.\n`);
      }
    }
  }
  return folders;
}

async function probePreparedTailscale(probe: () => Promise<TailscaleProbe>): Promise<TailscaleProbe> {
  let state = await probe();
  for (let attempt = 0; attempt < 39 && (state.status === "missing" || state.status === "probe-failed"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await probe();
  }
  return state;
}

export async function collectInteractiveAnswers(
  prompt: SetupPrompter,
  tailscaleProbe: () => Promise<TailscaleProbe> = () => probeTailscale(),
  tailscalePrepare: () => Promise<void> = () => runTailscalePrepare({ acceptedTerms: true }),
  tailscaleLogin: () => Promise<void> = () => runTailscaleLogin(),
  workspaceCandidates: readonly FolderCandidate[] = [],
  ownerHomeProbe: () => Promise<string> = () => canonicalOwnerHome(),
  folderIo?: WorkspaceFolderCreationIo,
): Promise<SetupAnswers> {
  prompt.write("\nRepositories and sessions\n-------------------------\nPi Together does not clone repositories or manage Git credentials. Clone repositories normally with Git; repositories beneath the shared folders you approve appear automatically.\n\nEvery allowed GitHub user can view and control Pi sessions for every repository in those folders. GitHub repository membership is not checked. Pi runs with your host-user permissions and is not a filesystem sandbox. A basic managed-command guard blocks common catastrophic Bash deletions, but other interpreters or binaries can bypass it.\n\nAccess and safety\n-----------------\nPi and its tools run with your normal host-user permissions. Authentication controls who may ask Pi to act; it is not a sandbox.\n\n");
  const acceptedHostPermissionRisk = await prompt.confirm("I understand that authorized users can change files and run tools as my account");
  if (!acceptedHostPermissionRisk) throw new Error("host-permission risk acknowledgement is required");
  prompt.write("\nChoose easy sharing for a stable Tailscale URL, or local access for this computer only. Own Domain is not supported in 0.1.x.\n");
  const requestedMode = await prompt.select<"funnel" | "local">("Access", [
    { value: "funnel" as const, name: "Easy sharing — multiplayer", description: "GitHub-authenticated collaborators through a stable Tailscale Funnel URL." },
    { value: "local" as const, name: "Local single-user / SSH tunnel", description: "No OAuth; every tab or trusted SSH tunnel shares one local identity. Not multiplayer." },
  ]);
  if (requestedMode !== "funnel" && requestedMode !== "local") {
    throw new Error("access must be easy sharing or local");
  }
  const ownerHome = await ownerHomeProbe().catch(() => undefined);
  const sharedRepositoryFolders = await chooseSharedFolders(prompt, workspaceCandidates, ownerHome, folderIo);
  if (ownerHome && sharedRepositoryFolders.includes(ownerHome) && !await prompt.confirm("Share the entire home, including every current and future eligible repository outside fixed pruned security/cache folders", false)) {
    throw new Error("whole-home sharing requires explicit high-risk confirmation");
  }
  const common = { schemaVersion: 2 as const, acceptedHostPermissionRisk, sharedRepositoryFolders };
  if (requestedMode === "local") return SetupAnswersSchema.parse({
    ...common,
    mode: "local",
    startNow: await prompt.confirm("Start Pi Together when installation finishes", true),
    enableBootService: await prompt.confirm("Start Pi Together automatically after reboot", false),
  });
  prompt.write(`\nEasy sharing with Tailscale Funnel (upstream beta)\n--------------------------------------------------\nNo inbound ports are required. Tailscale account, terms, availability, and bandwidth limits apply. Collaborators need only GitHub.\nTerms: ${TAILSCALE_RELEASE.termsUrl}\n`);
  if (!await prompt.confirm("I accept Tailscale's separate terms and beta service dependency")) throw new Error("Tailscale terms and beta dependency acknowledgement is required");
  let tailscale = await tailscaleProbe();
  if (tailscale.status === "missing") {
    if (!await prompt.confirm("Install the exact reviewed Tailscale package now")) throw new Error("Tailscale installation was declined; no network package was installed");
    await tailscalePrepare();
    prompt.write("Waiting for the installed Tailscale daemon…\n");
    tailscale = await probePreparedTailscale(tailscaleProbe);
  }
  if (tailscale.status === "needs-login") {
    if (!await prompt.confirm("Open the Tailscale browser login for this machine now")) throw new Error("Tailscale login was declined");
    await tailscaleLogin();
    tailscale = await tailscaleProbe();
  }
  if (tailscale.status !== "ready") throw new Error("Tailscale is incompatible, unhealthy, expired, or could not be safely probed; resolve `tailscale status` before continuing.");
  const domain = tailscale.dnsName;
  prompt.write(`Stable public origin: https://${domain}\n`);
  const urls = oauthApplicationUrls(domain);
  prompt.write(`\nOpen https://github.com/settings/applications/new and create an OAuth App with these exact values:\nHomepage URL: ${urls.homepage}\nAuthorization callback URL: ${urls.callback}\n\n`);
  const githubLogins = csv(await prompt.text("GitHub usernames allowed to sign in, comma-separated (more can be added later)"));
  const oauthClientId = await prompt.text("GitHub OAuth App client ID");
  const oauthClientSecret = await prompt.secret("GitHub OAuth App client secret (input hidden)");
  const lifecycle = {
    startNow: await prompt.confirm("Start Pi Together when installation finishes", true),
    enableBootService: await prompt.confirm("Start Pi Together automatically after reboot", false),
  };
  return SetupAnswersSchema.parse({
    ...common, ...lifecycle, mode: "tailscale-funnel", tailscaleDnsName: domain,
    githubLogins, oauthClientId, oauthClientSecret,
  });
}

export function assertSupportedAccessMode(mode: SetupAnswers["mode"]): void {
  if (mode === "reverse-proxy") throw new Error("Own Domain is not supported in Pi Together 0.1.x; use Easy Sharing or Local access");
}

function assertSupportedAnswers(answers: SetupAnswers): asserts answers is Exclude<SetupAnswers, { mode: "reverse-proxy" }> {
  assertSupportedAccessMode(answers.mode);
}

function piPrerequisiteMessage(pi: PiPrerequisite): string {
  if (pi.status === "missing") return `Pi is required before Pi Together setup.\nInstall the compatible Pi line as your normal user:\n  ${PI_INSTALL_COMMAND}\nThen run pi, use /login to configure a provider, and rerun this command.`;
  if (pi.status === "unsupported") return `Pi ${pi.version ?? "version unknown"} is incompatible; Pi Together requires >=0.82.0 <0.83.0.\nInstall the compatible line with:\n  ${PI_INSTALL_COMMAND}`;
  if (pi.status === "no-models") return "Pi is installed, but no configured models are available. Run pi, use /login to configure a provider, verify /model, and rerun this command.";
  return "Pi could not be probed safely. Verify that pi --version and pi --offline --no-extensions --no-skills --no-prompt-templates --list-models work, then rerun setup.";
}

function renderAnswerSummary(answers: SetupAnswers): string {
  const access = answers.mode === "local" ? "Local — this computer only"
    : answers.mode === "tailscale-funnel" ? `Easy sharing — https://${answers.tailscaleDnsName}`
      : `Own domain — https://${answers.domain}`;
  const controllers = answers.mode === "local" ? "Current local user" : answers.githubLogins.join(", ");
  return [
    `Access: ${access}`,
    `Controllers: ${controllers}`,
    `Shared repository folders (${answers.sharedRepositoryFolders.length}):`,
    ...answers.sharedRepositoryFolders.map((root) => `  - ${root}`),
    ...(answers.mode === "reverse-proxy" ? [`Existing exact-domain certificate: ${answers.reuseExistingCertificate ? "reuse after privileged validation" : "do not reuse"}`] : []),
    `Start after install: ${answers.startNow ? "yes" : "no"}`,
    `Start after reboot: ${answers.enableBootService ? "yes" : "no"}`,
  ].join("\n");
}

export function renderDiscovery(report: DiscoveryReport): string {
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  return report.checks.map((check) => `${icon[check.status]}  ${check.id}  ${check.summary}${check.detail ? ` — ${check.detail}` : ""}`).join("\n");
}

function nonInteractiveIndex(args: string[]): number {
  let index = -1;
  for (let cursor = 0; cursor < args.length; cursor++) {
    const value = args[cursor]!;
    if (["--dry-run", "--apply", "--yes"].includes(value)) continue;
    if (value === "--non-interactive") {
      if (index >= 0) throw new Error("--non-interactive may be supplied only once");
      index = cursor;
      if (!args[cursor + 1] || args[cursor + 1]!.startsWith("--")) throw new Error("--non-interactive requires an answer file");
      cursor++;
      continue;
    }
    throw new Error(`unknown setup option: ${value}`);
  }
  if (args.includes("--dry-run") && args.includes("--apply")) throw new Error("--dry-run and --apply cannot be combined");
  if (args.includes("--yes") && !args.includes("--apply")) throw new Error("--yes requires --apply");
  if (index >= 0 && args.includes("--apply") && !args.includes("--yes")) throw new Error("noninteractive apply requires both --apply and --yes");
  return index;
}

export async function runSetup(
  args: string[],
  prompt: SetupPrompter | undefined = undefined,
  io: ProbeIo = nodeProbeIo,
  planIo: PlanIo = nodePlanIo,
  applyRunner: ApplyRunner = runPrivilegedApply,
  knownPi?: PiPrerequisite,
  tailscaleProbe: () => Promise<TailscaleProbe> = () => probeTailscale(),
  workspaceCandidates: readonly FolderCandidate[] = [],
  options: SetupRunOptions = {},
): Promise<{ answers: SetupAnswers; report: DiscoveryReport; plan?: SetupPlan }> {
  const nonInteractive = nonInteractiveIndex(args);
  const activePrompt = prompt ?? (nonInteractive >= 0
    ? {
        text: async () => { throw new Error("prompt unavailable in noninteractive mode"); },
        secret: async () => { throw new Error("prompt unavailable in noninteractive mode"); },
        confirm: async () => { throw new Error("prompt unavailable in noninteractive mode"); },
        select: async () => { throw new Error("prompt unavailable in noninteractive mode"); },
        checkbox: async () => { throw new Error("prompt unavailable in noninteractive mode"); },
        write: (message: string) => process.stdout.write(message),
      }
    : new TerminalPrompter());
  try {
    const pi = knownPi ?? await probePiPrerequisite(io);
    if (pi.status !== "ready") {
      const message = piPrerequisiteMessage(pi);
      activePrompt.write(`Pi prerequisite\nFAIL  ${message}\n\nNo answers or secrets were collected and no system mutation was attempted.\n`);
      throw new Error(message);
    }
    if (!knownPi) activePrompt.write(`Pi prerequisite\nPASS  ${pi.version} at ${pi.piPath} with ${pi.modelCount} configured model entr${pi.modelCount === 1 ? "y" : "ies"}\n`);
    const answers = nonInteractive >= 0
      ? await loadSecureAnswers(args[nonInteractive + 1] ?? "")
      : await collectInteractiveAnswers(
          activePrompt,
          tailscaleProbe,
          undefined,
          undefined,
          workspaceCandidates,
          undefined,
          options.createMissingWorkspaceFolders ? nodeWorkspaceFolderCreationIo : undefined,
        );
    assertSupportedAnswers(answers);
    if (answers.mode === "tailscale-funnel") {
      const tailscale = await tailscaleProbe();
      if (tailscale.status !== "ready" || tailscale.dnsName !== answers.tailscaleDnsName || tailscale.path !== "/usr/bin/tailscale") {
        throw new Error("the reviewed Tailscale node is not ready at /usr/bin/tailscale with the requested stable DNS name");
      }
      activePrompt.write(`Tailscale prerequisite\nPASS  ${tailscale.version} at ${tailscale.path}; public origin https://${tailscale.dnsName}\n`);
    }
    const report = await discoverHost({
      ...(answers.mode === "tailscale-funnel" ? { domain: answers.tailscaleDnsName } : {}),
      sharedRepositoryFolders: answers.sharedRepositoryFolders,
      localListener: answers.mode === "local",
    }, io, pi);
    const summary = renderAnswerSummary(answers);
    if (!options.guidedInstall || !report.safeToPlan) {
      activePrompt.write(`\nSystem check\n------------\n${renderDiscovery(report)}\n\nConfiguration summary\n---------------------\n${summary}\n\nRedacted technical details\n${JSON.stringify(redactAnswers(answers), null, 2)}\n`);
    } else {
      const warnings = report.checks.filter((check) => check.status === "warn");
      if (warnings.length) {
        activePrompt.write(`\nChecks needing attention\n------------------------\n${warnings.map((check) => `WARN  ${check.id}  ${check.summary}${check.detail ? ` — ${check.detail}` : ""}`).join("\n")}\n`);
      }
      const localAddress = answers.mode === "local" && report.facts.localPort !== undefined
        ? `\nLocal address: http://127.0.0.1:${report.facts.localPort}` : "";
      activePrompt.write(`\nReady to install\n----------------\n${summary}${localAddress}\n\nPi Together will install its service and configuration. Sudo may ask for your password after you choose Install now.\n`);
    }
    if (!report.safeToPlan) {
      activePrompt.write("\nPlanning stopped because discovery failed. No system mutation was attempted.\n");
      return { answers, report };
    }
    let plan: SetupPlan | undefined;
    const exactPlan = async () => plan ??= await buildSetupPlan(answers, report, planIo);
    if (options.guidedInstall) {
      let finished = false;
      while (!finished) {
        const action = await activePrompt.select("Continue", [
          { value: "install" as const, name: "Install now", description: "Apply this installation through the narrow sudo helper." },
          { value: "details" as const, name: "Show technical plan", description: "Display paths, operations, and redacted configuration before deciding." },
          { value: "cancel" as const, name: "Cancel", description: "Leave Pi Together uninstalled." },
        ]);
        if (action === "details") {
          activePrompt.write(`\nRedacted technical details\n--------------------------\n${JSON.stringify(redactAnswers(answers), null, 2)}\n\nReviewable operation plan\n-------------------------\n${renderSetupPlan(await exactPlan())}\n`);
          continue;
        }
        if (action === "cancel") {
          activePrompt.write("\nInstallation cancelled; no system mutation was attempted.\n");
          finished = true;
          continue;
        }
        await applyRunner(await exactPlan(), answers);
        if (answers.mode === "tailscale-funnel") await completeFunnelActivation(answers.tailscaleDnsName, activePrompt);
        const origin = answers.mode === "local" ? `http://127.0.0.1:${report.facts.localPort}` : `https://${answers.tailscaleDnsName}`;
        activePrompt.write(answers.startNow
          ? `\nInstallation complete. Open ${origin}\n`
          : "\nInstallation complete. Pi Together was not started because you chose not to start it after installation.\n");
        finished = true;
      }
    } else {
      plan = await exactPlan();
      activePrompt.write(`\nReviewable operation plan\n-------------------------\n${renderSetupPlan(plan)}\n`);
      if (args.includes("--apply")) {
        const confirmed = args.includes("--yes") || await activePrompt.confirm(`Apply exact plan ${plan.planDigest} with sudo`, false);
        if (!confirmed) activePrompt.write("\nApply cancelled; no system mutation was attempted.\n");
        else {
          await applyRunner(plan, answers);
          if (answers.mode === "tailscale-funnel") await completeFunnelActivation(answers.tailscaleDnsName, activePrompt);
          activePrompt.write("\nInstallation complete. Run `pi-together doctor` to verify the deployment and `pi-together status` for service state.\n");
        }
      } else if (!args.includes("--dry-run")) {
        activePrompt.write("\nPlan complete; nothing was installed. Review the operations above, then run `pi-together setup --apply` when ready.\n");
      }
    }
    return { answers, report, plan };
  } finally {
    activePrompt.close?.();
  }
}
