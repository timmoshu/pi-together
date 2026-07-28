#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { managedGitInvocation, type ManagedGitIdentity } from "./git-identity-core.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`managed Git launcher is missing ${name}`);
  }
  return value;
};

function main(): void {
  const git = required("PI_TOGETHER_REAL_GIT");
  if (!isAbsolute(git)) throw new Error("managed real Git path must be absolute");
  const identity: ManagedGitIdentity = {
    author: {
      name: required("PI_TOGETHER_MANAGED_GIT_AUTHOR_NAME"),
      email: required("PI_TOGETHER_MANAGED_GIT_AUTHOR_EMAIL"),
    },
    committer: {
      name: required("PI_TOGETHER_MANAGED_GIT_COMMITTER_NAME"),
      email: required("PI_TOGETHER_MANAGED_GIT_COMMITTER_EMAIL"),
    },
  };
  const invocation = managedGitInvocation(
    process.argv.slice(2),
    process.env,
    identity,
    required("PI_TOGETHER_MANAGED_GIT_AGENT"),
  );
  // Keep the bounded managed metadata for Git hooks that invoke `git` through PATH again. These
  // values contain no credential or viewer identifier; removing them would break normal hook chains.
  const child = spawn(git, invocation.args, { env: invocation.env, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => {
    process.stderr.write(`pi-together git launch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

try { main(); }
catch (error) {
  process.stderr.write(`pi-together git identity error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
