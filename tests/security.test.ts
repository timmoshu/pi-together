import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeOrigin,
  type AuthenticatedPrincipal,
  type SecurityConfig,
} from "../server/security.js";

const principal: AuthenticatedPrincipal = {
  provider: "github",
  subject: "1234567",
  login: "octocat",
};
const cfg: SecurityConfig = {
  mode: "reverse-proxy",
  proxySecret: "s".repeat(43),
  principalsByLogin: new Map([[principal.login, principal]]),
};

const req = (headers: Record<string, string | string[]>, remoteAddress = "127.0.0.1") => ({
  headers,
  remoteAddress,
});

const proxyHeaders = {
  "x-pi-together-proxy-secret": "s".repeat(43),
  "x-pi-together-login": "octocat",
};

describe("authorize", () => {
  it("returns the canonical principal only when proxy secret and login agree", () => {
    expect(authorize(req(proxyHeaders), cfg)).toEqual({ status: 200, principal });
  });

  it("does not accept either proxy credential on its own", () => {
    expect(authorize(req({ "x-pi-together-proxy-secret": "s".repeat(43) }), cfg).status).toBe(401);
    expect(authorize(req({ "x-pi-together-login": "octocat" }), cfg).status).toBe(401);
  });

  it("rejects unknown logins, wrong secrets, and generic forwarded identity", () => {
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-login": "hubot" }), cfg).status).toBe(403);
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-proxy-secret": "x".repeat(43) }), cfg).status).toBe(403);
    expect(authorize(req({ "x-forwarded-user": "octocat" }), cfg).status).toBe(403);
    expect(authorize(req({ "x-auth-request-user": "octocat" }), cfg).status).toBe(403);
  });

  it("rejects duplicate, combined, noncanonical, or padded dedicated headers", () => {
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-login": ["octocat", "hubot"] }), cfg).status).toBe(403);
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-proxy-secret": ["a", "b"] }), cfg).status).toBe(403);
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-login": "octocat,hubot" }), cfg).status).toBe(403);
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-login": "OctoCat" }), cfg).status).toBe(403);
    expect(authorize(req({ ...proxyHeaders, "x-pi-together-login": " octocat" }), cfg).status).toBe(403);
    expect(authorize({
      ...req(proxyHeaders),
      rawHeaders: [
        "X-Pi-Together-Login", "octocat",
        "x-pi-together-login", "hubot",
        "X-Pi-Together-Proxy-Secret", "s".repeat(43),
      ],
    }, cfg).status).toBe(403);
  });

  it("rejects generic browser/proxy auth material even with valid dedicated headers", () => {
    for (const [name, value] of [
      ["authorization", "Bearer example"],
      ["cookie", "session=example"],
      ["x-forwarded-user", "octocat"],
      ["x-auth-request-user", "octocat"],
      ["x-pi-legacy-test", "example"],
    ]) {
      expect(authorize(req({ ...proxyHeaders, [name]: value }), cfg).status).toBe(403);
    }
  });

  it("authorizes local mode only from literal loopback", () => {
    expect(authorize(req({}, "127.0.0.1"), { mode: "local" })).toEqual({
      status: 200,
      principal: { provider: "local", subject: "local", login: "Local user" },
    });
    expect(authorize(req({}, "::1"), { mode: "local" }).status).toBe(200);
    expect(authorize(req({}, "192.0.2.10"), { mode: "local" }).status).toBe(403);
  });

  it("supports explicit test-only principal injection and fails closed for unknown switches", () => {
    expect(authorize(req({}, "192.0.2.10"), { mode: "test", principal })).toEqual({ status: 200, principal });
    const bob = { provider: "github" as const, subject: "2002", login: "bob" };
    const testConfig = { mode: "test" as const, principal, principalsByLogin: new Map([["bob", bob]]) };
    expect(authorize(req({ "x-pi-together-test-login": "bob" }), testConfig)).toEqual({ status: 200, principal: bob });
    expect(authorize(req({ "x-pi-together-test-login": "mallory" }), testConfig)).toEqual({ status: 403 });
  });

  it.each([
    [undefined],
    ["null"],
    ["http://agents.example.com"],
    ["https://agents.example.com:444"],
    ["https://agents.example.com.evil.invalid"],
    ["https://evil.invalid/https://agents.example.com"],
    [" https://agents.example.com"],
    ["https://agents.example.com,https://evil.invalid"],
  ])("rejects unsafe-request Origin %s", (origin) => {
    const headers = origin === undefined ? {} : { origin };
    expect(authorizeOrigin(headers, "https://agents.example.com")).toBe(403);
  });

  it("accepts exactly one canonical expected Origin", () => {
    expect(authorizeOrigin({ origin: "https://agents.example.com" }, "https://agents.example.com")).toBe(200);
    expect(authorizeOrigin(
      { origin: "https://agents.example.com" },
      "https://agents.example.com",
      ["Origin", "https://agents.example.com", "origin", "https://agents.example.com"],
    )).toBe(403);
  });
});
