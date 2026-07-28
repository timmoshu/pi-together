import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { InstallManifestSchema, renderInstallManifest } from "../cli/install-manifest.js";
import { AppConfigSchema, parseConfig } from "../server/config.js";
import { canonicalSharedFolders } from "../server/workspace-policy.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
export const WorkspaceManagementRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.literal("manage-workspaces"),
  invokingUid: z.number().int().positive().max(2 ** 31 - 1),
  sharedRepositoryFolders: z.array(z.string()).min(1).max(16),
  expected: z.object({ appConfigSha256: SHA256, manifestSha256: SHA256 }).strict(),
}).strict().transform((request, context) => {
  try { return { ...request, sharedRepositoryFolders: canonicalSharedFolders(request.sharedRepositoryFolders) }; }
  catch (error) { context.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
});
export type WorkspaceManagementRequest = z.infer<typeof WorkspaceManagementRequestSchema>;

export interface CurrentWorkspaceManagementState {
  appConfig: string;
  manifest: string;
  appConfigOwnerUid: number;
}
export interface WorkspaceManagementChange {
  appConfig: string;
  previous: CurrentWorkspaceManagementState;
  invokingUid: number;
}
export interface WorkspaceManagementIo {
  loadCurrent(request: WorkspaceManagementRequest): Promise<CurrentWorkspaceManagementState>;
  validateFolders(folders: string[], invokingUid: number): Promise<void>;
  commit(change: WorkspaceManagementChange): Promise<void>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function digestEqual(actual: string, expected: string): boolean {
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export async function applyWorkspaceManagement(value: unknown, io: WorkspaceManagementIo): Promise<void> {
  const request = WorkspaceManagementRequestSchema.parse(value);
  const current = await io.loadCurrent(request);
  if (current.appConfigOwnerUid !== request.invokingUid) throw new Error("app config owner does not match invoking user");
  if (!digestEqual(sha256(current.appConfig), request.expected.appConfigSha256)) throw new Error("app config changed after review");
  if (!digestEqual(sha256(current.manifest), request.expected.manifestSha256)) throw new Error("installation manifest changed after review");
  const manifest = InstallManifestSchema.parse(JSON.parse(current.manifest));
  if (renderInstallManifest(manifest) !== current.manifest || !manifest.entries.some((entry) => entry.kind === "file" && entry.path === "/etc/pi-together/config.json")) {
    throw new Error("installation manifest does not canonically own app config");
  }
  const config = parseConfig(JSON.parse(current.appConfig));
  await io.validateFolders(request.sharedRepositoryFolders, request.invokingUid);
  const appConfig = `${JSON.stringify({ ...config, version: 2, sharedRepositoryFolders: request.sharedRepositoryFolders }, null, 2)}\n`;
  AppConfigSchema.parse(JSON.parse(appConfig));
  await io.commit({ appConfig, previous: current, invokingUid: request.invokingUid });
}
