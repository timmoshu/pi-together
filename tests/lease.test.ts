import { describe, expect, it } from "vitest";
import { LeaseManager, type LeaseHolder } from "../server/lease.js";

const alice = { provider: "github" as const, subject: "1001", login: "alice" };
const aliceRenamed = { ...alice, login: "alice-renamed" };
const bob = { provider: "github" as const, subject: "2002", login: "bob" };
const holder = (principal = alice, viewerId = "viewer_a"): LeaseHolder => ({ principal, viewerId });

describe("principal-aware lease state machine", () => {
  it("acquires and renews only the exact principal+viewer tuple", () => {
    let now = 1_000;
    const leases = new LeaseManager(100, () => now);
    expect(leases.acquire("chat", holder())).toMatchObject({ actor: alice, acquiredAt: 1_000, expiresAt: 1_100, isHolder: true });
    expect(leases.acquire("chat", holder(alice, "viewer_b"))).toBeNull();
    expect(leases.acquire("chat", holder(bob, "viewer_a"))).toBeNull();

    now = 1_050;
    expect(leases.authorizeMutation("chat", holder(aliceRenamed))).toMatchObject({
      actor: aliceRenamed,
      acquiredAt: 1_000,
      expiresAt: 1_150,
      isHolder: true,
    });
    expect(leases.get("chat")).toMatchObject({ actor: aliceRenamed, acquiredAt: 1_000, expiresAt: 1_150 });
    expect(JSON.stringify(leases.get("chat"))).not.toContain("viewer_a");
  });

  it("does not acquire an unheld lease through heartbeat or a mutation", () => {
    const leases = new LeaseManager();
    expect(leases.authorizeMutation("chat", holder())).toBeNull();
    expect(leases.heartbeat("chat", holder())).toBeNull();
    expect(leases.get("chat")).toBeNull();
  });

  it("handles takeover, exact release, and same-principal different-viewer conflicts", () => {
    let now = 10;
    const leases = new LeaseManager(100, () => now);
    const original = leases.acquire("chat", holder())!;
    now = 20;
    const transferred = leases.takeOver("chat", holder(alice, "viewer_b"));
    expect(transferred).toMatchObject({
      actor: alice,
      acquiredAt: 20,
      isHolder: true,
    });
    expect(transferred.leaseId).not.toBe(original.leaseId);
    expect(leases.release("chat", holder())).toBe(false);
    expect(leases.release("chat", holder(alice, "viewer_b"))).toBe(true);
    expect(leases.get("chat")).toBeNull();
  });

  it("does not authorize mutations while durable acquisition work is provisional", async () => {
    const leases = new LeaseManager();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const acquiring = leases.runAcquisition("chat", holder(), false, async () => operation);
    await Promise.resolve();
    expect(leases.authorizeMutation("chat", holder())).toBeNull();
    expect(await leases.runAcquisition("chat", holder(), true, async () => undefined)).toBeNull();
    expect(leases.get("chat", holder())).not.toHaveProperty("isHolder");
    finish();
    await acquiring;
    expect(leases.authorizeMutation("chat", holder())?.isHolder).toBe(true);
  });

  it("rolls back a failed asynchronous acquire or takeover", async () => {
    const leases = new LeaseManager();
    await expect(leases.runAcquisition("new", holder(), false, async () => {
      throw new Error("attach failed");
    })).rejects.toThrow("attach failed");
    expect(leases.get("new")).toBeNull();

    leases.acquire("chat", holder());
    await expect(leases.runAcquisition("chat", holder(bob, "viewer_b"), true, async () => {
      throw new Error("takeover attach failed");
    })).rejects.toThrow("takeover attach failed");
    expect(leases.get("chat")).toMatchObject({ actor: alice });
  });

  it("expires at the exact clock boundary and reports each expiry once", () => {
    let now = 0;
    const leases = new LeaseManager(100, () => now);
    leases.acquire("a", holder());
    now = 99;
    expect(leases.get("a")).not.toBeNull();
    now = 100;
    expect(leases.get("a")).toBeNull();
    expect(leases.reapExpired()).toEqual([{ chatId: "a", previous: holder() }]);
    expect(leases.reapExpired()).toEqual([]);
  });

  it("maintains at most one holder under a deterministic mixed-operation sequence", () => {
    let now = 0;
    const leases = new LeaseManager(17, () => now);
    const candidates = [holder(), holder(alice, "viewer_b"), holder(bob, "viewer_c")];
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let index = 0; index < 500; index++) {
      now += random() % 3;
      const candidate = candidates[random() % candidates.length]!;
      switch (random() % 5) {
        case 0: leases.acquire("chat", candidate); break;
        case 1: leases.authorizeMutation("chat", candidate); break;
        case 2: leases.heartbeat("chat", candidate); break;
        case 3: leases.takeOver("chat", candidate); break;
        case 4: leases.release("chat", candidate); break;
      }
      const visible = leases.get("chat");
      if (visible) {
        expect([alice.subject, bob.subject]).toContain(visible.actor.subject);
        expect(Object.keys(visible)).not.toContain("viewerId");
      }
    }
  });
});
