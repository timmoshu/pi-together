import type { LeaseInfo } from "../../shared/protocol";
import type { Connection } from "./store-types";

export const LEASE_HEARTBEAT_MS = 60_000;

export function mergeClientLease(current: LeaseInfo | null, incoming: LeaseInfo | null): LeaseInfo | null {
  if (!incoming || !current?.isHolder) return incoming;
  return current.leaseId === incoming.leaseId ? { ...incoming, isHolder: true } : incoming;
}

export function shouldHeartbeat(input: {
  visibility: "visible" | "hidden";
  connection: Connection;
  isHolder: boolean;
}): boolean {
  return input.visibility === "visible" && input.connection === "connected" && input.isHolder;
}
