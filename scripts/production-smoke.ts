// Spawn the real server with the fake adapter and reverse-proxy configuration, then assert canonical
// principal authorization, rejection without proxy evidence, and graceful shutdown.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT ?? 43917);
const SECRET = "s".repeat(43);
const LOGIN = "octocat";
const directory = mkdtempSync(join(tmpdir(), "pi-together-smoke-"));
const configPath = join(directory, "config.json");
const workspace = join(directory, "workspace");
mkdirSync(workspace);
writeFileSync(configPath, JSON.stringify({
  version: 2,
  mode: "reverse-proxy",
  listener: { kind: "tcp", host: "127.0.0.1", port: PORT, fallback: true },
  publicOrigin: "https://agents.example.com",
  proxySecret: SECRET,
  principals: [{
    provider: "github",
    subject: "1234567",
    login: LOGIN,
    verifiedAt: "2025-01-02T03:04:05.000Z",
    verification: "verified",
  }],
  sharedRepositoryFolders: [workspace],
}), { mode: 0o600 });

const child = spawn("tsx", [join(HERE, "..", "server", "index.ts")], {
  env: {
    ...process.env,
    PI_TOGETHER_ADAPTER: "fake",
    PI_TOGETHER_CONFIG_FILE: configPath,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const base = `http://127.0.0.1:${PORT}`;
const proxyHeaders = {
  "x-pi-together-proxy-secret": SECRET,
  "x-pi-together-login": LOGIN,
};
const status = async (headers: Record<string, string>): Promise<number> => {
  try {
    return (await fetch(`${base}/api/health`, { headers })).status;
  } catch {
    return 0;
  }
};

async function waitReady(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if ((await status(proxyHeaders)) === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const exitCode = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
const ready = await waitReady();
const authenticatedHealth = ready ? await status(proxyHeaders) : 0;
const missingProxyEvidence = ready ? await status({ "x-forwarded-for": "127.0.0.1" }) : 0;

child.kill("SIGTERM");
const code = await Promise.race([
  exitCode,
  new Promise<number>((resolve) => setTimeout(() => resolve(-2), 5000)),
]);
rmSync(directory, { recursive: true, force: true });
const gracefulExit = code === 0 ? 0 : code;

const ok = authenticatedHealth === 200 && missingProxyEvidence === 401 && gracefulExit === 0;
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ok, authenticatedHealth, missingProxyEvidence, gracefulExit }));
process.exit(ok ? 0 : 1);
