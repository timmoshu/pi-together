import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configuredLogSecrets, ownedLogArguments, redactDiagnosticText, renderDoctor, renderStatus, runDoctor, runStatus, type DiagnosticIo } from "../cli/diagnostics.js";

const now = Date.parse("2026-07-25T12:00:00.000Z");
const config = Buffer.from(`${JSON.stringify({
  version: 2,
  mode: "reverse-proxy",
  listener: { kind: "unix", path: "/run/pi-together/app.sock" },
  publicOrigin: "https://pi.example.com",
  proxySecret: "proxy-secret-canary-value-that-must-never-leak-123",
  principals: [{ provider: "github", subject: "1001", login: "alice", verifiedAt: "2026-07-23T00:00:00.000Z", verification: "verified", etag: "synthetic-etag" }],
  sharedRepositoryFolders: ["/srv/work"],
}, null, 2)}\n`);
const artifact = Buffer.from("synthetic-server");
const manifest = Buffer.from(JSON.stringify({
  package: { version: "0.1.0" },
  artifacts: [{ path: "dist/server/index.js", bytes: artifact.length, sha256: createHash("sha256").update(artifact).digest("hex") }],
}));

function fixture(failure?: string, workspaceMode = 0o750): DiagnosticIo {
  return {
    now: () => now,
    uid: () => 1000,
    state: async (path) => {
      if (failure === "PTD-CONFIG" && path.endsWith("config.json")) return { kind: "absent" };
      if (path.endsWith("config.json")) return { kind: "file", mode: 0o600, uid: 1000, gid: 1000 };
      if (path === "/srv/work") return failure === "PTD-WORKSPACES" ? { kind: "absent" } : { kind: "directory", mode: workspaceMode, uid: 1000, gid: 1000 };
      if (path === "/run/pi-together/app.sock") return failure === "PTD-LISTENER" ? { kind: "absent" } : { kind: "other", mode: 0o660, uid: 1000, gid: 1000 };
      if (path.endsWith("privkey1.pem")) return { kind: "file", mode: failure === "PTD-CERTIFICATE" ? 0o644 : 0o600, uid: 0, gid: 0 };
      return { kind: "file", mode: 0o644, uid: 0, gid: 0 };
    },
    read: async (path) => {
      if (path.endsWith("config.json")) return config;
      if (path.endsWith("manifest.json")) return manifest;
      if (path.endsWith("server/index.js")) return failure === "PTD-RELEASE" ? Buffer.from("tampered") : artifact;
      throw new Error("secret-canary-from-read");
    },
    realpath: async (path) => {
      if (path.endsWith("privkey.pem")) return "/etc/letsencrypt/archive/pi.example.com/privkey1.pem";
      if (failure === "PTD-RELEASE") throw new Error("release-secret-canary");
      return path.endsWith("/previous") ? "/opt/pi-together/releases/0.0.9" : "/opt/pi-together/releases/0.1.0";
    },
    exec: async (file, args) => {
      if (file === "pi" && args[0] === "--version") return { stdout: failure === "PTD-PI-VERSION" ? "9.9.9 version-secret-canary\n" : "0.83.0 version-secret-canary\n", stderr: "" };
      if (file === "pi") {
        if (failure === "PTD-PI-MODELS") return { stdout: "", stderr: "model-secret-canary" };
        return { stdout: "provider model\n", stderr: "" };
      }
      if (file === "/usr/bin/openssl" && failure === "PTD-CERTIFICATE") throw new Error("certificate-secret-canary");
      if (file === "/usr/bin/ss") return { stdout: failure === "PTD-PORTS" ? "" : "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:4180 0.0.0.0:*\n", stderr: "" };
      if (file === "/bin/systemctl" && args[0] === "show") return { stdout: "1234\n", stderr: "" };
      if (file === "/bin/ps") return { stdout: failure === "PTD-PROCESS-USERS" ? "root\n" : "example\n", stderr: "" };
      if (file === "/bin/systemctl" && args[0] === "is-enabled") return { stdout: failure === "PTD-RENEWAL" ? "disabled\n" : "enabled\n", stderr: "" };
      if (file === "/bin/systemctl" && args[0] === "is-active") {
        if (failure === "PTD-SERVICES" && args[1] === "pi-together.service") throw new Error("service-secret-canary");
        if (failure === "PTD-RENEWAL" && args[1] === "certbot.timer") throw new Error("timer-secret-canary");
        return { stdout: "active\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    dns: async () => failure === "PTD-DNS" ? [] : ["192.0.2.10"],
    fetch: async () => failure === "PTD-PUBLIC-REDIRECT"
      ? { status: 500 }
      : { status: 302, location: "https://github.com/login/oauth/authorize?redirect_uri=https%3A%2F%2Fpi.example.com%2Foauth2%2Fcallback" },
    tlsCertificate: async () => {
      if (failure === "PTD-CERTIFICATE") throw new Error("certificate-secret-canary");
      return { validTo: now + 90 * 24 * 60 * 60_000 };
    },
    privateHealth: async () => failure === "PTD-PRIVATE-HEALTH" ? 500 : 200,
    verifyPrincipal: async () => failure === "PTD-IDENTITY"
      ? { kind: "disabled", subject: "1001", login: "alice" }
      : { kind: "not-modified", subject: "1001", login: "alice" },
  };
}

describe("operational diagnostics", () => {
  it("renders stable healthy human and JSON doctor output", async () => {
    const report = await runDoctor({ configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together", piBin: "pi" }, fixture());
    expect(report.overall).toBe("pass");
    expect(report.checks).toHaveLength(15);
    expect(report).toMatchSnapshot("healthy doctor JSON");
    expect(renderDoctor(report)).toMatchSnapshot("healthy doctor human");
  });

  it("verifies a stable release against its package manifest", async () => {
    const base = fixture();
    const releaseId = "0.1.0";
    const io: DiagnosticIo = {
      ...base,
      realpath: async (path) => path.endsWith("/previous")
        ? "/opt/pi-together/releases/0.1.0"
        : `/opt/pi-together/releases/${releaseId}`,
    };
    const report = await runDoctor({ configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together", piBin: "pi" }, io);
    expect(report.checks.find((item) => item.code === "PTD-RELEASE")).toMatchObject({ status: "pass", summary: expect.stringContaining(releaseId) });
  });

  it("probes Pi through the exact Node runtime recorded in the service environment", async () => {
    const base = fixture();
    const calls: Array<[string, string[]]> = [];
    const io: DiagnosticIo = {
      ...base,
      exec: async (file, args) => {
        calls.push([file, args]);
        if (file === "/bin/systemctl" && args.includes("--property=Environment")) {
          return {
            stdout: "PATH=/opt/node/bin:/usr/sbin:/usr/bin PI_BIN=/opt/node/lib/pi.js NODE_ENV=production\n",
            stderr: "",
          };
        }
        if (file === "/opt/node/bin/node" && args[0] === "/opt/node/lib/pi.js" && args[1] === "--version") {
          return { stdout: "0.83.0\n", stderr: "" };
        }
        if (file === "/opt/node/bin/node" && args[0] === "/opt/node/lib/pi.js") {
          return { stdout: "provider model\nexample model-a\n", stderr: "" };
        }
        return base.exec(file, args);
      },
    };
    const report = await runDoctor({ configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together" }, io);
    expect(report.checks.find((item) => item.code === "PTD-PI-VERSION")?.status).toBe("pass");
    expect(report.checks.find((item) => item.code === "PTD-PI-MODELS")?.status).toBe("pass");
    expect(calls).toContainEqual(["/opt/node/bin/node", ["/opt/node/lib/pi.js", "--version"]]);
  });

  it("treats writable invoking-user-owned workspace roots as healthy", async () => {
    const report = await runDoctor(
      { configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together", piBin: "pi" },
      fixture(undefined, 0o777),
    );
    expect(report.checks.find((item) => item.code === "PTD-WORKSPACES")).toMatchObject({ status: "pass" });
  });

  it.each([
    "PTD-CONFIG", "PTD-RELEASE", "PTD-PI-VERSION", "PTD-PI-MODELS", "PTD-WORKSPACES", "PTD-IDENTITY",
    "PTD-DNS", "PTD-LISTENER", "PTD-PORTS", "PTD-SERVICES", "PTD-PROCESS-USERS", "PTD-CERTIFICATE", "PTD-RENEWAL", "PTD-PRIVATE-HEALTH", "PTD-PUBLIC-REDIRECT",
  ])("diagnoses %s with a stable code and remediation", async (code) => {
    const report = await runDoctor({ configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together", piBin: "pi" }, fixture(code));
    expect(report.overall).toBe("fail");
    expect(report.checks.find((item) => item.code === code)).toMatchObject({ status: "fail", remediation: expect.any(String) });
    expect(JSON.stringify(report)).not.toContain("secret-canary");
    expect(JSON.stringify(report)).not.toContain("proxy-secret-canary");
  });

  it("keeps the complete failure/remediation catalog stable", async () => {
    const codes = [
      "PTD-CONFIG", "PTD-RELEASE", "PTD-PI-VERSION", "PTD-PI-MODELS", "PTD-WORKSPACES", "PTD-IDENTITY",
      "PTD-DNS", "PTD-LISTENER", "PTD-PORTS", "PTD-SERVICES", "PTD-PROCESS-USERS", "PTD-CERTIFICATE", "PTD-RENEWAL", "PTD-PRIVATE-HEALTH", "PTD-PUBLIC-REDIRECT",
    ];
    const catalog = [];
    for (const code of codes) {
      const report = await runDoctor({ configPath: "/etc/pi-together/config.json", releaseRoot: "/opt/pi-together", piBin: "pi" }, fixture(code));
      catalog.push(report.checks.find((item) => item.code === code));
    }
    expect(catalog).toMatchSnapshot("doctor failure catalog");
  });

  it("reports installed/current/previous versions and owned service states", async () => {
    const report = await runStatus("/opt/pi-together", fixture());
    expect(report).toMatchSnapshot("status JSON");
    expect(renderStatus(report)).toMatchSnapshot("status human");
  });

  it("loads only exact mode-0600 Pi Together secrets for root-side log redaction", async () => {
    const base = fixture();
    const rootIo: DiagnosticIo = {
      ...base,
      uid: () => 0,
      state: async (path) => path.endsWith("config.json")
        ? { kind: "file", mode: 0o600, uid: 1000, gid: 1000 }
        : { kind: "file", mode: 0o600, uid: 0, gid: 0 },
      read: async (path) => path.endsWith("config.json") ? config : Buffer.from(path.includes("client") ? "oauth secret with spaces" : "cookie-secret-value-123456"),
    };
    expect(await configuredLogSecrets("/etc/pi-together/config.json", rootIo)).toEqual([
      "proxy-secret-canary-value-that-must-never-leak-123", "oauth secret with spaces", "cookie-secret-value-123456",
    ]);
  });

  it("restricts journal access to exact owned units", () => {
    expect(ownedLogArguments("app", false)).toEqual(["--no-pager", "--output=short-iso", "--unit", "pi-together.service", "--lines", "200"]);
    expect(ownedLogArguments("certbot", true)).toEqual(["--no-pager", "--output=short-iso", "--unit", "certbot.service", "--follow"]);
    expect(() => ownedLogArguments("../../etc/shadow" as "app", false)).toThrow(/unknown log component/);
  });

  it("defensively redacts configured and structured secrets from owned logs", () => {
    const output = redactDiagnosticText(
      "proxy-secret-canary-value-that-must-never-leak-123 client_secret=oauth-canary-123456789 token: abcdefghijklmnopqrstuvwxyz012345 Bearer bearer-canary-123456789\n",
      ["proxy-secret-canary-value-that-must-never-leak-123"],
    );
    expect(output).not.toContain("canary");
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
