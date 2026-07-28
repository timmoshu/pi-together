import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { canonicalizeGitHubLogin } from "./github-principals.js";

export interface GitHubPrincipal {
  provider: "github";
  subject: string;
  login: string;
}

export interface LocalPrincipal {
  provider: "local";
  subject: "local";
  login: "Local user";
}

export type AuthenticatedPrincipal = GitHubPrincipal | LocalPrincipal;

export type SecurityConfig =
  | { mode: "local" }
  | {
      mode: "reverse-proxy";
      proxySecret: string;
      principalsByLogin: ReadonlyMap<string, GitHubPrincipal>;
    }
  | {
      /** Test harness injection. loadConfig never produces this mode. */
      mode: "test";
      principal: AuthenticatedPrincipal;
      /** Browser-E2E-only identity switch; never produced by loadConfig. */
      principalsByLogin?: ReadonlyMap<string, GitHubPrincipal>;
    };

export interface AuthzResult {
  status: 200 | 401 | 403;
  principal?: AuthenticatedPrincipal;
}

export interface AuthzRequest {
  headers: IncomingHttpHeaders;
  rawHeaders?: readonly string[];
  remoteAddress: string | undefined;
}

const LOCAL_PRINCIPAL: LocalPrincipal = {
  provider: "local",
  subject: "local",
  login: "Local user",
};

function singleHeader(
  headers: IncomingHttpHeaders,
  name: string,
  rawHeaders?: readonly string[],
): { value?: string; malformed: boolean } {
  if (rawHeaders) {
    let count = 0;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === name) count++;
    }
    if (count > 1) return { malformed: true };
  }
  const raw = headers[name];
  if (Array.isArray(raw)) return { malformed: true };
  if (raw === undefined) return { malformed: false };
  if (!raw || raw.includes(",") || raw !== raw.trim()) return { malformed: true };
  return { value: raw, malformed: false };
}

function hasForbiddenAuthHeaders(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((rawName) => {
    const name = rawName.toLowerCase();
    return name === "authorization"
      || name === "cookie"
      || name === "x-forwarded-user"
      || name === "x-auth-request-user"
      || name.startsWith("x-auth-request-")
      || (name.startsWith("x-pi-")
        && name !== "x-pi-together-proxy-secret"
        && name !== "x-pi-together-login");
  });
}

function safeEqual(a: string, b: string): boolean {
  const actual = Buffer.from(a);
  const expected = Buffer.from(b);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function isLiteralLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function authorize(req: AuthzRequest, config: SecurityConfig): AuthzResult {
  if (config.mode === "test") {
    if (!config.principalsByLogin) return { status: 200, principal: config.principal };
    const requested = singleHeader(req.headers, "x-pi-together-test-login", req.rawHeaders);
    if (requested.malformed) return { status: 403 };
    if (!requested.value) return { status: 200, principal: config.principal };
    const principal = config.principalsByLogin.get(requested.value);
    return principal ? { status: 200, principal } : { status: 403 };
  }
  if (config.mode === "local") {
    return isLiteralLoopback(req.remoteAddress)
      ? { status: 200, principal: LOCAL_PRINCIPAL }
      : { status: 403 };
  }

  if (hasForbiddenAuthHeaders(req.headers)) return { status: 403 };
  const secret = singleHeader(req.headers, "x-pi-together-proxy-secret", req.rawHeaders);
  const loginHeader = singleHeader(req.headers, "x-pi-together-login", req.rawHeaders);
  if (secret.malformed || loginHeader.malformed) return { status: 403 };
  if (!secret.value && !loginHeader.value) return { status: 401 };
  if (!secret.value || !loginHeader.value) return { status: 401 };
  if (!safeEqual(secret.value, config.proxySecret)) return { status: 403 };

  let login: string;
  try {
    login = canonicalizeGitHubLogin(loginHeader.value);
  } catch {
    return { status: 403 };
  }
  if (login !== loginHeader.value) return { status: 403 };
  const principal = config.principalsByLogin.get(login);
  return principal ? { status: 200, principal } : { status: 403 };
}

export function authorizeOrigin(
  headers: IncomingHttpHeaders,
  expectedOrigin: string,
  rawHeaders?: readonly string[],
): 200 | 403 {
  const origin = singleHeader(headers, "origin", rawHeaders);
  if (origin.malformed || origin.value !== expectedOrigin) return 403;
  return 200;
}
