// Browser-test server only: deterministic fake adapter plus switchable synthetic principals.
import { join } from "node:path";
import { FakeAdapter } from "../pi-adapter/fake.js";
import { createApp } from "../server/app.js";

if (process.env.NODE_ENV !== "test") throw new Error("e2e server requires NODE_ENV=test");
const principals = new Map([
  ["alice", { provider: "github" as const, subject: "1001", login: "alice" }],
  ["bob", { provider: "github" as const, subject: "2002", login: "bob" }],
]);
const app = createApp({
  adapter: new FakeAdapter(),
  security: { mode: "test", principal: principals.get("alice")!, principalsByLogin: principals },
  origin: "http://test.local",
  sharedRepositoryFolders: ["/home/example/projects"],
  clientDir: join(process.cwd(), "dist", "client"),
});
const port = Number(process.env.PORT ?? 43217);
await new Promise<void>((resolve) => app.server.listen(port, "127.0.0.1", resolve));
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
