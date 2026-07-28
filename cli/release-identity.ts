import { z } from "zod";

export const StableVersionSchema = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/).refine(
  (value) => value.split(".").every((part) => Number.isSafeInteger(Number(part))),
  "version components must be safe integers",
);
export const UpgradeReleaseIdSchema = StableVersionSchema;

export function compareUpgradeReleases(left: string, right: string): number {
  const a = StableVersionSchema.parse(left).split(".").map(Number);
  const b = StableVersionSchema.parse(right).split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}
