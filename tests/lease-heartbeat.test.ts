import { describe, expect, it } from "vitest";
import { LEASE_HEARTBEAT_MS, mergeClientLease, shouldHeartbeat } from "../client/src/lease-heartbeat.js";

describe("lease heartbeat policy", () => {
  it("uses the bounded sixty-second cadence", () => {
    expect(LEASE_HEARTBEAT_MS).toBe(60_000);
  });

  it("preserves personalized holder state only for the same public lease", () => {
    const current = {
      leaseId: "lease_a",
      actor: { provider: "github" as const, subject: "1001", login: "alice" },
      acquiredAt: 10,
      expiresAt: 20,
      isHolder: true,
    };
    const { isHolder: _isHolder, ...publicLease } = current;
    expect(mergeClientLease(current, { ...publicLease, expiresAt: 30 })).toMatchObject({
      expiresAt: 30,
      isHolder: true,
    });
    expect(mergeClientLease(current, { ...publicLease, leaseId: "lease_b", acquiredAt: 10 })).not.toHaveProperty("isHolder");
    expect(mergeClientLease(current, null)).toBeNull();
  });

  it.each([
    ["visible holder on a connected stream", "visible", "connected", true, true],
    ["hidden holder", "hidden", "connected", true, false],
    ["disconnected holder", "visible", "reconnecting", true, false],
    ["connecting holder", "visible", "connecting", true, false],
    ["visible non-holder", "visible", "connected", false, false],
  ] as const)("%s => %s", (_name, visibility, connection, isHolder, expected) => {
    expect(shouldHeartbeat({ visibility, connection, isHolder })).toBe(expected);
  });
});
