import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, migrateLegacyConfig, parseConfig, resolveConfig } from "../server/config.js";

const SECRET = "s".repeat(43);

function reverseProxyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    mode: "reverse-proxy",
    listener: { kind: "tcp", host: "127.0.0.1", port: 43117, fallback: true },
    publicOrigin: "https://agents.example.com",
    proxySecret: SECRET,
    principals: [
      {
        provider: "github",
        subject: "1234567",
        login: "octocat",
        verifiedAt: "2025-01-02T03:04:05.000Z",
        verification: "verified",
      },
    ],
    sharedRepositoryFolders: ["/home/example/projects"],
    ...overrides,
  };
}

describe("Pi Together configuration", () => {
  it("parses Tailscale Funnel as the existing reverse-proxy security model", () => {
    const config = parseConfig(reverseProxyConfig({ mode: "tailscale-funnel", publicOrigin: "https://node.tailnet.ts.net", tailscaleDnsName: "node.tailnet.ts.net" }));
    expect(config.mode).toBe("tailscale-funnel");
    expect(resolveConfig(config).security.mode).toBe("reverse-proxy");
  });

  it("migrates legacy roots exactly and rejects mixed or redundant policies", () => {
    const legacy = { version: 1, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, workspaceRoots: ["/srv/work"] };
    expect(migrateLegacyConfig(legacy)).toEqual({ version: 2, mode: "local", listener: legacy.listener, sharedRepositoryFolders: ["/srv/work"] });
    expect(() => migrateLegacyConfig({ ...legacy, sharedRepositoryFolders: ["/srv/other"] })).toThrow(/mixed|only|legacy/i);
    expect(() => parseConfig({ ...migrateLegacyConfig(legacy) as object, sharedRepositoryFolders: ["/srv", "/srv/work"] })).toThrow(/contain/i);
  });

  it("parses strict local and reverse-proxy modes", () => {
    expect(parseConfig({
      version: 2,
      mode: "local",
      listener: { kind: "tcp", host: "127.0.0.1", port: 43117 },
      sharedRepositoryFolders: ["/home/example/projects"],
    }).mode).toBe("local");
    expect(parseConfig(reverseProxyConfig()).mode).toBe("reverse-proxy");
    expect(parseConfig(reverseProxyConfig({ listener: { kind: "unix", path: "/run/pi-together/app.sock" } })).mode)
      .toBe("reverse-proxy");
  });

  it.each([
    ["unknown mode", { ...reverseProxyConfig(), mode: "public" }],
    ["missing origin", (() => { const c = reverseProxyConfig(); delete c.publicOrigin; return c; })()],
    ["short secret", reverseProxyConfig({ proxySecret: "too-short" })],
    ["empty allowlist", reverseProxyConfig({ principals: [] })],
    ["broad bind", reverseProxyConfig({ listener: { kind: "tcp", host: "0.0.0.0", port: 43117, fallback: true } })],
    ["implicit TCP fallback", reverseProxyConfig({ listener: { kind: "tcp", host: "127.0.0.1", port: 43117 } })],
    ["relative socket", reverseProxyConfig({ listener: { kind: "unix", path: "run/app.sock" } })],
    ["noncanonical origin", reverseProxyConfig({ publicOrigin: "https://agents.example.com/" })],
    ["HTTP origin", reverseProxyConfig({ publicOrigin: "http://agents.example.com" })],
    ["malformed subject", reverseProxyConfig({ principals: [{ provider: "github", subject: "user-1", login: "octocat", verifiedAt: "2025-01-02T03:04:05.000Z", verification: "verified" }] })],
    ["noncanonical login", reverseProxyConfig({ principals: [{ provider: "github", subject: "123", login: "OctoCat", verifiedAt: "2025-01-02T03:04:05.000Z", verification: "verified" }] })],
  ])("rejects %s", (_name, config) => {
    expect(() => parseConfig(config)).toThrow();
  });

  it("rejects duplicate login and subject mappings", () => {
    const first = (reverseProxyConfig().principals as Record<string, unknown>[])[0]!;
    expect(() => parseConfig(reverseProxyConfig({ principals: [first, { ...first, subject: "7654321" }] }))).toThrow(/login/i);
    expect(() => parseConfig(reverseProxyConfig({ principals: [first, { ...first, login: "hubot" }] }))).toThrow(/subject/i);
  });

  it("configures an optional bot email only from an already verified GitHub mapping", () => {
    const config = parseConfig(reverseProxyConfig());
    expect(resolveConfig(config, {
      PI_TOGETHER_GIT_COMMITTER_NAME: "Pi Together Bot",
      PI_TOGETHER_GIT_COMMITTER_GITHUB_LOGIN: "octocat",
    }).gitCommitter).toEqual({
      name: "Pi Together Bot",
      email: "1234567+octocat@users.noreply.github.com",
    });
    expect(() => resolveConfig(config, { PI_TOGETHER_GIT_COMMITTER_GITHUB_LOGIN: "unknown" })).toThrow(/committer/i);
    const local = parseConfig({ version: 2, mode: "local", listener: { kind: "tcp", host: "127.0.0.1", port: 43117 }, sharedRepositoryFolders: ["/srv/work"] });
    expect(() => resolveConfig(local, { PI_TOGETHER_GIT_COMMITTER_GITHUB_LOGIN: "octocat" })).toThrow(/committer/i);
  });

  it("does not activate pending or disabled manual mappings", () => {
    for (const verification of ["pending", "disabled"]) {
      const config = parseConfig(reverseProxyConfig({
        principals: [{ provider: "github", subject: "123", login: "octocat", verifiedAt: "2025-01-02T03:04:05.000Z", verification }],
      }));
      expect(() => resolveConfig(config, {})).toThrow(/verified/i);
    }
  });

  it("requires a mode-0600 regular config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-together-config-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify(reverseProxyConfig()), { mode: 0o644 });
    expect(() => loadConfig({ PI_TOGETHER_CONFIG_FILE: path })).toThrow(/0600/);

    chmodSync(path, 0o600);
    const link = join(directory, "config-link.json");
    symlinkSync(path, link);
    expect(() => loadConfig({ PI_TOGETHER_CONFIG_FILE: link })).toThrow(/symbolic link/);

    const resolved = loadConfig({ PI_TOGETHER_CONFIG_FILE: path, PI_TOGETHER_ADAPTER: "fake" });
    expect(resolved.security.mode).toBe("reverse-proxy");
    expect(resolved.listener).toEqual({ kind: "tcp", host: "127.0.0.1", port: 43117, fallback: true });
  });
});
