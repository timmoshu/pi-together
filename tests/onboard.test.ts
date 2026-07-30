import { describe, expect, it } from "vitest";
import { piInstallArguments, runOnboarding, userNpmPrefix, type OnboardingIo } from "../cli/onboard.js";
import type { PiPrerequisite } from "../cli/discovery.js";
import type { SetupPrompter } from "../cli/setup.js";

class Prompt implements SetupPrompter {
  output = "";
  closed = false;
  constructor(private readonly answers: boolean[]) {}
  async text(): Promise<string> { throw new Error("text input not expected"); }
  async secret(): Promise<string> { throw new Error("secret input not expected"); }
  async confirm(): Promise<boolean> { return this.answers.shift() ?? false; }
  async select<T>(): Promise<T> { throw new Error("selection not expected"); }
  async checkbox<T>(): Promise<T[]> { throw new Error("selection not expected"); }
  write(message: string): void { this.output += message; }
  close(): void { this.closed = true; }
}

function sequence(values: PiPrerequisite[], events: string[]): OnboardingIo {
  return {
    uid: () => 1000,
    probePi: async () => values.shift() ?? { status: "probe-failed" },
    installPi: async () => { events.push("install"); },
    launchPi: async (path) => { events.push(`login:${path}`); },
  };
}

describe("guided onboarding", () => {
  it("uses an explicit user-owned npm prefix without sudo or shell execution", () => {
    expect(userNpmPrefix("/home/example")).toBe("/home/example/.local");
    expect(piInstallArguments("/home/example/.local")).toEqual([
      "install", "--global", "--prefix", "/home/example/.local", "--ignore-scripts", "--no-audit", "--no-fund",
      "@earendil-works/pi-coding-agent@0.83",
    ]);
    expect(() => userNpmPrefix("/")).toThrow(/not safe/);
    expect(() => piInstallArguments("relative")).toThrow(/unsafe/);
  });

  it("refuses root before probing or installing Pi", async () => {
    const events: string[] = [];
    const prompt = new Prompt([]);
    const io = { ...sequence([{ status: "missing" }], events), uid: () => 0 };
    await expect(runOnboarding(prompt, io)).rejects.toThrow(/non-root/);
    expect(events).toEqual([]);
    expect(prompt.closed).toBe(true);
  });

  it("continues directly to deployment planning when Pi is ready", async () => {
    const events: string[] = [];
    const prompt = new Prompt([true]);
    const ready: PiPrerequisite = { status: "ready", piPath: "/usr/bin/pi", version: "0.83.0", modelCount: 1 };
    expect(await runOnboarding(prompt, sequence([ready], events), async () => { events.push("setup"); })).toBe(true);
    expect(events).toEqual(["setup"]);
    expect(prompt.output).toContain("[1/3] Check Pi");
    expect(prompt.output).toContain("[3/3] Install Pi Together");
    expect(prompt.output).toContain("choose Install now");
    expect(prompt.output).not.toContain("setup --apply");
    expect(prompt.output).toContain("does not clone repositories or manage Git credentials");
    expect(prompt.output).toContain("Every allowed GitHub user receives every repository");
    expect(prompt.output).not.toContain(process.cwd());
  });

  it("passes detected workspace choices into deployment planning", async () => {
    const events: string[] = [];
    const prompt = new Prompt([true]);
    const ready: PiPrerequisite = { status: "ready", piPath: "/usr/bin/pi", version: "0.83.0", modelCount: 1 };
    const candidate = { folder: "/home/example/cc-sandbox", repositoryCount: 1, truncated: false };
    const io: OnboardingIo = { ...sequence([ready], events), detectWorkspaceCandidates: async () => [candidate] };
    expect(await runOnboarding(prompt, io, async (_active, _pi, candidates) => {
      expect(candidates).toEqual([candidate]);
      events.push("setup");
    })).toBe(true);
    expect(prompt.output).toContain("/home/example/cc-sandbox");
  });

  it("can explicitly install Pi, open login, recheck, and continue", async () => {
    const events: string[] = [];
    const prompt = new Prompt([true, true, true]);
    const states: PiPrerequisite[] = [
      { status: "missing" },
      { status: "no-models", piPath: "/home/example/.local/bin/pi", version: "0.83.4", modelCount: 0 },
      { status: "ready", piPath: "/home/example/.local/bin/pi", version: "0.83.4", modelCount: 2 },
    ];
    expect(await runOnboarding(prompt, sequence(states, events), async () => { events.push("setup"); })).toBe(true);
    expect(events).toEqual(["install", "login:/home/example/.local/bin/pi", "setup"]);
    expect(prompt.output).toContain("$HOME/.local prefix");
    expect(prompt.output).toContain("No sudo, shell-profile edits, or npm install scripts are used");
    expect(prompt.output).toContain("Use /login");
  });

  it("leaves the host unchanged when Pi installation is declined", async () => {
    const events: string[] = [];
    const prompt = new Prompt([false]);
    expect(await runOnboarding(prompt, sequence([{ status: "missing" }], events), async () => { events.push("setup"); })).toBe(false);
    expect(events).toEqual([]);
    expect(prompt.closed).toBe(true);
    expect(prompt.output).toContain("No Pi installation was attempted");
  });
});
