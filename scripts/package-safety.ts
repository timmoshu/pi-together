import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { PRIVATE_MARKER_RULES, scanFilesystemPaths } from "./repository-safety.js";

interface PackResult {
  filename?: string;
}

const repositoryRoot = process.cwd();
const extractionRoot = mkdtempSync(join(tmpdir(), "pi-together-package-"));
let archivePath: string | null = null;

try {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = (JSON.parse(output) as PackResult[])[0];
  if (!result?.filename || basename(result.filename) !== result.filename || !result.filename.endsWith(".tgz")) {
    throw new Error("npm pack did not return a safe package filename");
  }
  archivePath = join(repositoryRoot, result.filename);
  execFileSync("tar", ["-xzf", archivePath, "-C", extractionRoot]);

  const packageRoot = join(extractionRoot, "package");
  const packedFiles: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else packedFiles.push(relative(packageRoot, path).replaceAll("\\", "/"));
    }
  };
  walk(packageRoot);
  const allowedFiles = new Set([
    "package.json", "README.md", "CHANGELOG.md", "LICENSE", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md",
    "dist/server/index.js", "dist/extension/pi-together-attribution-v1.js", "dist/extension/git-bin/git", "dist/cli/pi-together.js", "dist/privileged/apply.js",
    "dist/release/manifest.json", "dist/release/SHA256SUMS", "dist/release/LICENSE", "dist/release/third-party-licenses.json", "dist/release/NOTICE", "dist/release/sbom.cdx.json",
    "docs/architecture.md", "docs/deployment-security.md", "docs/licensing.md", "docs/operations.md", "docs/privacy.md", "docs/threat-model.md",
  ]);
  for (const required of ["dist/client/index.html", "dist/server/index.js", "dist/extension/pi-together-attribution-v1.js", "dist/extension/git-bin/git", "dist/cli/pi-together.js", "dist/privileged/apply.js", "dist/release/manifest.json"]) {
    if (!packedFiles.includes(required)) throw new Error(`packed package is missing ${required}`);
  }
  const unexpected = packedFiles.filter((path) => !allowedFiles.has(path) && !path.startsWith("dist/client/"));
  if (unexpected.length) throw new Error(`unexpected packed file(s): ${unexpected.join(", ")}`);
  if (packedFiles.some((path) => path.endsWith(".map") || path.endsWith(".ts") || path.endsWith(".tsx"))) {
    throw new Error("source or source-map file escaped the package allowlist");
  }

  const findings = scanFilesystemPaths(extractionRoot, ["package"], PRIVATE_MARKER_RULES);
  for (const finding of findings) process.stdout.write(`${JSON.stringify(finding)}\n`);
  process.stdout.write(`${findings.length} private-marker finding(s) in packed package text files.\n`);
  if (findings.length) process.exitCode = 1;
} finally {
  if (archivePath) rmSync(archivePath, { force: true });
  rmSync(extractionRoot, { recursive: true, force: true });
}
