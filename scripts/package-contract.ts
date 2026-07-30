import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PI_COMPATIBILITY } from "../cli/pi-version.js";

interface PackResult { filename: string; files: Array<{ path: string; mode: number }> }
interface Manifest {
  schemaVersion: number;
  package: { name: string; version: string; license: string };
  runtime: { node: string; pi: string };
  supportedTargets: string[];
  experimentalTargets: string[];
  privilegedHelpers: { status: string; selections: Record<string, string | null> };
  signatures: { status: string };
  artifacts: Array<{ path: string; bytes: number; sha256: string }>;
}

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "pi-together-contract-"));
const archives: string[] = [];
const run = (file: string, args: string[], cwd = root) => execFileSync(file, args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 32 * 1024 * 1024,
});

function pack(cwd = root): { result: PackResult; archive: string } {
  const result = (JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts"], cwd)) as PackResult[])[0]!;
  if (!result.filename || basename(result.filename) !== result.filename) throw new Error("unsafe npm pack filename");
  const archive = join(cwd, result.filename);
  archives.push(archive);
  return { result, archive };
}

try {
  const { result, archive } = pack();
  const paths = result.files.map((file) => file.path);
  const required = [
    "package.json",
    "LICENSE",
    "dist/cli/pi-together.js",
    "dist/server/index.js",
    "dist/extension/pi-together-attribution-v1.js",
    "dist/extension/git-bin/git",
    "dist/release/manifest.json",
    "dist/release/SHA256SUMS",
    "dist/release/LICENSE",
    "dist/release/third-party-licenses.json",
    "dist/release/NOTICE",
    "dist/release/sbom.cdx.json",
    "dist/client/index.html",
    "dist/privileged/apply.js",
  ];
  for (const path of required) if (!paths.includes(path)) throw new Error(`packed package is missing ${path}`);
  const launcher = result.files.find((file) => file.path === "dist/extension/git-bin/git");
  if (!launcher || (launcher.mode & 0o111) === 0) throw new Error("managed Git launcher is not executable in the package");
  const forbidden = paths.filter((path) => path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".map")
    || path.startsWith("tests/") || path.startsWith("planning-artifacts/") || path.startsWith(".github/"));
  if (forbidden.length) throw new Error(`source-only files escaped package allowlist: ${forbidden.join(", ")}`);

  const extracted = join(work, "extracted");
  run("mkdir", ["-p", extracted]);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const packaged = join(extracted, "package");
  const projectLicense = readFileSync(join(packaged, "LICENSE"), "utf8");
  if (!projectLicense.startsWith("MIT License\n") || !projectLicense.includes("Copyright (c) 2026 Tim Xu")
    || readFileSync(join(packaged, "dist/release/LICENSE"), "utf8") !== projectLicense) {
    throw new Error("packed package project license is missing, incorrect, or inconsistent");
  }
  const manifest = JSON.parse(readFileSync(join(packaged, "dist/release/manifest.json"), "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.package.name !== "pi-together" || manifest.package.license !== "MIT") {
    throw new Error("invalid release manifest identity or license");
  }
  if (manifest.runtime.pi !== PI_COMPATIBILITY) throw new Error("unexpected Pi compatibility range");
  if (manifest.supportedTargets.join(",") !== "linux-x64" || manifest.experimentalTargets.join(",") !== "linux-arm64") {
    throw new Error("unexpected supported/experimental target matrix");
  }
  if (manifest.signatures.status !== "unsigned-private-build") throw new Error("private build signature status is dishonest");
  if (manifest.privilegedHelpers.status !== "bundled-system-node18-narrow-apply"
    || Object.values(manifest.privilegedHelpers.selections).some((selection) => selection !== "dist/privileged/apply.js")) {
    throw new Error("private package privileged helper selection is invalid");
  }
  for (const artifact of manifest.artifacts) {
    const data = readFileSync(join(packaged, artifact.path));
    const digest = createHash("sha256").update(data).digest("hex");
    if (data.length !== artifact.bytes || digest !== artifact.sha256) throw new Error(`artifact mismatch: ${artifact.path}`);
  }
  const licenses = JSON.parse(readFileSync(join(packaged, "dist/release/third-party-licenses.json"), "utf8")) as {
    dependencies: Array<{ name: string; version: string; license: string }>;
  };
  if (licenses.dependencies.some((dependency) => !dependency.license || dependency.license === "UNKNOWN")) {
    throw new Error("runtime dependency license inventory is incomplete");
  }
  const sbom = JSON.parse(readFileSync(join(packaged, "dist/release/sbom.cdx.json"), "utf8")) as {
    bomFormat?: string; specVersion?: string; components?: Array<{ name: string; version: string }>;
  };
  const notice = readFileSync(join(packaged, "dist/release/NOTICE"), "utf8");
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components)
    || JSON.stringify(sbom.components.map(({ name, version }) => ({ name, version }))) !== JSON.stringify(licenses.dependencies.map(({ name, version }) => ({ name, version })))) {
    throw new Error("SBOM and license inventory are inconsistent");
  }
  for (const dependency of licenses.dependencies) if (!notice.includes(`${dependency.name} `) || !notice.includes(`(${dependency.license})`)) throw new Error("NOTICE is inconsistent with license inventory");

  const install = join(work, "install");
  mkdirSync(install);
  run("npm", ["init", "-y"], install);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], install);
  const localBin = join(install, "node_modules", ".bin", "pi-together");
  if (!run(localBin, ["version"], install).includes(manifest.package.version)) throw new Error("local package binary version failed");
  if (!run(localBin, ["setup", "--help"], install).includes("pi-together setup")) throw new Error("local setup help failed");
  if (!run(localBin, ["users", "--help"], install).includes("pi-together users")) throw new Error("local users help failed");
  const help = run(localBin, ["help"], install);
  if (!["onboard", "manage", "users", "share", "tailscale", "doctor", "status", "logs", "upgrade", "recover", "uninstall"].every((command) => help.includes(command))) throw new Error("operational command help failed");
  const helperRefusal = spawnSync("/usr/bin/node", [join(packaged, "dist/privileged/apply.js")], {
    input: "{}", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  if (helperRefusal.status === 0 || !helperRefusal.stderr.includes("privileged lifecycle refused or failed")) {
    throw new Error("privileged helper did not fail closed for an invalid direct request");
  }
  if (!run("npm", ["exec", "--offline", "--", "pi-together", "setup", "--help"], install).includes("pi-together setup")) {
    throw new Error("npx-style setup help failed");
  }

  const globalPrefix = join(work, "global");
  run("npm", ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", archive]);
  if (!run(join(globalPrefix, "bin", "pi-together"), ["version"]).includes(manifest.package.version)) {
    throw new Error("global binary smoke failed");
  }

  // Defensive compatibility only: mirrors/scopes must not rename the stable CLI. This is not a release fallback.
  const scoped = join(work, "scoped");
  run("cp", ["-R", packaged, scoped]);
  const scopedPackage = JSON.parse(readFileSync(join(scoped, "package.json"), "utf8")) as Record<string, unknown>;
  scopedPackage["name"] = "@example/pi-together";
  writeFileSync(join(scoped, "package.json"), JSON.stringify(scopedPackage, null, 2) + "\n");
  chmodSync(join(scoped, "dist/cli/pi-together.js"), 0o755);
  const scopedArchive = pack(scoped).archive;
  const scopedPrefix = join(work, "scoped-global");
  run("npm", ["install", "--global", "--prefix", scopedPrefix, "--ignore-scripts", "--no-audit", "--no-fund", scopedArchive]);
  if (!readdirSync(join(scopedPrefix, "bin")).includes("pi-together")) throw new Error("scoped package lost pi-together binary");

  process.stdout.write(JSON.stringify({
    ok: true,
    files: paths.length,
    artifacts: manifest.artifacts.length,
    installWithoutBuild: true,
    globalBinary: true,
    setupHelp: true,
    operationsHelp: true,
    scopedBinaryCompatibility: true,
  }) + "\n");
} finally {
  for (const archive of archives) rmSync(archive, { force: true });
  rmSync(work, { recursive: true, force: true });
}
