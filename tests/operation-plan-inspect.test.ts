import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodePlanIo } from "../cli/operation-plan.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("setup plan executable inventory", () => {
  it("streams supported large runtime executables without broadening managed-file inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pt-executable-inventory-"));
    roots.push(root);
    const executable = join(root, "node");
    await writeFile(executable, "synthetic");
    await truncate(executable, 17 * 1024 * 1024);

    await expect(nodePlanIo.inspect(executable)).rejects.toThrow(/too large/i);
    if (!nodePlanIo.inspectExecutable) throw new Error("executable inspector is unavailable");
    await expect(nodePlanIo.inspectExecutable(executable)).resolves.toMatchObject({
      kind: "file",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
