const PUBLIC_DIRECTORIES = [
  ".github/",
  "cli/",
  "client/",
  "deployment/",
  "docs/",
  "extension/",
  "pi-adapter/",
  "privileged/",
  "scripts/",
  "server/",
  "shared/",
  "tests/",
] as const;

const PUBLIC_EXTENSIONS = new Set([".css", ".html", ".ico", ".json", ".jsonl", ".md", ".mjs", ".png", ".snap", ".ts", ".tsx", ".yml"]);

const PUBLIC_ROOT_FILES = new Set([
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "package-lock.json",
  "package.json",
  "playwright.config.ts",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts",
  "vitest.config.ts",
]);

export const REQUIRED_PUBLIC_PATHS = [
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/architecture.md",
  "docs/deployment-security.md",
  "docs/licensing.md",
  "docs/operations.md",
  "docs/privacy.md",
  "docs/threat-model.md",
  "package-lock.json",
  "package.json",
] as const;

export function isPublicExportPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) return false;
  if (PUBLIC_ROOT_FILES.has(path)) return true;
  if (!PUBLIC_DIRECTORIES.some((directory) => path.startsWith(directory))) return false;
  const name = path.split("/").at(-1) ?? "";
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0 && PUBLIC_EXTENSIONS.has(name.slice(extensionIndex));
}

export function classifyExportPaths(paths: readonly string[]): {
  included: string[];
  intentionallyExcluded: string[];
  unexpected: string[];
  missingRequired: string[];
} {
  const unique = [...new Set(paths)].sort();
  const included = unique.filter(isPublicExportPath);
  const intentionallyExcluded = unique.filter((path) => path.startsWith("planning-artifacts/") || path === "CLAUDE.md");
  const unexpected = unique.filter((path) => !isPublicExportPath(path) && !path.startsWith("planning-artifacts/") && path !== "CLAUDE.md");
  const includedSet = new Set(included);
  const missingRequired = REQUIRED_PUBLIC_PATHS.filter((path) => !includedSet.has(path));
  return { included, intentionallyExcluded, unexpected, missingRequired };
}
