import { constants } from "node:fs";
import { chmod, chown, lstat, open, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PrivilegedActionSchema, type PrivilegedAction } from "../shared/recovery-protocol.js";

export { PrivilegedActionSchema };
export type { PrivilegedAction };
const LockSchema = z.object({
  schemaVersion: z.literal(1),
  action: PrivilegedActionSchema,
  ownerPid: z.number().int().positive(),
}).strict();

interface LifecycleLockOptions {
  path?: string;
  rootIdentity?: { uid: number; gid: number };
  requireRoot?: boolean;
  processAlive?: (pid: number) => boolean;
}

export class PrivilegedLifecycleLock {
  private readonly path: string;
  private readonly rootIdentity: { uid: number; gid: number };
  private readonly processAlive: (pid: number) => boolean;
  private action?: PrivilegedAction;

  constructor(options: LifecycleLockOptions = {}) {
    this.path = options.path ?? "/run/pi-together-privileged.lock";
    this.rootIdentity = options.rootIdentity ?? { uid: 0, gid: 0 };
    if ((options.requireRoot ?? true) && process.getuid?.() !== 0) throw new Error("privileged lifecycle lock requires root");
    this.processAlive = options.processAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    });
  }

  private async read(): Promise<z.infer<typeof LockSchema>> {
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== this.rootIdentity.uid || info.gid !== this.rootIdentity.gid
        || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw new Error("privileged lifecycle lock metadata is unsafe");
      return LockSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
  }

  private async create(action: PrivilegedAction): Promise<boolean> {
    let handle;
    try { handle = await open(this.path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, action, ownerPid: process.pid })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(this.path, 0o600);
    await chown(this.path, this.rootIdentity.uid, this.rootIdentity.gid);
    this.action = action;
    return true;
  }

  async acquire(actionValue: PrivilegedAction): Promise<void> {
    const action = PrivilegedActionSchema.parse(actionValue);
    if (await this.create(action)) return;
    const existing = await this.read();
    if (this.processAlive(existing.ownerPid)) throw new Error(`another privileged ${existing.action} operation is still running`);
    await unlink(this.path);
    if (!await this.create(action)) throw new Error("privileged lifecycle lock was concurrently reacquired");
  }

  async release(): Promise<void> {
    if (!this.action) return;
    const existing = await this.read();
    if (existing.ownerPid !== process.pid || existing.action !== this.action) throw new Error("privileged lifecycle lock ownership changed");
    await unlink(this.path);
    this.action = undefined;
  }
}

export function interruptedActionBlocking(action: PrivilegedAction, pending: ReadonlySet<PrivilegedAction>): PrivilegedAction | undefined {
  if (action === "recover") return undefined;
  if (action === "uninstall" && pending.size === 1 && pending.has("uninstall")) return undefined;
  return [...pending][0];
}

export async function pendingPrivilegedActions(
  root = "/",
  rootIdentity = { uid: 0, gid: 0 },
): Promise<Set<PrivilegedAction>> {
  const physical = (logical: string) => resolve(root, `.${logical}`);
  const pending = new Set<PrivilegedAction>();
  const inspect = async (logical: string, action: PrivilegedAction): Promise<void> => {
    try {
      const info = await lstat(physical(logical));
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== rootIdentity.uid || info.gid !== rootIdentity.gid || (info.mode & 0o777) !== 0o600) {
        throw new Error(`privileged recovery journal metadata is unsafe: ${logical}`);
      }
      pending.add(action);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await inspect("/var/lib/pi-together/tailscale-prepare-journal.json", "prepare-tailscale");
  await inspect("/var/lib/pi-together/user-management-journal.json", "manage-users");
  await inspect("/var/lib/pi-together/policy-journal.json", "manage-workspaces");
  await inspect("/var/lib/pi-together/share-journal.json", "share");
  await inspect("/var/lib/pi-together/upgrade-journal.json", "upgrade");
  await inspect("/var/lib/pi-together/uninstall-journal.json", "uninstall");
  let names: string[] = [];
  try { names = await readdir(physical("/var/tmp")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (names.length > 100_000) throw new Error("temporary recovery journal inventory is unexpectedly large");
  for (const name of names.filter((value) => /^pi-together-apply-[a-f0-9]{64}\.json$/.test(value))) {
    await inspect(`/var/tmp/${name}`, "apply");
  }
  return pending;
}
