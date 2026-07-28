import { describe, expect, it, vi } from "vitest";
import { runRecover } from "../cli/recover.js";

const journal = (action: string, digest = "a".repeat(64)) => ({ action, journalSha256: digest });

describe("explicit privileged recovery", () => {
  it("reviews and confirms one exact recoverable journal before invoking sudo", async () => {
    const output: string[] = [];
    const invoke = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);
    await expect(runRecover([], {
      uid: 1000,
      inspect: async () => ({ pending: [journal("manage-workspaces")] }),
      confirm,
      invoke,
      write: (message) => output.push(message),
    })).resolves.toBe(true);
    expect(output.join("")).toContain("restore the previous shared-folder policy");
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      protocolVersion: 1,
      action: "recover",
      invokingUid: 1000,
      expectedAction: "manage-workspaces",
      expectedJournalSha256: "a".repeat(64),
    });
  });

  it("does not mutate when recovery is absent or declined", async () => {
    const invoke = vi.fn(async () => undefined);
    await expect(runRecover([], { uid: 1000, inspect: async () => ({ pending: [] }), invoke, write: () => undefined })).resolves.toBe(true);
    await expect(runRecover([], {
      uid: 1000,
      inspect: async () => ({ pending: [journal("apply")] }),
      confirm: async () => false,
      invoke,
      write: () => undefined,
    })).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses ambiguous journals and requires exact uninstall resumption", async () => {
    await expect(runRecover(["--yes"], {
      uid: 1000,
      inspect: async () => ({ pending: [journal("apply"), journal("share", "b".repeat(64))] }),
      write: () => undefined,
    })).rejects.toThrow(/multiple privileged recovery journals/);
    await expect(runRecover(["--yes"], {
      uid: 1000,
      inspect: async () => ({ pending: [journal("uninstall")] }),
      write: () => undefined,
    })).rejects.toThrow(/same `pi-together uninstall` flags/);
  });
});
