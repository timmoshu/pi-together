import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type WorkspaceFolderState = "directory" | "missing" | "invalid";

export interface WorkspaceFolderCreationIo {
  inspect(path: string): Promise<WorkspaceFolderState>;
  create(path: string, ownerHome: string): Promise<void>;
  empty(path: string): Promise<boolean>;
  initializeGit(path: string, ownerHome: string): Promise<void>;
}

function beneathHome(path: string, ownerHome: string): boolean {
  const child = relative(ownerHome, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export function canCreateWorkspaceFolder(path: string, ownerHome?: string): boolean {
  return !!ownerHome && beneathHome(path, ownerHome);
}

export const nodeWorkspaceFolderCreationIo: WorkspaceFolderCreationIo = {
  inspect: async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) return "invalid";
      return "directory";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    }
  },
  create: async (path, ownerHome) => {
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0 || !beneathHome(path, ownerHome) || await realpath(ownerHome) !== ownerHome) {
      throw new Error("workspace folder is not safely creatable beneath the invoking user's home");
    }
    let current = ownerHome;
    for (const segment of relative(ownerHome, path).split("/")) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
          throw new Error("workspace folder ancestor is unsafe");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    await mkdir(path, { recursive: true, mode: 0o755 });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || await realpath(path) !== path) {
      throw new Error("created workspace folder failed ownership or canonicalization checks");
    }
  },
  empty: async (path) => (await readdir(path)).length === 0,
  initializeGit: async (path, ownerHome) => {
    const uid = process.getuid?.();
    const [folder, git] = await Promise.all([lstat(path), lstat("/usr/bin/git")]);
    if (uid === undefined || uid === 0 || !folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== uid
      || await realpath(path) !== path || (await readdir(path)).length !== 0
      || !git.isFile() || git.isSymbolicLink() || git.uid !== 0 || (git.mode & 0o022) !== 0) {
      throw new Error("local Git initialization requires one empty canonical user-owned folder and the trusted system Git executable");
    }
    await exec("/usr/bin/git", ["init", "--initial-branch=main", "--", path], {
      timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", HOME: ownerHome, LANG: "C", LC_ALL: "C" },
    });
    const marker = await lstat(join(path, ".git"));
    if (!marker.isDirectory() || marker.isSymbolicLink() || marker.uid !== uid) throw new Error("initialized Git repository failed read-back validation");
  },
};
