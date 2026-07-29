import type { SetupPlan } from "../cli/operation-plan.js";

/** Validate the bounded set of ensure-directory targets recorded by an apply journal. */
export function validatedCreatedDirectories(value: unknown, plan: SetupPlan): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || new Set(value).size !== value.length
    || value.some((path) => typeof path !== "string")) {
    throw new Error("apply recovery journal contains invalid created directories");
  }
  const targets = new Set(plan.operations
    .filter((operation) => operation.kind === "ensure-directory")
    .map((operation) => operation.target));
  if (value.some((path) => !targets.has(path))) {
    throw new Error("apply recovery journal contains an invalid created directory");
  }
  return value;
}
