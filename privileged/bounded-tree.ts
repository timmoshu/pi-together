import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface BoundedTree {
  files: string[];
  directories: string[];
}

export function reviewedDirectoryPaths(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  return directories;
}

export async function inspectBoundedTree(root: string, label: string, maximumEntries = 10_000): Promise<BoundedTree> {
  const files: string[] = [];
  const directories = [root];
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries++;
      if (entries > maximumEntries) throw new Error(`${label} tree exceeds entry limit`);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
      if (entry.isDirectory()) {
        directories.push(path);
        pending.push(path);
      } else if (entry.isFile()) files.push(path);
      else throw new Error(`${label} contains an unsupported file type`);
    }
  }
  return { files: files.sort(), directories: directories.sort() };
}
