import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canCreateWorkspaceFolder, nodeWorkspaceFolderCreationIo } from "../cli/workspace-folder-creation.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("guided workspace folder creation", () => {
  it("creates and revalidates a canonical invoking-user-owned directory beneath home", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-together-owner-home-"));
    roots.push(home);
    const folder = join(home, "projects/testing");
    expect(canCreateWorkspaceFolder(folder, home)).toBe(true);
    expect(await nodeWorkspaceFolderCreationIo.inspect(folder)).toBe("missing");
    await nodeWorkspaceFolderCreationIo.create(folder, home);
    expect(await nodeWorkspaceFolderCreationIo.inspect(folder)).toBe("directory");
  });

  it("initializes only an empty canonical user-owned folder as a local repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-together-workspace-git-"));
    roots.push(home);
    const folder = join(home, "testing");
    await mkdir(folder);
    expect(await nodeWorkspaceFolderCreationIo.empty(folder)).toBe(true);
    await nodeWorkspaceFolderCreationIo.initializeGit(folder, home);
    expect(await nodeWorkspaceFolderCreationIo.empty(folder)).toBe(false);
    expect((await lstat(join(folder, ".git"))).isDirectory()).toBe(true);
    await expect(nodeWorkspaceFolderCreationIo.initializeGit(folder, home)).rejects.toThrow(/empty canonical/);
  });

  it("rejects outside-home creation and symbolic-link ancestors", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-together-owner-home-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-together-outside-"));
    roots.push(home, outside);
    expect(canCreateWorkspaceFolder(outside, home)).toBe(false);
    await expect(nodeWorkspaceFolderCreationIo.create(outside, home)).rejects.toThrow(/not safely creatable/);

    await mkdir(join(home, "real"));
    await symlink(join(home, "real"), join(home, "link"));
    await expect(nodeWorkspaceFolderCreationIo.create(join(home, "link/child"), home)).rejects.toThrow(/ancestor is unsafe/);
  });
});
