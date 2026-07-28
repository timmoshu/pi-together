import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedRegular } from "../privileged/bounded-file.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded privileged file reads", () => {
  it("returns stable regular-file bytes and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-bounded-"));
    roots.push(root);
    const path = join(root, "input");
    await writeFile(path, "synthetic");
    await expect(readBoundedRegular(path, 32, "unsafe input")).resolves.toMatchObject({
      bytes: Buffer.from("synthetic"),
      info: { size: 9 },
    });
  });

  it("rejects content beyond the bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-together-bounded-"));
    roots.push(root);
    const path = join(root, "input");
    await writeFile(path, "synthetic");
    await truncate(path, 33);
    await expect(readBoundedRegular(path, 32, "unsafe input")).rejects.toThrow(/unsafe input/);
  });
});
