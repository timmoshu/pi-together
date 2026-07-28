import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { candidateRelease, ReleaseMetadataSchema, selectUpgradeVersion, validateSignedRelease, type SignedRelease } from "./upgrade-core.js";
import { UpgradeReleaseIdSchema } from "./release-identity.js";
import { UpgradeRequestSchema, type UpgradeRequest } from "../privileged/upgrade-request.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";

async function readNoFollow(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error("release bundle input is not a bounded regular file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function loadReleaseBundle(root: string): Promise<{ candidate: SignedRelease; archivePath: string }> {
  const canonical = await realpath(root);
  const names = await readdir(canonical);
  const archives = names.filter((name) => name.endsWith(".tgz") && !name.includes("/"));
  if (archives.length !== 1) throw new Error("release bundle must contain exactly one package archive");
  const metadata = ReleaseMetadataSchema.parse(JSON.parse((await readNoFollow(join(canonical, "metadata.json"), 1024 * 1024)).toString("utf8")));
  const signature = JSON.parse((await readNoFollow(join(canonical, "signature.json"), 1024 * 1024)).toString("utf8")) as { keyId?: string; signature?: string };
  const candidate = validateSignedRelease({ metadata, keyId: signature.keyId ?? "", signature: signature.signature ?? "" });
  const archivePath = join(canonical, archives[0]!);
  const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 256 * 1024 * 1024 || info.uid !== (process.getuid?.() ?? info.uid)) throw new Error("release bundle archive metadata is unsafe");
  } finally { await handle.close(); }
  if (createHash("sha256").update(await readNoFollow(archivePath, 256 * 1024 * 1024)).digest("hex") !== candidate.metadata.packageSha256) {
    throw new Error("release bundle package checksum mismatch");
  }
  return { candidate, archivePath };
}

export function resolveReleaseBundleRoot(explicit: string | undefined, environment: string | undefined, cwd = process.cwd()): string {
  return resolve(cwd, explicit ?? environment ?? "release-bundle");
}

export async function loadCurrentRelease(root = "/opt/pi-together"): Promise<string> {
  const canonicalRoot = await realpath(root);
  const current = await realpath(join(canonicalRoot, "current"));
  const prefix = `${join(canonicalRoot, "releases")}/`;
  if (!current.startsWith(prefix)) throw new Error("installed release link is invalid");
  const release = UpgradeReleaseIdSchema.parse(current.slice(prefix.length));
  if (current !== join(canonicalRoot, "releases", release)) throw new Error("installed release link is invalid");
  return release;
}

export interface UpgradeCommandOptions {
  bundleRoot?: string;
  loadBundle?: (root: string) => Promise<{ candidate: SignedRelease; archivePath: string }>;
  loadCurrent?: () => Promise<string>;
  confirm?: (message: string) => Promise<boolean>;
  write?: (message: string) => void;
  uid?: number;
}

function parseUpgradeArgs(args: string[]): { dryRun: boolean; yes: boolean; requested?: string; bundle?: string } {
  let bundle: string | undefined;
  const positional: string[] = [];
  let dryRun = false;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--dry-run") dryRun = true;
    else if (value === "--yes") yes = true;
    else if (value === "--bundle") {
      const next = args[++index];
      if (!next || next.startsWith("--") || bundle) throw new Error("--bundle requires one directory");
      bundle = next;
    } else if (value.startsWith("--")) throw new Error("invalid upgrade options");
    else positional.push(value);
  }
  if (positional.length > 1 || (dryRun && yes)) throw new Error("invalid upgrade options");
  return { dryRun, yes, requested: positional[0], bundle };
}

export async function runUpgradeCommand(args: string[], invoke?: (request: UpgradeRequest) => Promise<void>, options: UpgradeCommandOptions = {}): Promise<boolean> {
  const write = options.write ?? ((message: string) => stdout.write(message));
  const parsed = parseUpgradeArgs(args);
  const bundleRoot = resolveReleaseBundleRoot(parsed.bundle ?? options.bundleRoot, process.env.PI_TOGETHER_RELEASE_BUNDLE_DIR);
  const loaded = await (options.loadBundle ?? loadReleaseBundle)(bundleRoot);
  const current = await (options.loadCurrent ?? loadCurrentRelease)();
  const target = selectUpgradeVersion(parsed.requested, [candidateRelease(loaded.candidate)], current);
  write(`Upgrade ${current} -> ${target}\nSource: ${loaded.candidate.metadata.sourceRef} at ${loaded.candidate.metadata.sourceCommit}\nSigning key: ${loaded.candidate.keyId}\nThe candidate will be staged immutably and health failure restores the current release.\n`);
  if (parsed.dryRun) { write("Dry-run only; no release, config, symlink, or service changed.\n"); return false; }
  if (!parsed.yes) {
    let confirmed: boolean;
    if (options.confirm) confirmed = await options.confirm("Apply this exact signed upgrade?");
    else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try { confirmed = /^(?:y|yes)$/i.test((await prompt.question("Apply this exact signed upgrade? [y/N] ")).trim()); }
      finally { prompt.close(); }
    }
    if (!confirmed) return false;
  }
  const request = UpgradeRequestSchema.parse({ protocolVersion: 1, action: "upgrade", candidate: loaded.candidate, archivePath: loaded.archivePath, invokingUid: options.uid ?? process.getuid?.() });
  if (invoke) await invoke(request);
  else await runPrivilegedLifecycle(request, "upgrade");
  write(`Upgrade to ${target} complete.\n`);
  return true;
}
