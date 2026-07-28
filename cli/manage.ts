import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runUsersCommand, type UsersCommandOptions } from "./users.js";
import { runWorkspacesCommand, type WorkspaceCommandOptions } from "./workspaces.js";

export interface ManagePrompter {
  text(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  write(message: string): void;
  close(): void;
}

export class TerminalManagePrompter implements ManagePrompter {
  private readonly input: Interface = createInterface({ input: stdin, output: stdout });
  async text(message: string): Promise<string> { return (await this.input.question(`${message}: `)).trim(); }
  async confirm(message: string): Promise<boolean> {
    return /^(?:y|yes)$/i.test((await this.input.question(`${message} [y/N] `)).trim());
  }
  write(message: string): void { stdout.write(message); }
  close(): void { this.input.close(); }
}

export async function runManage(
  prompt: ManagePrompter = new TerminalManagePrompter(),
  users: (args: string[], options: UsersCommandOptions) => Promise<boolean> = runUsersCommand,
  workspaces: (args: string[], options: WorkspaceCommandOptions) => Promise<boolean> = runWorkspacesCommand,
): Promise<void> {
  try {
    prompt.write("\nPi Together administration\n==========================\nChanges are reviewed as the Pi service user and independently validated after sudo.\n");
    while (true) {
      prompt.write("\n1  List allowed GitHub users\n2  Add a GitHub user\n3  Remove a GitHub user\n4  Shared repository folders\n5  Exit\n");
      const choice = (await prompt.text("Choose an action")).toLowerCase();
      if (choice === "5" || choice === "exit" || choice === "quit" || choice === "q") return;
      let args: string[] | undefined;
      if (choice === "1" || choice === "list") args = ["list"];
      else if (choice === "2" || choice === "add") {
        const login = await prompt.text("GitHub username to add");
        if (login) args = ["add", login];
      } else if (choice === "3" || choice === "remove") {
        const login = await prompt.text("GitHub username to remove");
        if (login) args = ["remove", login];
      } else if (choice === "4" || choice === "workspaces") {
        const action = (await prompt.text("Workspace action (list / detect / configure)")).toLowerCase();
        if (["list", "detect", "configure"].includes(action)) {
          try {
            await workspaces([action], {
              text: (message) => prompt.text(message),
              confirm: (message) => prompt.confirm(message),
              write: (message) => prompt.write(message),
            });
          } catch (error) { prompt.write(`Unable to complete that action: ${(error as Error).message}\n`); }
        } else prompt.write("Unknown workspace action.\n");
        continue;
      } else {
        prompt.write("Unknown choice. Enter 1, 2, 3, 4, or 5.\n");
      }
      if (!args) continue;
      try {
        await users(args, {
          confirm: (message) => prompt.confirm(message),
          write: (message) => prompt.write(message),
        });
      } catch (error) {
        prompt.write(`Unable to complete that action: ${(error as Error).message}\n`);
      }
    }
  } finally { prompt.close(); }
}
