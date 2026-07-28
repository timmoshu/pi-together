import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildInstallManifest, renderInstallManifest } from "../cli/install-manifest.js";
import { applyWorkspaceManagement, type CurrentWorkspaceManagementState, type WorkspaceManagementIo } from "../privileged/workspaces-core.js";

const config = `${JSON.stringify({ version: 2, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, sharedRepositoryFolders: ["/srv/old"] }, null, 2)}\n`;
const manifest = renderInstallManifest(buildInstallManifest("local", "0.1.0"));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const request = {
  protocolVersion: 1 as const, action: "manage-workspaces" as const, invokingUid: 1000,
  sharedRepositoryFolders: ["/srv/new"], expected: { appConfigSha256: digest(config), manifestSha256: digest(manifest) },
};
function io(state: CurrentWorkspaceManagementState = { appConfig: config, manifest, appConfigOwnerUid: 1000 }): WorkspaceManagementIo & { commit: ReturnType<typeof vi.fn> } {
  return {
    loadCurrent: async () => state,
    validateFolders: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
  };
}

describe("privileged workspace management", () => {
  it("digest-binds and replaces only the complete shared-folder policy", async () => {
    const target = io();
    await applyWorkspaceManagement(request, target);
    expect(target.validateFolders).toHaveBeenCalledWith(["/srv/new"], 1000);
    const change = target.commit.mock.calls[0]?.[0];
    expect(JSON.parse(change.appConfig)).toEqual({ version: 2, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, sharedRepositoryFolders: ["/srv/new"] });
  });

  it("rejects stale digests, wrong owners, redundant folders, and malformed manifests before commit", async () => {
    for (const [value, target] of [
      [{ ...request, expected: { ...request.expected, appConfigSha256: "0".repeat(64) } }, io()],
      [request, io({ appConfig: config, manifest, appConfigOwnerUid: 1001 })],
      [{ ...request, sharedRepositoryFolders: ["/srv", "/srv/new"] }, io()],
      [request, io({ appConfig: config, manifest: `${manifest} `, appConfigOwnerUid: 1000 })],
    ] as const) {
      await expect(applyWorkspaceManagement(value, target)).rejects.toThrow();
      expect(target.commit).not.toHaveBeenCalled();
    }
  });
});
