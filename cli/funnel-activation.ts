import { runPrivilegedQuery } from "./privileged-runner.js";
import { FunnelActivationInspectionSchema, type FunnelActivationInspection } from "../shared/funnel-activation-protocol.js";

export interface FunnelActivationPrompt {
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  write(message: string): void;
}

async function inspect(dnsName: string, invokingUid = process.getuid?.()): Promise<FunnelActivationInspection> {
  if (!invokingUid || invokingUid === 0) throw new Error("Funnel activation must run as the non-root Pi service user");
  const response = await runPrivilegedQuery({
    protocolVersion: 1, action: "inspect-funnel-activation", invokingUid, dnsName,
  }, "Funnel activation inspection");
  return FunnelActivationInspectionSchema.parse(JSON.parse(response));
}

export async function completeFunnelActivation(
  dnsName: string,
  prompt: FunnelActivationPrompt,
  inspectActivation: () => Promise<FunnelActivationInspection> = () => inspect(dnsName),
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  let approved = false;
  let approvalUrl: string | undefined;
  let consecutiveActiveChecks = 0;
  for (let attempt = 0; attempt < 121; attempt++) {
    const state = FunnelActivationInspectionSchema.parse(await inspectActivation());
    if (state.status === "active") {
      consecutiveActiveChecks++;
      if (consecutiveActiveChecks === 1) prompt.write("Public route reached; confirming that it remains reachable before declaring installation complete…\n");
      if (consecutiveActiveChecks >= 20) {
        prompt.write(`\nPublic Funnel active\n--------------------\nVerified https://${dnsName} remained reachable through the owned loopback edge.\n`);
        return;
      }
    } else {
      consecutiveActiveChecks = 0;
    }
    if (state.status === "approval-required" && state.approvalUrl !== approvalUrl) {
      approvalUrl = state.approvalUrl;
      prompt.write(`\nTailscale approval required\n---------------------------\nOpen this URL while signed into the tailnet administrator account:\n${approvalUrl}\n\nPi Together does not receive your Tailscale credentials. Return here after approving Funnel for this node.\n`);
    }
    if (approvalUrl && !approved) {
      approved = await prompt.confirm("I approved Tailscale Funnel for this node", false);
      if (!approved) throw new Error("Tailscale Funnel approval was not completed; installation is present but public sharing is not active");
      prompt.write("Approval recorded; waiting for the canonical public HTTPS OAuth redirect…\n");
    }
    if (attempt < 120) await wait(1_000);
  }
  throw new Error("Tailscale Funnel did not keep the canonical public HTTPS OAuth redirect reachable within 120 seconds");
}
