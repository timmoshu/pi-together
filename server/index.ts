// server/index.ts — process entrypoint. Loads config, builds the adapter + app, listens, and exits
// gracefully (0) on SIGTERM/SIGINT — production-smoke asserts {gracefulExit:0}.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAdapter } from "../pi-adapter/index.js";
import { validateSharedFolders } from "./workspace-policy.js";
import { listenOnConfiguredEndpoint } from "./listener.js";
import { OnboardingVerificationObserver } from "./onboarding-verification.js";

export async function main(): Promise<() => Promise<void>> {
  const cfg = loadConfig();
  const folders = await validateSharedFolders(cfg.sharedRepositoryFolders);
  const adapter = createAdapter(cfg.adapterKind, {
    collaboration: cfg.security.mode === "reverse-proxy",
    gitCommitterName: cfg.gitCommitter.name,
    gitCommitterEmail: cfg.gitCommitter.email,
    sharedRepositoryFolders: folders,
  });
  // The built client is always at <project>/dist/client. The service runs with
  // Resolve from cwd for both the compiled and source entry points. Packaged launchers may override it.
  const clientDir = process.env.PI_TOGETHER_CLIENT_DIR ?? join(process.cwd(), "dist", "client");
  const verification = new OnboardingVerificationObserver();
  const app = createApp({
    adapter,
    security: cfg.security,
    origin: cfg.origin,
    sharedRepositoryFolders: cfg.sharedRepositoryFolders,
    clientDir,
    onAuthenticatedBootstrap: (principal) => { void verification.observe(principal); },
  });

  let endpoint;
  try {
    endpoint = await listenOnConfiguredEndpoint(app.server, cfg.listener);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") throw new Error("configured listener is already in use");
    throw error;
  }
  // eslint-disable-next-line no-console
  console.log(`pi-together listening on ${endpoint.description}  (adapter=${cfg.adapterKind}, mode=${cfg.security.mode})`);
  if (endpoint.warning) {
    // eslint-disable-next-line no-console
    console.warn(`warning: ${endpoint.warning}`);
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    await app.close();
    await verification.cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return app.close;
}

// Run when invoked directly (node dist/server/index.js or tsx server/index.ts).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}
