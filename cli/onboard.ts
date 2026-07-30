import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { nodeProbeIo, PI_INSTALL_COMMAND, probePiPrerequisite, type PiPrerequisite } from "./discovery.js";
import { PI_COMPATIBILITY, PI_PACKAGE_SPEC } from "./pi-version.js";
import { runSetup, TerminalPrompter, type SetupPrompter } from "./setup.js";
import { canonicalOwnerHome } from "./owner-home.js";
import { RepositoryDiscovery, type FolderCandidate } from "../server/workspace-policy.js";

export interface OnboardingIo {
  uid(): number | undefined;
  probePi(): Promise<PiPrerequisite>;
  installPi(): Promise<void>;
  launchPi(piPath: string): Promise<void>;
  detectWorkspaceCandidates?(): Promise<FolderCandidate[]>;
}

const CONTROLS = /[\u0000-\u001f\u007f]/;

export function userNpmPrefix(home = homedir()): string {
  if (!isAbsolute(home) || home === "/" || CONTROLS.test(home)) throw new Error("user home is not safe for npm installation");
  return join(home, ".local");
}

export function piInstallArguments(prefix: string): string[] {
  if (!isAbsolute(prefix) || prefix === "/" || CONTROLS.test(prefix)) throw new Error("user npm prefix is unsafe");
  return [
    "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund",
    PI_PACKAGE_SPEC,
  ];
}

function runInteractive(file: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${file} exited ${code ?? signal ?? "unknown"}`)));
  });
}

export const nodeOnboardingIo: OnboardingIo = {
  uid: () => process.getuid?.(),
  probePi: async () => {
    const localPi = join(userNpmPrefix(), "bin", "pi");
    if (await access(localPi, constants.X_OK).then(() => true, () => false)) {
      return probePiPrerequisite({ ...nodeProbeIo, piBin: localPi });
    }
    return probePiPrerequisite();
  },
  installPi: () => runInteractive("npm", piInstallArguments(userNpmPrefix())),
  launchPi: (piPath) => runInteractive(piPath, [], homedir()),
  detectWorkspaceCandidates: async () => RepositoryDiscovery.detectCandidates(await canonicalOwnerHome()),
};

function statusText(pi: PiPrerequisite): string {
  if (pi.status === "ready") return `Pi ${pi.version} is ready with ${pi.modelCount} configured model entr${pi.modelCount === 1 ? "y" : "ies"}.`;
  if (pi.status === "missing") return "Pi is not installed or is not on PATH.";
  if (pi.status === "unsupported") return `Pi ${pi.version ?? "version unknown"} is not in the supported ${PI_COMPATIBILITY} range.`;
  if (pi.status === "no-models") return `Pi ${pi.version} is installed, but no configured model is available.`;
  return "Pi is installed but its version/model readiness probe failed.";
}

export async function runOnboarding(
  prompt: SetupPrompter = new TerminalPrompter(),
  io: OnboardingIo = nodeOnboardingIo,
  setup: (prompt: SetupPrompter, pi: PiPrerequisite, candidates: readonly FolderCandidate[]) => Promise<unknown>
    = (activePrompt, pi, candidates) => runSetup([], activePrompt, undefined, undefined, undefined, pi, undefined, candidates, {
      guidedInstall: true,
      createMissingWorkspaceFolders: true,
    }),
): Promise<boolean> {
  let handedToSetup = false;
  try {
    const uid = io.uid();
    if (uid === 0 || uid === undefined) {
      throw new Error("Run onboarding as the normal non-root user who owns the Pi sessions; do not use sudo.");
    }
    prompt.write("\nPi Together guided setup\n========================\nThis assistant prepares Pi, checks this computer, and installs Pi Together only after you choose Install now.\nPrivileged system files are not changed until the final confirmation and sudo approval.\n\n[1/3] Check Pi\n");
    let pi = await io.probePi();
    prompt.write(`${statusText(pi)}\n`);

    if (pi.status === "missing" || pi.status === "unsupported") {
      prompt.write(`\nRecommended user-level install:\n  ${PI_INSTALL_COMMAND}\nThe explicit $HOME/.local prefix avoids a root-owned npm global directory. No sudo, shell-profile edits, or npm install scripts are used.\n`);
      if (!await prompt.confirm("Install this compatible Pi version now", true)) {
        prompt.write("\nNo Pi installation was attempted. Run the command above, then rerun `pi-together onboard`.\n");
        return false;
      }
      prompt.write("\nInstalling Pi under the user-owned $HOME/.local prefix…\n");
      await io.installPi();
      pi = await io.probePi();
      prompt.write(`${statusText(pi)}\n`);
    }

    if (pi.status === "no-models") {
      if (!pi.piPath) throw new Error("Pi path is unavailable after installation");
      prompt.write("\n[2/3] Connect a model provider\nPi will open in this terminal. Use /login, select a provider, verify /model, then use /quit to return here.\n");
      if (!await prompt.confirm("Open Pi now", true)) {
        prompt.write("\nNo provider changes were attempted. Configure Pi and rerun `pi-together onboard`.\n");
        return false;
      }
      await io.launchPi(pi.piPath);
      pi = await io.probePi();
      prompt.write(`${statusText(pi)}\n`);
    }

    if (pi.status !== "ready") {
      throw new Error(`${statusText(pi)} Verify Pi manually, then rerun onboarding.`);
    }

    prompt.write("\nRepositories and sessions\n-------------------------\nPi Together does not clone repositories or manage Git credentials. Clone repositories normally with Git; repositories beneath owner-approved shared folders appear automatically. Every allowed GitHub user receives every repository in those folders. GitHub repository membership is not checked, and Pi is not a filesystem sandbox.\n");
    const candidates = await io.detectWorkspaceCandidates?.() ?? [];
    if (candidates.length) {
      prompt.write("\nDetected shared-folder candidates (suggestions only; nothing is approved yet)\n");
      candidates.forEach((candidate, index) => prompt.write(`${index + 1}  ${candidate.folder}  ${candidate.unavailableReason ?? `${candidate.repositoryCount} repositories${candidate.truncated ? " (scan truncated)" : ""}`}\n`));
    } else prompt.write("\nNo eligible shared-folder candidates were detected. Choose “Enter another folder…”; a missing path beneath your canonical home can be created after confirmation.\n");
    prompt.write("\n[3/3] Install Pi Together\nNext you will choose local or HTTPS access and explicitly select shared repository folders.\nAfter a short summary, choose Install now, Show technical plan, or Cancel. Secrets stay hidden and discovery remains read-only until installation is confirmed.\n");
    if (!await prompt.confirm("Continue to Pi Together installation", true)) {
      prompt.write("\nOnboarding paused. Pi is ready; rerun `pi-together onboard` when convenient.\n");
      return false;
    }
    handedToSetup = true;
    await setup(prompt, pi, candidates);
    return true;
  } finally {
    if (!handedToSetup) prompt.close?.();
  }
}
