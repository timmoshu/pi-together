import { describe, expect, it } from "vitest";
import { discoverHost, type ProbeIo } from "../cli/discovery.js";

function fakeIo(overrides: Partial<ProbeIo> = {}) {
  const reads: string[] = [];
  const commands: string[] = [];
  const io: ProbeIo = {
    platform: () => "linux",
    arch: () => "x64",
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.19.0",
    uid: () => 1000,
    username: "example",
    now: () => Date.parse("2026-07-25T00:00:00.000Z"),
    read: async (path) => {
      reads.push(path);
      return "ID=ubuntu\nVERSION_ID=24.04\n";
    },
    exists: async (path) => path === "/run/systemd/system",
    realpath: async (path) => path,
    isDirectory: async () => true,
    exec: async (file, args) => {
      commands.push(`${file} ${args.join(" ")}`);
      if (file === "which") {
        if (args[0] === "pi") return { stdout: "/opt/node/bin/pi\n", stderr: "" };
        if (args[0] === "nginx") return { stdout: "/usr/sbin/nginx\n", stderr: "" };
      }
      if (file === "/usr/bin/node" && args[0] === "--version") return { stdout: "v22.19.0\n", stderr: "" };
      if (file === "/opt/node/bin/pi" && args[0] === "--version") return { stdout: "0.83.0\n", stderr: "" };
      if (file === "/opt/node/bin/pi" && args.includes("--list-models")) return { stdout: "provider model\nexample model-a\n", stderr: "" };
      if (file === "/usr/sbin/nginx") return { stdout: "", stderr: "nginx version: nginx/1.24.0" };
      if (file === "ss") return { stdout: "", stderr: "" };
      if (file === "timedatectl") return { stdout: "yes\n", stderr: "" };
      throw new Error(`unexpected command ${file}`);
    },
    dns: async () => ["192.0.2.10", "2001:db8::10"],
    availableLoopbackPort: async (ports) => ports[0],
    ...overrides,
  };
  return { io, reads, commands };
}

describe("unprivileged discovery", () => {
  it("warns without blocking when system Node is older than the reviewed application runtime", async () => {
    const base = fakeIo();
    const exec = base.io.exec;
    base.io.exec = async (file, args) => file === "/usr/bin/node"
      ? { stdout: "v18.19.1\n", stderr: "" }
      : exec(file, args);
    const report = await discoverHost({}, base.io);
    expect(report.safeToPlan).toBe(true);
    expect(report.checks.find((check) => check.id === "system-node")).toMatchObject({
      status: "warn",
      summary: expect.stringContaining("v18.19.1"),
      detail: expect.stringContaining("v22.19.0"),
    });
  });

  it("warns explicitly when system Node cannot run the privileged helper", async () => {
    const base = fakeIo();
    const exec = base.io.exec;
    base.io.exec = async (file, args) => file === "/usr/bin/node"
      ? { stdout: "v16.20.2\n", stderr: "" }
      : exec(file, args);
    const report = await discoverHost({}, base.io);
    expect(report.safeToPlan).toBe(true);
    expect(report.checks.find((check) => check.id === "system-node")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("/usr/bin/node version 18 or newer"),
    });
  });

  it("selects the first available port from the bounded local listener range", async () => {
    const fake = fakeIo({ availableLoopbackPort: async (ports) => ports.find((port) => port > 43118) });
    const report = await discoverHost({ localListener: true }, fake.io);
    expect((report.facts as { localPort?: number }).localPort).toBe(43119);
    expect(report.checks.find((check) => check.id === "local-port")).toMatchObject({ status: "pass", summary: expect.stringContaining("43119") });
  });

  it("fails safely when no port in the bounded local listener range is available", async () => {
    const fake = fakeIo({ availableLoopbackPort: async () => undefined });
    const report = await discoverHost({ localListener: true }, fake.io);
    expect(report.safeToPlan).toBe(false);
    expect(report.checks.find((check) => check.id === "local-port")?.status).toBe("fail");
  });

  it("reports the supported host matrix without reading Pi credentials or mutating ports", async () => {
    const fake = fakeIo();
    const report = await discoverHost({ domain: "pi.example.com", sharedRepositoryFolders: ["/srv/work"] }, fake.io);
    expect(report.safeToPlan).toBe(true);
    expect(report.facts).toMatchObject({
      observedAt: "2026-07-25T00:00:00.000Z", platform: "linux", arch: "x64",
      user: { uid: 1000, username: "example", group: "example" }, piPath: "/opt/node/bin/pi",
      sharedRepositoryFolders: { "/srv/work": "/srv/work" }, existingInstall: false,
    });
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.status]))).toMatchObject({
      platform: "pass", os: "pass", arch: "pass", node: "pass", user: "pass", systemd: "pass", pi: "pass", models: "pass",
      nginx: "pass", ports: "pass", clock: "pass", dns: "pass", "workspace:/srv/work": "pass",
    });
    expect(fake.reads).toEqual(["/etc/os-release"]);
    expect(fake.commands.some((command) => /credential|auth\.json|settings\.json/.test(command))).toBe(false);
    expect(fake.commands.some((command) => command.includes("ss -H -ltn"))).toBe(true);
  });

  it("detects partial installations from either accessible marker created before the protected manifest", async () => {
    for (const marker of [
      "/opt/pi-together/current",
      "/etc/systemd/system/pi-together.service",
    ]) {
      const fake = fakeIo({ exists: async (path) => path === "/run/systemd/system" || path === marker });
      const report = await discoverHost({}, fake.io);
      expect(report.facts.existingInstall, marker).toBe(true);
      expect(report.checks.find((check) => check.id === "existing-install")?.status).toBe("warn");
    }
  });

  it("does not treat the inaccessible post-uninstall state directory as a live installation", async () => {
    const fake = fakeIo({
      exists: async (path) => {
        if (path === "/var/lib/pi-together/install-manifest.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return path === "/run/systemd/system";
      },
    });
    const report = await discoverHost({}, fake.io);
    expect(report.facts.existingInstall).toBe(false);
    expect(report.checks.find((check) => check.id === "existing-install")?.status).toBe("pass");
  });

  it("fails unsupported OS, architecture, Node, Pi, DNS, and workspace deterministically", async () => {
    const fake = fakeIo({
      platform: () => "darwin",
      arch: () => "riscv64",
      nodeVersion: "v18.20.0",
      uid: () => 0,
      username: "root",
      read: async () => "ID=fedora\nVERSION_ID=41\n",
      isDirectory: async () => false,
      dns: async () => [],
      exec: async (file, args) => {
        if (file === "which" && args[0] === "pi") return { stdout: "/usr/bin/pi\n", stderr: "" };
        if (file === "which") throw new Error("missing");
        if (file === "/usr/bin/pi" && args[0] === "--version") return { stdout: "0.81.0\n", stderr: "" };
        if (file === "/usr/bin/pi") return { stdout: "provider model\n", stderr: "" };
        if (file === "ss") return { stdout: "LISTEN 0 10 0.0.0.0:443 0.0.0.0:*\n", stderr: "" };
        if (file === "timedatectl") return { stdout: "no\n", stderr: "" };
        throw new Error("missing");
      },
    });
    const report = await discoverHost({ domain: "bad.example.com", sharedRepositoryFolders: ["/missing"] }, fake.io);
    expect(report.safeToPlan).toBe(false);
    for (const id of ["platform", "os", "arch", "node", "user", "pi", "dns", "workspace:/missing"]) {
      expect(report.checks.find((check) => check.id === id)?.status, id).toBe("fail");
    }
    expect(report.checks.find((check) => check.id === "nginx")?.status).toBe("warn");
  });
});
