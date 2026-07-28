import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  TurnGitIdentityState,
  gitIdentityForActor,
  managedGitInvocation,
  type BotGitIdentity,
} from "../extension/git-identity-core.js";

const run = promisify(execFile);
const bot: BotGitIdentity = { name: "Pi Together", email: "" };
const alice = { provider: "github" as const, subject: "12345", login: "octocat" };
const bob = { provider: "github" as const, subject: "67890", login: "hubot" };

const attribution = (actor: typeof alice | typeof bob, action: "prompt" | "steer" | "followUp") => ({
  kind: "message" as const,
  requestId: `req_${actor.login}_${action}`,
  actor,
  action,
  viewerId: `viewer_${actor.login}`,
  issuedAt: "2026-07-25T00:00:00.000Z",
});

describe("per-turn Git identity", () => {
  it("uses the verified GitHub numeric subject and canonical login for author only", () => {
    expect(gitIdentityForActor(alice, bot)).toEqual({
      author: { name: "octocat", email: "12345+octocat@users.noreply.github.com" },
      committer: bot,
    });
  });

  it.each([
    undefined,
    { provider: "local", subject: "local", login: "owner" },
    { provider: "github", subject: "not-numeric", login: "octocat" },
    { provider: "github", subject: "12345", login: "bad login" },
  ])("falls back entirely to the bot for an unverified or malformed actor", (actor) => {
    const identity = gitIdentityForActor(actor, bot);
    expect(identity).toEqual({ author: bot, committer: bot });
    expect(JSON.stringify(identity)).not.toContain("users.noreply.github.com");
  });

  it("fixes the author to the delivered turn across takeover and switches only on later delivery", () => {
    const state = new TurnGitIdentityState(bot);
    state.accept(attribution(alice, "prompt"));
    state.deliverUserMessage();
    expect(state.identity.author.name).toBe("octocat");

    // Lease takeover is intentionally not an input to the state machine.
    expect(state.identity.author.name).toBe("octocat");

    state.accept(attribution(bob, "steer"));
    expect(state.identity.author.name).toBe("octocat");
    state.deliverUserMessage();
    expect(state.identity.author.name).toBe("hubot");
    expect(state.identity.committer).toEqual(bot);
  });

  it("attributes a queued follow-up to its queuer rather than a later controller", () => {
    const state = new TurnGitIdentityState(bot);
    state.accept(attribution(alice, "prompt"));
    state.deliverUserMessage();
    state.accept(attribution(bob, "followUp"));
    // A takeover has no state-machine operation and cannot rewrite the queued record.
    state.deliverUserMessage();
    expect(state.identity.author).toEqual({ name: "hubot", email: "67890+hubot@users.noreply.github.com" });
    expect(state.identity.committer).toEqual(bot);
  });

  it("creates a real commit with human author, bot committer, and agent/model trailer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-git-identity-"));
    await run("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, "file.txt"), "synthetic\n", "utf8");
    await run("git", ["-C", root, "add", "file.txt"]);
    const identity = gitIdentityForActor(alice, bot);
    const invocation = managedGitInvocation(
      ["-C", root, "commit", "-m", "synthetic commit"],
      process.env,
      identity,
      "Pi (anthropic/synthetic-model)",
    );
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--no-gpg-sign",
      "--trailer=Agent: Pi (anthropic/synthetic-model)",
    ]));
    await run("git", invocation.args, { env: invocation.env });
    const { stdout } = await run("git", ["-C", root, "cat-file", "-p", "HEAD"]);
    expect(stdout).toContain("author octocat <12345+octocat@users.noreply.github.com>");
    expect(stdout).toContain("committer Pi Together <>");
    expect(stdout).toContain("Agent: Pi (anthropic/synthetic-model)");
    expect((stdout.match(/^Agent:/gm) ?? [])).toHaveLength(1);

    await writeFile(join(root, "file.txt"), "synthetic amended\n", "utf8");
    await run("git", ["-C", root, "add", "file.txt"]);
    const amended = managedGitInvocation(
      ["-C", root, "commit", "--amend", "--no-edit"],
      process.env,
      gitIdentityForActor(bob, bot),
      "Pi (openai/second-model)",
    );
    await run("git", amended.args, { env: amended.env });
    const amendedCommit = (await run("git", ["-C", root, "cat-file", "-p", "HEAD"])).stdout;
    expect(amendedCommit).toContain("author hubot <67890+hubot@users.noreply.github.com>");
    expect(amendedCommit).toContain("committer Pi Together <>");
    expect(amendedCommit).toContain("Agent: Pi (openai/second-model)");
    expect((amendedCommit.match(/^Agent:/gm) ?? [])).toHaveLength(1);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("synthetic amended\n");
  });
});
