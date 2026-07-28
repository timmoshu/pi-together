import { defineConfig } from "@playwright/test";

// E2E runs the server with the FAKE adapter (no pi needed) + the built client.
const PORT = 43217; // distinct from prod 43117 to avoid clashing with the live process

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    // FAKE_STEP_MS slows the deterministic stream so the transient running/Stop state is observable.
    command: `npm run build:client && NODE_ENV=test FAKE_STEP_MS=90 PORT=${PORT} tsx scripts/e2e-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {},
  },
});
