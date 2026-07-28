import { randomBytes } from "node:crypto";
import type { SetupPlan } from "./operation-plan.js";
import type { SetupAnswers } from "./setup-answers.js";
import { runPrivilegedLifecycle } from "./privileged-runner.js";

export type ApplyRunner = (plan: SetupPlan, answers: SetupAnswers) => Promise<void>;

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export const runPrivilegedApply: ApplyRunner = async (plan, answers) => {
  const request = answers.mode === "local"
    ? { protocolVersion: 1, plan }
    : {
        protocolVersion: 1,
        plan,
        secrets: {
          "proxy-secret": generatedSecret(),
          "oauth-client-secret": answers.oauthClientSecret,
          "oauth-cookie-secret": generatedSecret(),
        },
      };
  await runPrivilegedLifecycle(request, "apply");
};
