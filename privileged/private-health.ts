import { request as httpRequest } from "node:http";
import type { AppConfig } from "../server/config.js";

export async function verifyPrivateHealth(
  config: AppConfig,
  physicalPath: (logical: string) => string,
  label: string,
): Promise<void> {
  const endpoint = config.listener.kind === "unix"
    ? { socketPath: physicalPath(config.listener.path) }
    : { host: "127.0.0.1", port: config.listener.port };
  const headers = config.mode === "local" ? {} : {
    host: new URL(config.publicOrigin).hostname,
    "x-pi-together-proxy-secret": config.proxySecret,
    "x-pi-together-login": config.principals[0]!.login,
  };
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ ...endpoint, path: "/api/health", headers }, (response) => {
          response.resume();
          response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error("private health returned a non-success status")));
        });
        request.setTimeout(2_000, () => request.destroy(new Error("private health timed out")));
        request.once("error", reject);
        request.end();
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : "unavailable"}`);
}
