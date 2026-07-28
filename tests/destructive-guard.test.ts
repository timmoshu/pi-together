import { describe, expect, it } from "vitest";
import { destructiveCommandReason } from "../extension/destructive-guard-core.js";

const config = { home: "/home/example", protectedAnchors: ["/home/example/testing", "/srv/shared"] };
const cwd = "/home/example/testing/project";

describe("Pi catastrophic command guard", () => {
  it.each([
    "rm -rf /",
    "rm -rf $HOME",
    "rm -rf ${HOME}/testing",
    "rm -rf ~/testing",
    "rm -rf /home/example/*",
    "rm -rf /srv/shared/*",
    "sudo /bin/rm -rf /home/example/testing",
    "cd /tmp && rm -rf /srv/shared",
    "rm -rf .",
    "rm -rf ../",
    "rm -rf .git",
    "find $HOME -delete",
    "git clean -fdx",
    "rm -rf $(printf /home/example/testing)",
  ])("blocks %s", (command) => expect(destructiveCommandReason(command, cwd, config)).toMatch(/^Blocked/));

  it.each([
    "rm -rf /home/example/testing/project/build",
    "rm -f /home/example/testing/project/output.txt",
    "find /home/example/testing/project/build -delete",
    "git status",
    "npm test",
  ])("allows ordinary repository work: %s", (command) => expect(destructiveCommandReason(command, cwd, config)).toBeNull());
});
