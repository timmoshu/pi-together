import type { PrincipalIdentity } from "../../shared/protocol";

export function samePrincipal(
  left: Pick<PrincipalIdentity, "provider" | "subject"> | undefined,
  right: Pick<PrincipalIdentity, "provider" | "subject"> | undefined,
): boolean {
  return !!left && !!right && left.provider === right.provider && left.subject === right.subject;
}
