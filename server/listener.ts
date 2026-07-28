import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import type { ListenerConfig } from "./config.js";

export interface ListeningEndpoint {
  description: string;
  warning?: string;
}

function removeStaleSocket(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket listener path: ${path}`);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function listen(server: Server, target: { port: number; host: string } | { path: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if ("path" in target) server.listen(target.path);
    else server.listen(target.port, target.host);
  });
}

export async function listenOnConfiguredEndpoint(
  server: Server,
  listener: ListenerConfig,
): Promise<ListeningEndpoint> {
  if (listener.kind === "tcp") {
    if (listener.host !== "127.0.0.1") throw new Error("TCP listener must use literal loopback");
    await listen(server, { port: listener.port, host: listener.host });
    return {
      description: `http://${listener.host}:${listener.port}`,
      ...(listener.fallback
        ? { warning: "reverse-proxy TCP fallback is active on literal loopback; Unix socket is preferred" }
        : {}),
    };
  }

  removeStaleSocket(listener.path);
  await listen(server, { path: listener.path });
  chmodSync(listener.path, 0o660);
  server.once("close", () => {
    try {
      const stat = lstatSync(listener.path);
      if (stat.isSocket()) unlinkSync(listener.path);
    } catch {
      // The path is already absent or was replaced after shutdown; never remove a non-socket.
    }
  });
  return { description: `unix:${listener.path}` };
}
