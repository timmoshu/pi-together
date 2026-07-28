import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { normalize } from "node:path";
import { z } from "zod";
import { canonicalSharedFolders } from "../server/workspace-policy.js";

const AbsolutePath = z.string().min(1).max(4096)
  .refine((value) => value.startsWith("/") && value !== "/", "must be an absolute non-root path")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value) && normalize(value) === value, "must be lexically canonical");
const SharedFolders = z.array(AbsolutePath).min(1).max(16).transform((folders, context) => {
  try { return canonicalSharedFolders(folders); }
  catch (error) { context.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
});
const noControls = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const GitHubLogin = z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/)
  .transform((value) => value.toLowerCase());

const PublicAnswers = {
  schemaVersion: z.literal(2),
  acceptedHostPermissionRisk: z.literal(true),
  githubLogins: z.array(GitHubLogin).min(1).max(32).transform((values) => [...new Set(values)]),
  oauthClientId: z.string().min(1).max(256).refine(noControls, "must not contain control characters"),
  oauthClientSecret: z.string().min(16).max(4096).refine(noControls, "must not contain control characters"),
  sharedRepositoryFolders: SharedFolders,
  startNow: z.boolean().default(true),
  enableBootService: z.boolean().default(false),
};

export const SetupAnswersSchema = z.discriminatedUnion("mode", [
  z.object({
    schemaVersion: z.literal(2),
    acceptedHostPermissionRisk: z.literal(true),
    mode: z.literal("local"),
    sharedRepositoryFolders: SharedFolders,
    startNow: z.boolean().default(true),
    enableBootService: z.boolean().default(false),
  }).strict(),
  z.object({
    ...PublicAnswers,
    mode: z.literal("reverse-proxy"),
    domain: z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    certificateEmail: z.string().email().max(320),
    reuseExistingCertificate: z.boolean().optional(),
  }).strict(),
  z.object({
    ...PublicAnswers,
    mode: z.literal("tailscale-funnel"),
    tailscaleDnsName: z.string().min(1).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+\.ts\.net$/),
  }).strict(),
]);
export type SetupAnswers = z.infer<typeof SetupAnswersSchema>;

export function migrateLegacySetupAnswers(input: unknown): unknown {
  if (!input || typeof input !== "object" || (input as { schemaVersion?: unknown }).schemaVersion !== 1) return input;
  const value = input as Record<string, unknown>;
  if ("sharedRepositoryFolders" in value || !Array.isArray(value.workspaceRoots)) {
    throw new Error("legacy setup answers must contain only workspaceRoots");
  }
  const { schemaVersion: _version, workspaceRoots, ...rest } = value;
  return { ...rest, schemaVersion: 2, sharedRepositoryFolders: canonicalSharedFolders(workspaceRoots as string[]) };
}

export async function loadSecureAnswers(path: string, expectedUid = process.getuid?.()): Promise<SetupAnswers> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("answer file must be a readable regular non-symlink file");
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("answer file must be a regular non-symlink file");
    if ((info.mode & 0o777) !== 0o600) throw new Error("answer file must have mode 0600");
    if (expectedUid !== undefined && info.uid !== expectedUid) throw new Error("answer file must be owned by the invoking user");
    if (info.size > 1_000_000) throw new Error("answer file is too large");
    return SetupAnswersSchema.parse(migrateLegacySetupAnswers(JSON.parse(await file.readFile("utf8"))));
  } finally {
    await file.close();
  }
}

export function redactAnswers(answers: SetupAnswers): Record<string, unknown> {
  if (answers.mode === "local") return { ...answers };
  return { ...answers, oauthClientSecret: "[REDACTED]" };
}

export function oauthApplicationUrls(domain: string): { homepage: string; callback: string } {
  return {
    homepage: `https://${domain}`,
    callback: `https://${domain}/oauth2/callback`,
  };
}
