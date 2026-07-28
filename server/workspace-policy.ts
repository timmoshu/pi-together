// Bounded, read-only Git repository discovery and the deployment-wide workspace authorization boundary.
// Repository results are derived from disk and never persisted.
import { execFile } from "node:child_process";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CONTROLS = /[\u0000-\u001f\u007f]/;
const PRUNED = new Set([
  ".git", ".pi", ".ssh", ".config", ".cache", ".local", ".npm", "node_modules",
  "vendor", "dist", "build", "target", "coverage", ".next", ".turbo", ".venv", "__pycache__",
]);
const CONVENTIONAL = ["projects", "src", "code", "work", "dev"] as const;
const MAX_HOME_CANDIDATE_ENTRIES = 256;

export interface DiscoveryBudgets {
  maxDepth: number;
  maxEntries: number;
  maxRepositories: number;
  maxOutputBytes: number;
  commandTimeoutMs: number;
  totalTimeoutMs: number;
}
const DEFAULT_BUDGETS: DiscoveryBudgets = {
  maxDepth: 8,
  maxEntries: 20_000,
  maxRepositories: 512,
  maxOutputBytes: 1024 * 1024,
  commandTimeoutMs: 3_000,
  totalTimeoutMs: 15_000,
};

export interface RepositoryFact {
  sourceFolder: string;
  identity: string;
  mainWorktree: string;
  worktree: string;
  linkedWorktrees: string[];
  label: string;
  sessionCount: number;
}
export interface DiscoveryResult { repositories: RepositoryFact[]; truncated: boolean; scannedEntries: number }
export interface FolderCandidate {
  folder: string;
  repositoryCount: number;
  truncated: boolean;
  /** Present only for a detected folder that cannot be approved under the shared-folder policy. */
  unavailableReason?: string;
}

/** One deliberately detail-free error class for every public path/authorization failure. */
export class WorkspaceNotFoundError extends Error {
  readonly code = "ENOENT";
  readonly httpStatus = 404;
  readonly responseBody = { error: "workspace not found" };
  constructor() { super("workspace not found"); }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function canonicalSharedFolders(input: readonly string[]): string[] {
  if (input.length < 1 || input.length > 16) throw new Error("shared repository folders must contain 1 to 16 paths");
  const folders = input.map((value) => {
    if (!isAbsolute(value) || value === "/" || CONTROLS.test(value) || normalize(value) !== value) {
      throw new Error("shared repository folder must be a canonical absolute non-root path");
    }
    return value;
  }).sort();
  for (let index = 0; index < folders.length; index++) {
    for (let prior = 0; prior < index; prior++) {
      if (within(folders[prior]!, folders[index]!)) throw new Error("shared repository folders must not duplicate or contain one another");
    }
  }
  return folders;
}

export async function validateSharedFolders(input: readonly string[], expectedUid = process.getuid?.()): Promise<string[]> {
  const folders = canonicalSharedFolders(input);
  for (const folder of folders) {
    let info;
    try { info = await lstat(folder); }
    catch { throw new Error("shared repository folder must be an existing directory"); }
    if (info.isSymbolicLink()) throw new Error("shared repository folder must not be a symbolic link");
    if (!info.isDirectory()) throw new Error("shared repository folder must be an existing directory");
    if (expectedUid !== undefined && info.uid !== expectedUid) throw new Error("shared repository folder must be owned by the service user");
    const canonical = await realpath(folder);
    if (canonical !== folder) throw new Error("shared repository folder must be an exact canonical path without symbolic links");
  }
  return folders;
}

interface GitFacts { identity: string; top: string; worktrees: string[] }

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

function onePath(output: string): string {
  const value = output.replace(/\n$/, "");
  if (!value || value.includes("\n") || CONTROLS.test(value) || !isAbsolute(value) || normalize(value) !== value) throw new Error("malformed Git path output");
  return value;
}

function parseWorktrees(output: string): string[] {
  if (Buffer.byteLength(output) === 0) throw new Error("empty Git worktree output");
  const paths: string[] = [];
  for (const record of output.trimEnd().split("\n\n")) {
    const lines = record.split("\n");
    if (!lines[0]?.startsWith("worktree ")) throw new Error("malformed Git worktree output");
    const value = lines[0].slice("worktree ".length);
    if (!isAbsolute(value) || normalize(value) !== value || CONTROLS.test(value)) throw new Error("malformed Git worktree path");
    if (lines.some((line) => line === "bare")) continue;
    paths.push(value);
  }
  return [...new Set(paths)];
}

async function gitFacts(cwd: string, budgets: DiscoveryBudgets): Promise<GitFacts> {
  const run = async (args: string[]): Promise<string> => {
    const result = await exec("git", ["--no-optional-locks", "-C", cwd, ...args], {
      env: safeGitEnvironment(), timeout: budgets.commandTimeoutMs, maxBuffer: budgets.maxOutputBytes,
      windowsHide: true,
    });
    if (Buffer.byteLength(result.stdout) >= budgets.maxOutputBytes || CONTROLS.test(result.stdout.replace(/\n/g, ""))) throw new Error("unsafe Git output");
    return result.stdout;
  };
  if ((await run(["rev-parse", "--is-inside-work-tree"])).trim() !== "true") throw new Error("not a worktree");
  const top = onePath(await run(["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  const identity = onePath(await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktrees = parseWorktrees(await run(["worktree", "list", "--porcelain"]));
  return { top, identity, worktrees };
}

export class RepositoryDiscovery {
  readonly folders: string[];
  readonly budgets: DiscoveryBudgets;
  private refreshInFlight: Promise<DiscoveryResult> | null = null;

  constructor(folders: readonly string[], budgets: Partial<DiscoveryBudgets> = {}) {
    this.folders = canonicalSharedFolders(folders);
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
  }

  static async detectCandidates(home: string, budgets: Partial<DiscoveryBudgets> = {}): Promise<FolderCandidate[]> {
    if (!isAbsolute(home) || normalize(home) !== home || await realpath(home).catch(() => "") !== home) return [];
    const candidates: FolderCandidate[] = [];
    const names = new Set<string>(CONVENTIONAL);
    const homeDirectory = await opendir(home).catch(() => null);
    if (homeDirectory) {
      let scanned = 0;
      try {
        for await (const entry of homeDirectory) {
          if (++scanned > MAX_HOME_CANDIDATE_ENTRIES) break;
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || PRUNED.has(entry.name)) continue;
          const marker = await lstat(joinPath(joinPath(home, entry.name), ".git")).catch(() => null);
          if (marker && !marker.isSymbolicLink()) names.add(entry.name);
        }
      } finally { await homeDirectory.close().catch(() => undefined); }
    }
    for (const name of [...names].sort()) {
      const folder = joinPath(home, name);
      const info = await lstat(folder).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      try {
        const result = await new RepositoryDiscovery([folder], budgets).refresh();
        candidates.push({ folder, repositoryCount: result.repositories.length, truncated: result.truncated });
      } catch {
        // A detected direct repository may still be useful guidance when ownership or path identity
        // is invalid. Keep it visibly disabled; selection and privileged apply continue to fail closed.
        const expectedUid = process.getuid?.();
        const canonical = await realpath(folder).catch(() => "");
        const unavailableReason = expectedUid !== undefined && info.uid !== expectedUid
          ? "Not owned by the Pi service user."
          : canonical !== folder
            ? "Path is not canonical."
            : undefined;
        if (unavailableReason) candidates.push({ folder, repositoryCount: 0, truncated: false, unavailableReason });
      }
    }
    return candidates;
  }

  refresh(): Promise<DiscoveryResult> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.scan().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async scan(): Promise<DiscoveryResult> {
    await validateSharedFolders(this.folders);
    const started = Date.now();
    let scannedEntries = 0;
    let truncated = false;
    const repositories: RepositoryFact[] = [];

    const visit = async (folder: string, path: string, depth: number, device: number): Promise<void> => {
      if (truncated || repositories.length >= this.budgets.maxRepositories || Date.now() - started >= this.budgets.totalTimeoutMs) { truncated = true; return; }
      if (depth > this.budgets.maxDepth) { truncated = true; return; }
      const marker = await lstat(joinPath(path, ".git")).catch(() => null);
      if (marker && !marker.isSymbolicLink()) {
        try {
          const fact = await this.probe(path, folder);
          repositories.push(fact);
        } catch { /* Unverifiable repositories fail closed; scan may continue below malformed markers. */ }
        return;
      }
      let directory;
      try { directory = await opendir(path); } catch { return; }
      try {
        for await (const entry of directory) {
          scannedEntries++;
          if (scannedEntries > this.budgets.maxEntries) { truncated = true; break; }
          if (!entry.isDirectory() || entry.isSymbolicLink() || PRUNED.has(entry.name)) continue;
          const child = joinPath(path, entry.name);
          const childInfo = await lstat(child).catch(() => null);
          if (!childInfo?.isDirectory() || childInfo.isSymbolicLink() || childInfo.dev !== device) continue;
          await visit(folder, child, depth + 1, device);
          if (truncated) break;
        }
      } finally { await directory.close().catch(() => undefined); }
    };

    for (const folder of this.folders) {
      const info = await stat(folder);
      await visit(folder, folder, 0, info.dev);
      if (truncated) break;
    }
    repositories.sort((left, right) => left.mainWorktree.localeCompare(right.mainWorktree));
    return { repositories, truncated, scannedEntries };
  }

  private async probe(path: string, sourceFolder: string): Promise<RepositoryFact> {
    const endpoint = await lstat(path);
    if (!endpoint.isDirectory() || endpoint.isSymbolicLink()) throw new WorkspaceNotFoundError();
    const canonical = await realpath(path);
    if (canonical !== path) throw new WorkspaceNotFoundError();
    const facts = await gitFacts(path, this.budgets);
    if (facts.top !== path || !facts.worktrees.includes(path)) throw new WorkspaceNotFoundError();
    const main = facts.worktrees.find((candidate) => within(sourceFolder, candidate)) ?? path;
    if (!within(sourceFolder, main) || !within(sourceFolder, facts.identity)) throw new WorkspaceNotFoundError();
    const verified: string[] = [];
    for (const candidate of facts.worktrees) {
      const candidateInfo = await lstat(candidate).catch(() => null);
      if (!candidateInfo?.isDirectory() || candidateInfo.isSymbolicLink()) continue;
      if (await realpath(candidate).catch(() => "") === candidate) verified.push(candidate);
    }
    return {
      sourceFolder, identity: facts.identity, mainWorktree: main, worktree: path,
      linkedWorktrees: verified.filter((candidate) => candidate !== main), label: basename(main), sessionCount: 0,
    };
  }

  approvedFolders(): readonly string[] { return [...this.folders]; }

  /** Revalidates at use time; scan/cache output is never authorization evidence. */
  async authorize(input: string): Promise<RepositoryFact> {
    try {
      if (!isAbsolute(input) || input === "/" || CONTROLS.test(input) || normalize(input) !== input) throw new Error();
      const info = await lstat(input);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const canonical = await realpath(input);
      if (canonical !== input) throw new Error();
      const facts = await gitFacts(input, this.budgets);
      if (!facts.worktrees.includes(facts.top)) throw new Error();
      for (const folder of this.folders) {
        // Normal worktree (or a cwd within it).
        if (within(folder, facts.top) && within(folder, facts.identity)) return this.probe(facts.top, folder);
        // External linked worktree: common Git identity and exact top-level membership remain in policy.
        if (within(folder, facts.identity)) {
          const main = facts.worktrees.find((candidate) => within(folder, candidate));
          if (!main) continue;
          const authoritative = await gitFacts(main, this.budgets);
          if (authoritative.identity !== facts.identity || !authoritative.worktrees.includes(facts.top)) continue;
          const candidateInfo = await lstat(facts.top);
          if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink() || await realpath(facts.top) !== facts.top) continue;
          return {
            sourceFolder: folder, identity: facts.identity, mainWorktree: main, worktree: facts.top,
            linkedWorktrees: authoritative.worktrees.filter((candidate) => candidate !== main),
            label: basename(main), sessionCount: 0,
          };
        }
      }
    } catch { /* collapse every filesystem/Git reason */ }
    throw new WorkspaceNotFoundError();
  }
}

function joinPath(parent: string, child: string): string {
  return resolve(parent, child);
}
