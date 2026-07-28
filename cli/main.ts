#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_INSTALL_COMMAND } from "./discovery.js";
import { PI_COMPATIBILITY, supportsPiVersion } from "./pi-version.js";
import { configuredLogSecrets, renderDoctor, renderStatus, runDoctor, runStatus, streamOwnedLogs, type LogComponent } from "./diagnostics.js";
import { runOnboarding } from "./onboard.js";
import { runRecover } from "./recover.js";
import { runManage } from "./manage.js";
import { runSetup } from "./setup.js";
import { runShareCommand } from "./share.js";
import { verifyPublicLogin } from "./verify-login.js";
import { runTailscaleLogin, runTailscalePrepare } from "./tailscale.js";
import { runUninstall } from "./uninstall.js";
import { runUpgradeCommand } from "./upgrade.js";
import { runUsersCommand } from "./users.js";
import { runWorkspacesCommand } from "./workspaces.js";

const cliFile = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(cliFile), "..", "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  piCompatibility?: string;
};
const command = process.argv[2] ?? "onboard";
const safeError = (error: unknown): string => (error instanceof Error ? error.message : "unknown error")
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500);

function printHelp(): void {
  process.stdout.write(`Pi Together ${packageJson.version}\n\nUsage: pi-together <command>\n\nCommands:\n  start          Start the packaged server\n  onboard        Guided Pi installation/login and Pi Together planning\n  manage         Interactive administration menu\n  users          List, add, or remove allowed GitHub users\n  workspaces     List, detect, or configure shared repository folders\n  share          Enable, disable, or inspect Tailscale Funnel sharing\n  tailscale      Prepare the pinned Tailscale prerequisite\n  setup          Collect secure answers and run unprivileged discovery\n  doctor         Run stable redacted component diagnostics [--json]\n  status         Show installed release and service state [--json]\n  logs           Read redacted logs for an owned component\n  upgrade        Apply an exact signed immutable release\n  recover        Review and recover one interrupted privileged operation\n  uninstall      Remove manifest-owned integration safely\n  version        Print package and Pi compatibility versions\n  help           Show this help\n`);
}

if (command === "version" || command === "--version" || command === "-v") {
  process.stdout.write(`${packageJson.version} (Pi ${packageJson.piCompatibility ?? "compatibility unknown"})\n`);
} else if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "onboard") {
  if (process.argv.length > 3) {
    process.stderr.write("Usage: pi-together onboard\n");
    process.exitCode = 2;
  } else {
    try { await runOnboarding(); }
    catch (error) { process.stderr.write(`Onboarding stopped: ${(error as Error).message}\n`); process.exitCode = 1; }
  }
} else if (command === "manage") {
  if (process.argv.length > 3) {
    process.stderr.write("Usage: pi-together manage\n");
    process.exitCode = 2;
  } else {
    try { await runManage(); }
    catch (error) { process.stderr.write(`Administration stopped: ${(error as Error).message}\n`); process.exitCode = 1; }
  }
} else if (command === "users") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together users list [--json] | add <github-login> [--yes] | remove <github-login> [--yes]\n\nPublic installations only. Adds are verified with GitHub before review and independently reverified inside the privileged boundary.\n");
  } else {
    try { await runUsersCommand(process.argv.slice(3)); }
    catch (error) { process.stderr.write(`User management failed: ${(error as Error).message}\n`); process.exitCode = 1; }
  }
} else if (command === "workspaces") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together workspaces list [--json] | detect [--json] | configure [--folders <comma-separated>] [--yes]\n\nOnly complete shared-folder sets are configured; repositories are derived and never registered.\n");
  } else {
    try { await runWorkspacesCommand(process.argv.slice(3)); }
    catch (error) { process.stderr.write(`Workspace management failed: ${(error as Error).message}\n`); process.exitCode = 1; }
  }
} else if (command === "share") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together share enable|disable|status|verify [--yes]\n");
  } else {
    try { await runShareCommand(process.argv.slice(3)); }
    catch (error) { process.stderr.write(`Sharing failed: ${(error as Error).message}\n`); process.exitCode = 1; }
  }
} else if (command === "tailscale") {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) process.stdout.write("Usage: pi-together tailscale prepare --accept-terms | login\n");
  else if (args[0] === "login" && args.length === 1) { try { await runTailscaleLogin(); } catch (error) { process.stderr.write(`Tailscale login failed: ${(error as Error).message}\n`); process.exitCode = 1; } }
  else if (args[0] !== "prepare" || args.some((arg) => !["prepare", "--accept-terms"].includes(arg))) { process.stderr.write("Usage: pi-together tailscale prepare --accept-terms | login\n"); process.exitCode = 2; }
  else { try { await runTailscalePrepare({ acceptedTerms: args.includes("--accept-terms") }); } catch (error) { process.stderr.write(`Tailscale preparation failed: ${(error as Error).message}\n`); process.exitCode = 1; } }
} else if (command === "setup") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`Usage: pi-together setup [--dry-run | --apply [--yes]] [--non-interactive <answers.json>]\n\nPi ${PI_COMPATIBILITY} with a configured model must already be available to the invoking user.\nInstall Pi if needed: ${PI_INSTALL_COMMAND}\nDiscovery is unprivileged; all mutation remains behind --apply and the reviewed digest. Own Domain is not supported in 0.1.x.\n`);
  } else {
    try {
      const setupArgs = process.argv.slice(3);
      const result = await runSetup(setupArgs);
      if (!result.report.safeToPlan) process.exitCode = 1;
      else if (setupArgs.includes("--apply") && !setupArgs.includes("--non-interactive") && result.answers.mode !== "local" && result.answers.startNow) {
        const origin = result.answers.mode === "tailscale-funnel" ? `https://${result.answers.tailscaleDnsName}` : `https://${result.answers.domain}`;
        await verifyPublicLogin({ origin, expectedLogin: result.answers.githubLogins[0]!, write: (message) => process.stdout.write(message) });
      }
    } catch (error) {
      process.stderr.write(`Setup failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
} else if (command === "doctor") {
  const args = process.argv.slice(3);
  if (args.some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: pi-together doctor [--json]\n");
    process.exitCode = 2;
  } else {
    const report = await runDoctor({ expectedManifestPath: join(packageRoot, "dist", "release", "manifest.json") });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(report)}\n` : `${renderDoctor(report)}\n`);
    if (report.overall === "fail") process.exitCode = 1;
  }
} else if (command === "status") {
  const args = process.argv.slice(3);
  if (args.some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: pi-together status [--json]\n");
    process.exitCode = 2;
  } else {
    const report = await runStatus();
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(report)}\n` : `${renderStatus(report)}\n`);
    if (!report.installed) process.exitCode = 1;
  }
} else if (command === "logs") {
  const args = process.argv.slice(3);
  const componentIndex = args.indexOf("--component");
  const component = componentIndex >= 0 ? args[componentIndex + 1] : undefined;
  const allowed = new Set(["app", "oauth2-proxy", "edge", "funnel", "nginx", "certbot"]);
  const consumed = new Set<number>(componentIndex >= 0 ? [componentIndex, componentIndex + 1] : []);
  const unknown = args.some((arg, index) => !consumed.has(index) && arg !== "--follow");
  if (!component || !allowed.has(component) || unknown) {
    process.stderr.write("Usage: pi-together logs [--follow] --component app|oauth2-proxy|edge|funnel|nginx|certbot\n");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await streamOwnedLogs(component as LogComponent, args.includes("--follow"), await configuredLogSecrets());
    } catch {
      process.stderr.write("Unable to read owned component logs. Check journal permissions.\n");
      process.exitCode = 1;
    }
  }
} else if (command === "upgrade") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together upgrade [<version>|latest] [--bundle <directory>] [--dry-run] [--yes]\n\nReads one owner-downloaded signed release bundle from ./release-bundle by default (or PI_TOGETHER_RELEASE_BUNDLE_DIR). Branches, prereleases, unsigned builds, and non-increasing versions are rejected.\n");
  } else {
    try { await runUpgradeCommand(process.argv.slice(3)); }
    catch { process.stderr.write("Upgrade failed or rolled back. Run doctor and inspect redacted owned logs.\n"); process.exitCode = 1; }
  }
} else if (command === "recover") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together recover [--yes]\n\nInspects exact root-owned recovery journals, explains the rollback, and requires confirmation before mutation.\n");
  } else {
    try { await runRecover(process.argv.slice(3)); }
    catch (error) { process.stderr.write(`Recovery failed: ${safeError(error)}\n`); process.exitCode = 1; }
  }
} else if (command === "uninstall") {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("Usage: pi-together uninstall [--purge-config] [--yes]\n\nOnly installation-manifest-owned integration is removed. Pi data, workspaces, credentials, and backups are always preserved.\n");
  } else {
    try { await runUninstall(process.argv.slice(3)); }
    catch (error) { process.stderr.write(`Uninstall failed: ${safeError(error)}\nRun doctor or retry the same command.\n`); process.exitCode = 1; }
  }
} else if (command === "start") {
  const piBin = process.env.PI_BIN ?? "pi";
  let installedVersion = "";
  try {
    installedVersion = execFileSync(piBin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    process.stderr.write(`Unable to execute ${piBin} --version. Install a compatible Pi as the service user before starting:\n${PI_INSTALL_COMMAND}\nThen run pi and use /login to configure a provider.\n`);
    process.exit(1);
  }
  if (!supportsPiVersion(installedVersion)) {
    process.stderr.write(`Unsupported Pi version ${installedVersion || "unknown"}; this package requires ${PI_COMPATIBILITY}.\n`);
    process.exit(1);
  }
  const server = join(packageRoot, "dist", "server", "index.js");
  const child = spawn(process.execPath, [server, ...process.argv.slice(3)], {
    stdio: "inherit",
    env: {
      ...process.env,
      PI_TOGETHER_CLIENT_DIR: join(packageRoot, "dist", "client"),
      PI_TOGETHER_ATTRIBUTION_EXTENSION: join(packageRoot, "dist", "extension", "pi-together-attribution-v1.js"),
      PI_TOGETHER_GIT_LAUNCHER: join(packageRoot, "dist", "extension", "git-bin", "git"),
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`Unable to start Pi Together: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  process.exitCode = 2;
}
