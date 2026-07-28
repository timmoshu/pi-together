import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listenOnConfiguredEndpoint } from "../server/listener.js";

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("configured listener boundary", () => {
  it("creates a restrictive Unix socket and removes it on close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-listener-"));
    const path = join(directory, "app.sock");
    const server = createServer((_req, res) => res.end("ok"));

    const endpoint = await listenOnConfiguredEndpoint(server, { kind: "unix", path });
    expect(endpoint).toEqual({ description: `unix:${path}` });
    expect(statSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o660);

    await close(server);
    expect(existsSync(path)).toBe(false);
  });

  it("removes a stale socket but refuses regular files at the socket path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-stale-"));
    const stale = join(directory, "stale.sock");
    execFileSync(process.execPath, ["-e", [
      "const net=require('node:net');",
      `net.createServer().listen(${JSON.stringify(stale)},()=>process.exit(0));`,
    ].join("")]);
    expect(statSync(stale).isSocket()).toBe(true);

    const server = createServer();
    await listenOnConfiguredEndpoint(server, { kind: "unix", path: stale });
    expect(statSync(stale).isSocket()).toBe(true);
    await close(server);

    const occupied = join(directory, "occupied.sock");
    writeFileSync(occupied, "do not replace");
    await expect(listenOnConfiguredEndpoint(createServer(), { kind: "unix", path: occupied }))
      .rejects.toThrow(/non-socket/);
    expect(statSync(occupied).isFile()).toBe(true);
  });

  it("allows only an explicit literal-loopback fallback and emits a warning", async () => {
    const server = createServer();
    const endpoint = await listenOnConfiguredEndpoint(server, {
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
      fallback: true,
    });
    expect(endpoint.warning).toMatch(/fallback/i);
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    await close(server);

    await expect(listenOnConfiguredEndpoint(createServer(), {
      kind: "tcp",
      host: "0.0.0.0",
      port: 43117,
    } as never)).rejects.toThrow(/literal loopback/);
  });
});
