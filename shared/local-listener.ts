import { createServer } from "node:net";

// 43118 is reserved for the dedicated authenticated Funnel edge.
export const LOCAL_LISTENER_PORTS = Object.freeze([
  43117,
  43119,
  43120,
  43121,
  43122,
  43123,
  43124,
  43125,
  43126,
  43127,
] as const);

export function isLocalListenerPort(value: number): boolean {
  return (LOCAL_LISTENER_PORTS as readonly number[]).includes(value);
}

async function canListenOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

export async function availableLoopbackPort(ports: readonly number[]): Promise<number | undefined> {
  for (const port of ports) if (await canListenOnLoopback(port)) return port;
  return undefined;
}
