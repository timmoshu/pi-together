import { chmod, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  RepositoryDiscovery,
  WorkspaceNotFoundError,
  canonicalSharedFolders,
  validateSharedFolders,
} from "../server/workspace-policy.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { cwd });
}
async function repo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-q"]);
  await writeFile(join(path, "README.md"), "synthetic\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-qm", "synthetic"]);
}

async function tree() {
  const home = await mkdtemp(join(tmpdir(), "pt-workspaces-"));
  const projects = join(home, "projects");
  const outside = join(home, "private");
  await mkdir(projects, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await repo(join(projects, "atlas"));
  await repo(join(outside, "secret"));
  return { home, projects, outside };
}

describe("shared repository policy", () => {
  it("canonicalizes a complete folder set and rejects broad, mixed, or redundant paths", () => {
    expect(canonicalSharedFolders(["/srv/work", "/home/owner/projects"])).toEqual(["/home/owner/projects", "/srv/work"]);
    for (const folders of [["/"], ["relative"], ["/srv/work/../private"], ["/srv/work", "/srv/work/client"], ["/srv", "/srv-other", "/srv/work"], ["/srv/work", "/srv/work"]]) {
      expect(() => canonicalSharedFolders(folders)).toThrow();
    }
  });

  it("requires existing, owner-controlled, non-symlink folder boundaries without treating mode bits as a sandbox", async () => {
    const { home, projects } = await tree();
    await expect(validateSharedFolders([projects], process.getuid?.())).resolves.toEqual([projects]);
    await chmod(projects, 0o777);
    await expect(validateSharedFolders([projects], process.getuid?.())).resolves.toEqual([projects]);
    await chmod(projects, 0o700);
    const link = join(home, "linked");
    await symlink(projects, link);
    await expect(validateSharedFolders([link], process.getuid?.())).rejects.toThrow(/symbolic/);
  });

  it("derives repositories, prunes nested repositories, and exposes truncation", async () => {
    const { projects } = await tree();
    await repo(join(projects, "atlas", "nested"));
    await mkdir(join(projects, "zzz-extra"));
    const discovery = new RepositoryDiscovery([projects]);
    const result = await discovery.refresh();
    expect(result.repositories.map((item) => item.label)).toEqual(["atlas"]);
    expect(result.truncated).toBe(false);

    const bounded = await new RepositoryDiscovery([projects], { maxEntries: 1 }).refresh();
    expect(bounded.truncated).toBe(true);
  });

  it("authorizes exact normal and linked worktrees but not outside or stale paths", async () => {
    const { home, projects, outside } = await tree();
    const atlas = join(projects, "atlas");
    const linked = join(home, "tasks", "atlas-branch");
    await mkdir(join(home, "tasks"), { recursive: true });
    await git(atlas, ["worktree", "add", "-q", "-b", "synthetic-linked", linked]);
    const policy = new RepositoryDiscovery([projects]);

    await expect(policy.authorize(atlas)).resolves.toMatchObject({ worktree: atlas });
    await expect(policy.authorize(join(atlas, "README.md"))).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(policy.authorize(linked)).resolves.toMatchObject({ worktree: linked });
    await expect(policy.authorize(join(outside, "secret"))).rejects.toBeInstanceOf(WorkspaceNotFoundError);

    await rename(linked, `${linked}-moved`);
    await expect(policy.authorize(linked)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("discovers conventional folders and direct home-child repositories independently of cwd", async () => {
    const { home, projects } = await tree();
    const direct = join(home, "cc-sandbox");
    await repo(direct);
    await chmod(direct, 0o700);
    const writable = join(home, "writable-repo");
    await repo(writable);
    await chmod(writable, 0o777);
    const candidates = await RepositoryDiscovery.detectCandidates(home);
    expect(candidates.map((candidate) => candidate.folder)).toEqual(expect.arrayContaining([projects, direct, writable]));
    expect(candidates.find((candidate) => candidate.folder === writable)?.unavailableReason).toBeUndefined();
    expect(candidates.some((candidate) => candidate.folder === home)).toBe(false);
  });
});
