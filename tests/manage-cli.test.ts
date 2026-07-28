import { describe, expect, it } from "vitest";
import { runManage, type ManagePrompter } from "../cli/manage.js";

class Prompt implements ManagePrompter {
  output = "";
  closed = false;
  constructor(private readonly answers: string[], private readonly confirmations: boolean[] = []) {}
  async text(): Promise<string> { return this.answers.shift() ?? "5"; }
  async confirm(): Promise<boolean> { return this.confirmations.shift() ?? false; }
  write(message: string): void { this.output += message; }
  close(): void { this.closed = true; }
}

describe("administration menu", () => {
  it("routes list, add, and remove through one user-management implementation", async () => {
    const prompt = new Prompt(["1", "2", "alice", "3", "bob", "5"]);
    const calls: string[][] = [];
    await runManage(prompt, async (args, options) => {
      calls.push(args);
      options.write?.(`ran ${args[0]}\n`);
      return true;
    });
    expect(calls).toEqual([["list"], ["add", "alice"], ["remove", "bob"]]);
    expect(prompt.output).toContain("Pi Together administration");
    expect(prompt.closed).toBe(true);
  });

  it("keeps the menu usable after an invalid choice or action failure", async () => {
    const prompt = new Prompt(["unknown", "1", "5"]);
    await runManage(prompt, async () => { throw new Error("injected"); });
    expect(prompt.output).toContain("Unknown choice");
    expect(prompt.output).toContain("Unable to complete that action: injected");
  });
});
