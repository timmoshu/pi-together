import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

async function privilegedHelper(operation: string): Promise<string> {
  const systemNode = await realpath("/usr/bin/node");
  const nodeInfo = await lstat(systemNode);
  const version = (await exec(systemNode, ["--version"], { timeout: 10_000 })).stdout.trim();
  if (nodeInfo.uid !== 0 || (nodeInfo.mode & 0o022) !== 0 || !/^v(?:1[89]|[2-9]\d)\./.test(version)) {
    throw new Error(`${operation} requires root-owned non-writable /usr/bin/node version 18 or newer`);
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(packageRoot, "dist", "privileged", "apply.js");
}

const privilegedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };

export async function runPrivilegedLifecycle(request: unknown, operation: string): Promise<void> {
  const helper = await privilegedHelper(operation);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["/usr/bin/node", helper], {
      stdio: ["pipe", "inherit", "inherit"],
      env: privilegedEnvironment,
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`privileged ${operation} exited ${code ?? signal ?? "unknown"}`)));
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runPrivilegedQuery(request: unknown, operation: string): Promise<string> {
  const helper = await privilegedHelper(operation);
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["/usr/bin/node", helper], {
      stdio: ["pipe", "pipe", "inherit"],
      env: privilegedEnvironment,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.stdout.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        child.kill();
        reject(new Error(`privileged ${operation} response exceeds size limit`));
      } else chunks.push(chunk);
    });
    child.once("exit", (code, signal) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`privileged ${operation} exited ${code ?? signal ?? "unknown"}`)));
    child.stdin.end(JSON.stringify(request));
  });
}
