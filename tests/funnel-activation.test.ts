import { describe, expect, it, vi } from "vitest";
import { completeFunnelActivation } from "../cli/funnel-activation.js";
import { classifyFunnelActivation } from "../privileged/funnel-activation.js";

describe("guided Funnel activation", () => {
  it("returns only bounded activation state from Funnel inventory and exact unit logs", () => {
    const active = JSON.stringify({ Foreground: { synthetic: {
      TCP: { "443": { HTTPS: true } },
      Web: { "node.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:43118" } } } },
      AllowFunnel: { "node.tailnet.ts.net:443": true },
    } } });
    expect(classifyFunnelActivation(active, "", "node.tailnet.ts.net")).toEqual({ status: "active" });
    expect(classifyFunnelActivation(active.replace("true}", "false}"), "", "node.tailnet.ts.net")).toEqual({ status: "pending" });
    expect(classifyFunnelActivation("{}", "Funnel is not enabled\nhttps://login.tailscale.com/f/funnel?node=syntheticNode1\nsecret-canary", "node.tailnet.ts.net")).toEqual({
      status: "approval-required", approvalUrl: "https://login.tailscale.com/f/funnel?node=syntheticNode1",
    });
  });

  it("keeps Tailscale approval inside onboarding and verifies the route before success", async () => {
    const output: string[] = [];
    const confirm = vi.fn(async () => true);
    const inspect = vi.fn()
      .mockResolvedValueOnce({ status: "approval-required", approvalUrl: "https://login.tailscale.com/f/funnel?node=syntheticNode1" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "active" });
    await completeFunnelActivation("node.tailnet.ts.net", { confirm, write: (message) => output.push(message) }, inspect, async () => undefined);
    expect(confirm).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(22);
    expect(output.join("\n")).toContain("Tailscale approval required");
    expect(output.filter((message) => message.includes("privileged boundary: verifying exact public Funnel activation"))).toHaveLength(1);
    expect(output.join("\n")).toContain("confirming that it remains reachable");
    expect(output.join("\n")).toContain("Public Funnel active");
  });

  it("resets the readiness window if the public route becomes pending again", async () => {
    const states = [
      ...Array.from({ length: 5 }, () => ({ status: "active" as const })),
      { status: "pending" as const },
      ...Array.from({ length: 20 }, () => ({ status: "active" as const })),
    ];
    const inspect = vi.fn(async () => states.shift() ?? { status: "active" as const });
    await completeFunnelActivation("node.tailnet.ts.net", { confirm: async () => true, write: () => undefined }, inspect, async () => undefined);
    expect(inspect).toHaveBeenCalledTimes(26);
  });

  it("does not declare success when approval is declined or the route never activates", async () => {
    await expect(completeFunnelActivation("node.tailnet.ts.net", {
      confirm: async () => false, write: () => undefined,
    }, async () => ({ status: "approval-required", approvalUrl: "https://login.tailscale.com/f/funnel?node=syntheticNode1" }), async () => undefined)).rejects.toThrow(/approval was not completed/);

    await expect(completeFunnelActivation("node.tailnet.ts.net", {
      confirm: async () => true, write: () => undefined,
    }, async () => ({ status: "pending" }), async () => undefined)).rejects.toThrow(/did not keep/);
  });
});
