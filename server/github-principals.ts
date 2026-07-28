import { z } from "zod";
const LOGIN = /^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/;
const SUBJECT = /^[1-9]\d*$/;

export interface GitHubPrincipalMapping {
  provider: "github";
  subject: string;
  login: string;
  verifiedAt?: string;
  verification: "verified" | "pending" | "disabled";
  etag?: string;
}

export interface GitHubRequestOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export interface GitHubVerificationResult {
  kind: "verified" | "not-modified" | "disabled" | "rate-limited";
  mapping: GitHubPrincipalMapping;
  reason?: string;
  retryAt?: string;
}

const GitHubUser = z.object({
  id: z.number().int().positive().safe(),
  login: z.string(),
}).passthrough();

export function canonicalizeGitHubLogin(input: string): string {
  const login = input.toLowerCase();
  if (!LOGIN.test(login)) throw new Error(`invalid GitHub login: ${input}`);
  return login;
}

export function isGitHubSubject(input: string): boolean {
  return SUBJECT.test(input);
}

function apiUrl(login: string): string {
  return `https://api.github.com/users/${encodeURIComponent(login)}`;
}

function requestHeaders(etag?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "pi-together",
    "x-github-api-version": "2022-11-28",
    ...(etag ? { "if-none-match": etag } : {}),
  };
}

async function fetchGitHub(url: string, headers: Record<string, string>, options: GitHubRequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try { return await (options.fetch ?? globalThis.fetch)(url, { headers, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function rateLimitResult(response: Response, mapping: GitHubPrincipalMapping): GitHubVerificationResult | null {
  if (response.status !== 403 && response.status !== 429) return null;
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0") return null;
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAt = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : undefined;
  return { kind: "rate-limited", mapping, ...(retryAt ? { retryAt } : {}) };
}

async function readIdentity(response: Response): Promise<{ subject: string; login: string; etag?: string }> {
  const user = GitHubUser.parse(await response.json());
  const login = canonicalizeGitHubLogin(user.login);
  const etag = response.headers.get("etag") ?? undefined;
  return { subject: String(user.id), login, ...(etag ? { etag } : {}) };
}

export async function resolveGitHubLogin(
  input: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubVerificationResult & { kind: "verified" }> {
  const login = canonicalizeGitHubLogin(input);
  const response = await fetchGitHub(apiUrl(login), requestHeaders(), options);
  if (!response.ok) throw new Error(`GitHub login verification failed with HTTP ${response.status}`);
  const identity = await readIdentity(response);
  if (identity.login !== login) throw new Error("GitHub returned a different canonical login");
  return {
    kind: "verified",
    mapping: {
      provider: "github",
      subject: identity.subject,
      login,
      verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
      verification: "verified",
      ...(identity.etag ? { etag: identity.etag } : {}),
    },
  };
}

export async function verifyGitHubMapping(
  mapping: GitHubPrincipalMapping,
  options: GitHubRequestOptions = {},
): Promise<GitHubVerificationResult> {
  const login = canonicalizeGitHubLogin(mapping.login);
  if (!isGitHubSubject(mapping.subject)) throw new Error("invalid GitHub numeric subject");
  const now = options.now ?? (() => new Date());
  const response = await fetchGitHub(apiUrl(login), requestHeaders(mapping.etag), options);

  if (response.status === 304) {
    if (!mapping.etag || mapping.verification !== "verified") {
      return { kind: "disabled", mapping: { ...mapping, verification: "disabled" }, reason: "invalid ETag response" };
    }
    return {
      kind: "not-modified",
      mapping: { ...mapping, login, verifiedAt: now().toISOString(), verification: "verified" },
    };
  }

  const limited = rateLimitResult(response, mapping);
  if (limited) return limited;
  if (!response.ok) {
    return {
      kind: "disabled",
      mapping: { ...mapping, verification: "disabled" },
      reason: `GitHub verification failed with HTTP ${response.status}`,
    };
  }

  const identity = await readIdentity(response);
  if (identity.login !== login || identity.subject !== mapping.subject) {
    return {
      kind: "disabled",
      mapping: { ...mapping, verification: "disabled" },
      reason: "GitHub login no longer maps to the configured numeric subject",
    };
  }
  return {
    kind: "verified",
    mapping: {
      ...mapping,
      login,
      verifiedAt: now().toISOString(),
      verification: "verified",
      ...(identity.etag ? { etag: identity.etag } : {}),
    },
  };
}

export function mappingNeedsVerification(
  mapping: GitHubPrincipalMapping,
  now = new Date(),
  maxAgeMs = 24 * 60 * 60 * 1000,
): boolean {
  if (mapping.verification !== "verified" || !mapping.verifiedAt) return true;
  const verifiedAt = Date.parse(mapping.verifiedAt);
  return !Number.isFinite(verifiedAt) || now.getTime() - verifiedAt >= maxAgeMs;
}
