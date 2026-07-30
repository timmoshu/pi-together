import { describe, expect, it } from "vitest";
import { assertSupportedAccessMode, collectInteractiveAnswers, expandHomePath, runSetup, type SetupPrompter } from "../cli/setup.js";
import type { ProbeIo } from "../cli/discovery.js";
import type { PlanIo } from "../cli/operation-plan.js";

class ScriptedPrompt implements SetupPrompter {
  output = "";
  textCalls = 0;
  textDefaults: Array<string | undefined> = [];
  selectCalls = 0;
  checkboxCalls = 0;
  selectChoices: Array<{ value: unknown; name: string }> = [];
  checkboxChoices: Array<{ value: unknown; name: string; disabled?: boolean | string }> = [];
  constructor(private values: string[], private secretValue: string, private accepted: boolean | boolean[] = true) {}
  async text(_label?: string, defaultValue?: string): Promise<string> { this.textCalls++; this.textDefaults.push(defaultValue); return this.values.shift() ?? defaultValue ?? ""; }
  async secret(): Promise<string> { return this.secretValue; }
  async confirm(): Promise<boolean> {
    return Array.isArray(this.accepted) ? (this.accepted.shift() ?? false) : this.accepted;
  }
  async select<T>(_label: string, choices: ReadonlyArray<{ value: T; name: string }>): Promise<T> {
    this.selectCalls++;
    this.selectChoices = [...choices];
    return this.values.shift() as T;
  }
  async checkbox<T>(_label: string, choices: ReadonlyArray<{ value: T; name: string; disabled?: boolean | string }>): Promise<T[]> {
    this.checkboxCalls++;
    this.checkboxChoices = [...choices];
    return (this.values.shift() ?? "").split(",") as T[];
  }
  write(message: string): void { this.output += message; }
}

const planIo: PlanIo = {
  inspect: async (path) => ["/opt/node/bin/node", "/usr/bin/pi", "/etc/passwd", "/etc/group", "/etc/shadow", "/etc/gshadow"].includes(path)
    ? { kind: "file", sha256: "e".repeat(64), mode: 0o755, uid: 1000, gid: 1000 }
    : ["/srv/work", "/srv/other"].includes(path) ? { kind: "directory", mode: 0o750, uid: 1000, gid: 1000 }
    : { kind: "absent" },
  nginxInventory: async () => [],
  resolvePrincipal: async (login, observedAt) => ({
    provider: "github", subject: login === "alice" ? "1001" : "1002", login,
    verifiedAt: observedAt, verification: "verified",
  }),
  releaseManifest: async () => ({ version: "0.1.0", sha256: "d".repeat(64) }),
};

const io: ProbeIo = {
  platform: () => "linux",
  arch: () => "arm64",
  nodePath: "/opt/node/bin/node",
  nodeVersion: "v24.0.0",
  uid: () => 1000,
  username: "example",
  now: () => Date.parse("2026-07-25T00:00:00.000Z"),
  read: async () => "ID=debian\nVERSION_ID=12\n",
  exists: async (path) => path === "/run/systemd/system",
  realpath: async (path) => path,
  isDirectory: async () => true,
  exec: async (file, args) => {
    if (file === "which" && args[0] === "pi") return { stdout: "/usr/bin/pi\n", stderr: "" };
    if (file === "which") throw new Error("not installed");
    if (file === "/usr/bin/pi" && args[0] === "--version") return { stdout: "0.83.0\n", stderr: "" };
    if (file === "/usr/bin/pi") return { stdout: "provider model\nexample model\n", stderr: "" };
    if (file === "ss") return { stdout: "", stderr: "" };
    if (file === "timedatectl") return { stdout: "yes\n", stderr: "" };
    throw new Error("missing");
  },
  dns: async () => ["192.0.2.25"],
  availableLoopbackPort: async (ports) => ports[0],
};

describe("setup CLI", () => {
  it("rejects Own Domain at the shared interactive and noninteractive release boundary", () => {
    expect(() => assertSupportedAccessMode("reverse-proxy")).toThrow(/not supported/);
    expect(() => assertSupportedAccessMode("local")).not.toThrow();
    expect(() => assertSupportedAccessMode("tailscale-funnel")).not.toThrow();
  });

  it("uses navigable choices for access and detected shared folders", async () => {
    const prompt = new ScriptedPrompt(["local", "/home/example/cc-sandbox"], "unused");
    const answers = await collectInteractiveAnswers(prompt, undefined, undefined, undefined, [{
      folder: "/home/example/cc-sandbox", repositoryCount: 1, truncated: false,
    }]);
    expect(answers).toMatchObject({ mode: "local", sharedRepositoryFolders: ["/home/example/cc-sandbox"] });
    expect(prompt.selectCalls).toBe(1);
    expect(prompt.selectChoices.map((choice) => choice.value)).toEqual(["funnel", "local"]);
    expect(prompt.selectChoices[1]).toMatchObject({ value: "local", name: expect.stringMatching(/single-user.*SSH/i) });
    expect(prompt.checkboxCalls).toBe(1);
    expect(prompt.checkboxChoices.map((choice) => choice.value)).toContain("/home/example/cc-sandbox");
    expect(prompt.textCalls).toBe(0);
  });

  it("prefills canonical home and safely expands tilde when no repositories are detected", async () => {
    expect(expandHomePath("~/test", "/home/example")).toBe("/home/example/test");
    expect(expandHomePath("~other/test", "/home/example")).toBe("~other/test");
    const prompt = new ScriptedPrompt(
      ["local", "__pi_together_custom_workspace__", "~/test"],
      "unused",
      [true, false, true, false],
    );
    const answers = await collectInteractiveAnswers(
      prompt, undefined, undefined, undefined, [], async () => "/home/example",
    );
    expect(prompt.textDefaults[0]).toBe("/home/example");
    expect(answers.sharedRepositoryFolders).toEqual(["/home/example/test"]);
  });

  it("merges a duplicate custom folder immediately instead of failing after the questionnaire", async () => {
    const prompt = new ScriptedPrompt(
      ["local", "__pi_together_custom_workspace__", "/srv/work", "/srv/work"],
      "unused",
      [true, true, false, true, false],
    );
    const answers = await collectInteractiveAnswers(prompt);
    expect(answers.sharedRepositoryFolders).toEqual(["/srv/work"]);
    expect(prompt.output).toContain("already selected; keeping one");
  });

  it("offers to create a missing home-relative folder during guided onboarding", async () => {
    const prompt = new ScriptedPrompt(
      ["local", "__pi_together_custom_workspace__", "~/testing"],
      "unused",
      [true, true, false, false, true, false],
    );
    let state = "missing" as "missing" | "directory";
    const created: string[] = [];
    const answers = await collectInteractiveAnswers(
      prompt,
      undefined,
      undefined,
      undefined,
      [],
      async () => "/home/example",
      {
        inspect: async () => state,
        create: async (path) => { created.push(path); state = "directory"; },
        empty: async () => true,
        initializeGit: async () => { throw new Error("initialization was declined"); },
      },
    );
    expect(created).toEqual(["/home/example/testing"]);
    expect(answers.sharedRepositoryFolders).toEqual(["/home/example/testing"]);
    expect(prompt.output).toContain("Created /home/example/testing");
  });

  it("offers explicit installer-only Git initialization for an empty selected folder", async () => {
    const prompt = new ScriptedPrompt(
      ["local", "__pi_together_custom_workspace__", "/home/example/testing"], "unused",
      [true, false, true, true, false],
    );
    const initialized: string[] = [];
    const answers = await collectInteractiveAnswers(prompt, undefined, undefined, undefined, [], async () => "/home/example", {
      inspect: async () => "directory",
      create: async () => undefined,
      empty: async () => true,
      initializeGit: async (path) => { initialized.push(path); },
    });
    expect(initialized).toEqual(["/home/example/testing"]);
    expect(answers.sharedRepositoryFolders).toEqual(["/home/example/testing"]);
    expect(prompt.output).toContain("no remote or commit was created");
  });

  it("re-prompts an invalid custom workspace path without restarting onboarding", async () => {
    const prompt = new ScriptedPrompt(
      ["local", "__pi_together_custom_workspace__", "cc-sandbox", "/home/example/cc-sandbox"],
      "unused",
      [true, false, true, false],
    );
    const answers = await collectInteractiveAnswers(prompt);
    expect(answers.sharedRepositoryFolders).toEqual(["/home/example/cc-sandbox"]);
    expect(prompt.output).toContain("canonical absolute path");
  });

  it("continues from fresh Tailscale installation through login in the same onboarding run", async () => {
    const prompt = new ScriptedPrompt(["funnel", "/srv/work", "alice", "oauth-client-id"], "oauth-super-secret-value");
    const states = [
      { status: "missing" as const },
      { status: "probe-failed" as const, path: "/usr/bin/tailscale", version: "1.98.8" },
      { status: "needs-login" as const, path: "/usr/bin/tailscale", version: "1.98.8" },
      {
        status: "ready" as const, path: "/usr/bin/tailscale", version: "1.98.8",
        dnsName: "node.tailnet.ts.net", keyExpiry: "2027-01-01T00:00:00.000Z",
      },
    ];
    const events: string[] = [];
    const answers = await collectInteractiveAnswers(
      prompt,
      async () => states.shift() ?? states[states.length - 1]!,
      async () => { events.push("prepare"); },
      async () => { events.push("login"); },
      [{ folder: "/srv/work", repositoryCount: 0, truncated: false }],
      async () => "/home/example",
    );
    expect(events).toEqual(["prepare", "login"]);
    expect(answers).toMatchObject({ mode: "tailscale-funnel", tailscaleDnsName: "node.tailnet.ts.net" });
    expect(prompt.output).toContain("Waiting for the installed Tailscale daemon");
  });

  it("derives the stable Funnel origin from a ready Tailscale node", async () => {
    const prompt = new ScriptedPrompt(["funnel", "/srv/work", "Alice", "oauth-client-id"], "oauth-super-secret-value");
    const answers = await collectInteractiveAnswers(prompt, async () => ({
      status: "ready", path: "/usr/bin/tailscale", version: "1.98.8",
      dnsName: "node.tailnet.ts.net", keyExpiry: "2027-01-01T00:00:00.000Z",
    }));
    expect(answers).toMatchObject({ mode: "tailscale-funnel", tailscaleDnsName: "node.tailnet.ts.net" });
    expect(prompt.output).toContain("upstream beta");
    expect(prompt.output).toContain("Stable public origin: https://node.tailnet.ts.net");
  });

  it("does not expose Own Domain through interactive onboarding", async () => {
    const prompt = new ScriptedPrompt(["public"], "oauth-secret-value-that-must-not-be-read");
    await expect(runSetup(["--dry-run"], prompt, io, planIo)).rejects.toThrow(/easy sharing or local/);
    expect(prompt.selectChoices.map((choice) => choice.value)).toEqual(["funnel", "local"]);
    expect(prompt.textCalls).toBe(0);
  });

  it("installs directly from guided onboarding after a navigable confirmation without dumping the technical plan", async () => {
    let appliedDigest = "";
    const prompt = new ScriptedPrompt(["local", "/srv/work", "install"], "unused");
    const result = await runSetup(
      [], prompt, io, planIo, async (plan) => { appliedDigest = plan.planDigest; },
      undefined, undefined, [], { guidedInstall: true },
    );
    expect(appliedDigest).toBe(result.plan?.planDigest);
    expect(prompt.output).toContain("Ready to install");
    expect(prompt.output).toContain("Installation complete");
    expect(prompt.output).not.toContain("Redacted technical details");
    expect(prompt.output).not.toContain("Reviewable operation plan");
    expect(prompt.output).not.toContain("pi-together setup --apply");
    expect(prompt.selectChoices.map((choice) => choice.value)).toEqual(["install", "details", "cancel"]);
  });

  it("shows and opens the selected fallback port when the default local port is occupied", async () => {
    let configuredPort: number | undefined;
    const prompt = new ScriptedPrompt(["local", "/srv/work", "install"], "unused");
    await runSetup(
      [], prompt, { ...io, availableLoopbackPort: async (ports) => ports.find((port) => port > 43118) }, planIo,
      async (plan) => {
        const config = plan.operations.find((operation) => operation.id === "app-config");
        configuredPort = config?.kind === "write-file" ? JSON.parse(config.contentTemplate).listener.port : undefined;
      },
      undefined, undefined, [], { guidedInstall: true },
    );
    expect(configuredPort).toBe(43119);
    expect(prompt.output).toContain("Local address: http://127.0.0.1:43119");
    expect(prompt.output).toContain("Installation complete. Open http://127.0.0.1:43119");
  });

  it("offers the technical plan as an optional guided-onboarding choice, then installs in the same run", async () => {
    let applied = false;
    const prompt = new ScriptedPrompt(["local", "/srv/work", "details", "install"], "unused");
    const result = await runSetup(
      [], prompt, io, planIo, async () => { applied = true; },
      undefined, undefined, [], { guidedInstall: true },
    );
    expect(applied).toBe(true);
    expect(prompt.output).toContain("Redacted technical details");
    expect(prompt.output).toContain("Reviewable operation plan");
    expect(prompt.output).toContain(`Plan ${result.plan?.planDigest}`);
    expect(prompt.output).not.toContain("pi-together setup --apply");
  });

  it("lets guided onboarding cancel without mutation or a follow-up command", async () => {
    let applied = false;
    const prompt = new ScriptedPrompt(["local", "/srv/work", "cancel"], "unused");
    await runSetup(
      [], prompt, io, planIo, async () => { applied = true; },
      undefined, undefined, [], { guidedInstall: true },
    );
    expect(applied).toBe(false);
    expect(prompt.output).toContain("Installation cancelled");
    expect(prompt.output).not.toContain("pi-together setup --apply");
  });

  it("requires explicit plan confirmation before invoking the privileged runner", async () => {
    let appliedDigest = "";
    const prompt = new ScriptedPrompt(["local", "/srv/work"], "unused");
    const result = await runSetup(["--apply"], prompt, io, planIo, async (plan) => { appliedDigest = plan.planDigest; });
    expect(appliedDigest).toBe(result.plan?.planDigest);
    expect(prompt.output).toContain(`Plan ${result.plan?.planDigest}`);
  });

  it("stops before collecting answers when Pi is not installed", async () => {
    const prompt = new ScriptedPrompt(["local", "/srv/work"], "unused");
    const missingPiIo: ProbeIo = {
      ...io,
      exec: async (file, args) => {
        if (file === "which" && args[0] === "pi") throw new Error("not installed");
        return io.exec(file, args);
      },
    };
    await expect(runSetup(["--dry-run"], prompt, missingPiIo, planIo)).rejects.toThrow(/Pi is required/);
    expect(prompt.textCalls).toBe(0);
    expect(prompt.output).toContain("npm install --global --prefix \"$HOME/.local\" --ignore-scripts @earendil-works/pi-coding-agent@0.83");
    expect(prompt.output).toContain("No answers or secrets were collected");
  });

  it("stops before collecting answers when Pi has no configured model", async () => {
    const prompt = new ScriptedPrompt(["local", "/srv/work"], "unused");
    const noModelsIo: ProbeIo = {
      ...io,
      exec: async (file, args) => file === "/usr/bin/pi" && args.includes("--list-models")
        ? { stdout: "provider model\n", stderr: "" }
        : io.exec(file, args),
    };
    await expect(runSetup([], prompt, noModelsIo, planIo)).rejects.toThrow(/no configured models/i);
    expect(prompt.textCalls).toBe(0);
    expect(prompt.output).toContain("use /login");
  });

  it("rejects risk refusal and unknown mode before discovery", async () => {
    await expect(collectInteractiveAnswers(new ScriptedPrompt(["local", "/srv/work"], "unused", false))).rejects.toThrow();
    await expect(collectInteractiveAnswers(new ScriptedPrompt(["remote", "/srv/work"], "unused"))).rejects.toThrow(/access/);
    await expect(runSetup(["--unknown"], new ScriptedPrompt([], "unused"), io, planIo)).rejects.toThrow(/unknown setup option/);
    await expect(runSetup(["--non-interactive"], new ScriptedPrompt([], "unused"), io, planIo)).rejects.toThrow(/requires an answer file/);
    await expect(runSetup(["--dry-run", "--apply"], new ScriptedPrompt([], "unused"), io, planIo)).rejects.toThrow(/cannot be combined/);
    await expect(runSetup(["--non-interactive", "/tmp/answers", "--apply"], new ScriptedPrompt([], "unused"), io, planIo)).rejects.toThrow(/requires both --apply and --yes/);
  });
});
