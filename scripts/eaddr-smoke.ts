// scripts/eaddr-smoke.ts — verify the server surfaces EADDRINUSE cleanly (no hang, no silent bind to
// a wrong interface) when its port is already taken. Prints {"ok":true,"eaddrinuse":true}.
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { FakeAdapter } from "../pi-adapter/fake.js";

const PORT = Number(process.env.SMOKE_PORT ?? 43918);

// occupy the port first
const squatter = createServer((_req, res) => res.end("busy"));
await new Promise<void>((resolve) => squatter.listen(PORT, "127.0.0.1", resolve));

const app = createApp({
  adapter: new FakeAdapter(),
  security: { mode: "local" },
  origin: "http://127.0.0.1",
  sharedRepositoryFolders: ["/home/example/projects"],
});

const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
  app.server.once("error", (e: NodeJS.ErrnoException) => resolve(e));
  app.server.listen(PORT, "127.0.0.1", () => resolve(null));
});

const eaddrinuse = err?.code === "EADDRINUSE";
await app.close().catch(() => {});
await new Promise<void>((resolve) => squatter.close(() => resolve()));

const ok = eaddrinuse;
// eslint-disable-next-line no-console
console.log(JSON.stringify({ ok, eaddrinuse }));
process.exit(ok ? 0 : 1);
