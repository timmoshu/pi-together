import type { SetupOperation } from "../cli/operation-plan.js";

const LETS_ENCRYPT_PRODUCTION_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

export function certbotArguments(operation: Extract<SetupOperation, { kind: "certificate" }>, webroot: string): string[] {
  return [
    "certonly", "--non-interactive", "--agree-tos", "--no-eff-email", "--keep-until-expiring",
    "--preferred-challenges", "http", "--server", LETS_ENCRYPT_PRODUCTION_DIRECTORY,
    "--cert-name", operation.domain, "--email", operation.email, "--webroot", "-w", webroot, "-d", operation.domain,
  ];
}
