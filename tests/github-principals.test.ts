import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeGitHubLogin,
  mappingNeedsVerification,
  resolveGitHubLogin,
  verifyGitHubMapping,
  type GitHubPrincipalMapping,
} from "../server/github-principals.js";

const NOW = new Date("2025-02-03T04:05:06.000Z");

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

const mapping: GitHubPrincipalMapping = {
  provider: "github",
  subject: "1234567",
  login: "octocat",
  verifiedAt: "2025-01-01T00:00:00.000Z",
  verification: "verified",
  etag: '"example-etag"',
};

describe("GitHub principal mapping", () => {
  it("canonicalizes valid logins and rejects ambiguous forms", () => {
    expect(canonicalizeGitHubLogin("OctoCat")).toBe("octocat");
    for (const login of ["-octocat", "octocat-", "octo--cat", "white space", "x".repeat(40)]) {
      expect(() => canonicalizeGitHubLogin(login)).toThrow(/login/i);
    }
  });

  it("resolves a login without persisting API email or token fields", async () => {
    const fetch = vi.fn(async () => response(
      { id: 1234567, login: "OctoCat", email: "private@example.invalid", token: "not-for-storage" },
      { headers: { etag: '"new-etag"' } },
    ));

    const result = await resolveGitHubLogin("OctoCat", { fetch, now: () => NOW });
    expect(result).toEqual({
      kind: "verified",
      mapping: {
        provider: "github",
        subject: "1234567",
        login: "octocat",
        verifiedAt: NOW.toISOString(),
        verification: "verified",
        etag: '"new-etag"',
      },
    });
    expect(JSON.stringify(result)).not.toContain("not-for-storage");
    expect(JSON.stringify(result)).not.toContain("private@example.invalid");
  });

  it("uses ETag revalidation and refreshes a not-modified mapping", async () => {
    const fetch = vi.fn(async () => response(null, { status: 304 }));
    const result = await verifyGitHubMapping(mapping, { fetch, now: () => NOW });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/users/octocat",
      expect.objectContaining({ headers: expect.objectContaining({ "if-none-match": '"example-etag"' }) }),
    );
    expect(result.kind).toBe("not-modified");
    expect(result.mapping.verifiedAt).toBe(NOW.toISOString());
  });

  it("fails closed when a login resolves to a different numeric subject", async () => {
    const fetch = vi.fn(async () => response({ id: 9999999, login: "octocat" }));
    const result = await verifyGitHubMapping(mapping, { fetch, now: () => NOW });

    expect(result.kind).toBe("disabled");
    expect(result.mapping.verification).toBe("disabled");
    expect(result.mapping.subject).toBe(mapping.subject);
  });

  it("preserves the local mapping on API rate limits without claiming verification", async () => {
    const fetch = vi.fn(async () => response(
      { message: "rate limit" },
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1738560000" } },
    ));
    const result = await verifyGitHubMapping(mapping, { fetch, now: () => NOW });

    expect(result.kind).toBe("rate-limited");
    expect(result.mapping).toEqual(mapping);
    expect(result.retryAt).toBe("2025-02-03T05:20:00.000Z");
  });

  it("marks stale mappings as due for verification", () => {
    expect(mappingNeedsVerification(mapping, NOW, 24 * 60 * 60 * 1000)).toBe(true);
    expect(mappingNeedsVerification({ ...mapping, verifiedAt: NOW.toISOString() }, NOW, 24 * 60 * 60 * 1000)).toBe(false);
    expect(mappingNeedsVerification({ ...mapping, verification: "pending" }, NOW)).toBe(true);
  });
});
