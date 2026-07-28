import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { loadInstalledManifest, runUninstall, type UninstallPrompt } from "../cli/uninstall.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
class Prompt implements UninstallPrompt {
  output = "";
  constructor(private readonly answer: boolean) {}
  async confirm(): Promise<boolean> { return this.answer; }
  write(message: string): void { this.output += message; }
}
async function manifestFile() {
  const root = await mkdtemp(join(tmpdir(), "pi-together-uninstall-cli-"));
  roots.push(root);
  await mkdir(join(root, "state"));
  const path = join(root, "state/manifest.json");
  await writeFile(path, renderInstallManifest(buildInstallManifest("local", "0.1.0")), { mode: 0o644 });
  return path;
}

describe("uninstall CLI", () => {
  it("requires confirmation and passes only the reviewed digest plus explicit purge choice", async () => {
    const path = await manifestFile();
    const prompt = new Prompt(true);
    let request: unknown;
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    expect(await runUninstall(["--purge-config"], prompt, async (value) => { request = value; }, path, identity)).toBe(true);
    expect(request).toMatchObject({ action: "uninstall", purgeConfig: true, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(prompt.output).toContain("Pi sessions, Pi credentials, workspaces, and backups: preserved");
    expect(prompt.output).toContain("REMOVE (explicit purge)");
  });

  it("loads the protected production inventory through the privileged inspection lane", async () => {
    const path = await manifestFile();
    const prompt = new Prompt(true);
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    let inspected = false;
    let request: unknown;
    await runUninstall(
      ["--yes"], prompt, async (value) => { request = value; }, undefined, identity,
      async () => { inspected = true; return loadInstalledManifest(path, identity); },
    );
    expect(inspected).toBe(true);
    expect(request).toMatchObject({ action: "uninstall", manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("reports when exact inventory came from an interrupted-uninstall journal", async () => {
    const path = await manifestFile();
    const prompt = new Prompt(true);
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const loaded = await loadInstalledManifest(path, identity);
    await runUninstall(
      ["--yes"], prompt, async () => undefined, undefined, identity,
      async () => ({ ...loaded, recovery: "journal" }),
    );
    expect(prompt.output).toContain("recovered from the root-owned interrupted-uninstall journal");
  });

  it("is idempotent only after privileged inspection reports all managed markers absent", async () => {
    const prompt = new Prompt(true);
    let invoked = false;
    await expect(runUninstall(["--yes"], prompt, async () => { invoked = true; }, undefined, { uid: 0, gid: 0 }, async () => ({ absent: true }))).resolves.toBe(true);
    expect(prompt.output).toContain("already uninstalled");
    expect(invoked).toBe(false);
  });

  it("makes cancellation mutation-free and rejects unknown options", async () => {
    const path = await manifestFile();
    const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    let invoked = false;
    expect(await runUninstall([], new Prompt(false), async () => { invoked = true; }, path, identity)).toBe(false);
    expect(invoked).toBe(false);
    await expect(runUninstall(["--all"], new Prompt(true), undefined, path, identity)).rejects.toThrow(/unknown uninstall option/);
  });
});
