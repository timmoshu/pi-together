import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-together-isolated-release-"));
let child: ReturnType<typeof spawn> | undefined;
try {
  const release = join(root, "releases/0.1.0");
  await mkdir(join(release, "server"), { recursive: true });
  await mkdir(join(release, "client"));
  await mkdir(join(root, "workspace"));
  await copyFile("dist/server/index.js", join(release, "server/index.js"));
  await writeFile(join(release, "client/index.html"), "<!doctype html><title>isolated</title>");
  await symlink(release, join(root, "current"));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("unable to reserve isolated smoke port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const config = join(root, "config.json");
  await writeFile(config, `${JSON.stringify({
    version: 2,
    mode: "local",
    listener: { kind: "tcp", host: "127.0.0.1", port },
    sharedRepositoryFolders: [join(root, "workspace")],
  })}\n`, { mode: 0o600 });
  await chmod(config, 0o600);
  child = spawn(process.execPath, [join(root, "current/server/index.js")], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      PI_TOGETHER_ADAPTER: "fake",
      PI_TOGETHER_CONFIG_FILE: config,
      PI_TOGETHER_CLIENT_DIR: join(root, "current/client"),
    },
  });
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => { errorOutput += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch {
      // Retry while the isolated process initializes.
    }
    if (Date.now() >= deadline) throw new Error(`isolated release did not start without node_modules: ${errorOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write(JSON.stringify({ ok: true, noNodeModules: true, adapter: "fake" }) + "\n");
} finally {
  child?.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
