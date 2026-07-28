import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBounded, fetchOauth2Proxy } from "../scripts/fetch-oauth2-proxy.js";

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
  it("retries bounded transient failures with deterministic backoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(new Response("archive", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    await expect(downloadBounded("https://fixture.invalid/archive", { fetchImpl, sleep })).resolves.toEqual(Buffer.from("archive"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("retries server failures but not permanent HTTP errors", async () => {
    const transientFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(new Response("archive", { status: 200 }));
    await expect(downloadBounded("https://fixture.invalid/archive", {
      fetchImpl: transientFetch,
      sleep: async () => undefined,
    })).resolves.toEqual(Buffer.from("archive"));
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const permanentFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 }));
    await expect(downloadBounded("https://fixture.invalid/archive", {
      fetchImpl: permanentFetch,
      sleep: async () => undefined,
    })).rejects.toThrow(/HTTP 404/);
    expect(permanentFetch).toHaveBeenCalledTimes(1);
  });

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
