import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOauth2Proxy } from "../scripts/fetch-oauth2-proxy.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-together-oauth-download-"));
  roots.push(root);
  return join(root, "oauth2-proxy");
}

describe("pinned oauth2-proxy downloader", () => {
  it("rejects wrong bytes before extraction or destination creation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not the pinned archive", { status: 200 })));
    const output = await outputPath();
    await expect(fetchOauth2Proxy("linux-x64", output)).rejects.toThrow(/checksum mismatch/);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a declared oversized response before reading its body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("small", {
      status: 200,
      headers: { "content-length": String(101 * 1024 * 1024) },
    })));
    const output = await outputPath();
    await expect(fetchOauth2Proxy("linux-arm64", output)).rejects.toThrow(/size limit/);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
