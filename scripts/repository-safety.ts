import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MarkerRule {
  id: string;
  markerClass: string;
  needle: string;
  caseInsensitive?: boolean;
}

export interface SafetyFinding {
  ruleId: string;
  markerClass: string;
  path: string;
  line: number;
}

// Keep literals fragmented so the scanner does not report its own rule definitions.
export const PRIVATE_MARKER_RULES: readonly MarkerRule[] = [
  { id: "private-domain", markerClass: "private infrastructure domain", needle: ["pi", ["ve", "spyn"].join(""), "com"].join(".") },
  { id: "private-brand", markerClass: "private organization/project name", needle: ["ve", "spyn"].join(""), caseInsensitive: true },
  { id: "personal-home", markerClass: "personal home path", needle: ["", "home", "hoid"].join("/") },
  { id: "private-tailnet-ip", markerClass: "private Tailnet address", needle: ["100", "96", "253", "58"].join(".") },
  { id: "design-system", markerClass: "private design-system provenance", needle: ["glass", "box"].join(""), caseInsensitive: true },
  { id: "design-source-file", markerClass: "private design source file", needle: ["Paper", "file"].join(" — ") },
  { id: "design-source-id", markerClass: "private design source identifier", needle: ["Paper", "file ID"].join(" ") },
  { id: "design-font", markerClass: "private design-source font", needle: ["Paper", "Mono"].join(" ") },
  { id: "legacy-product", markerClass: "legacy private product name", needle: ["pi", "remote"].join("-"), caseInsensitive: true },
] as const;

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scanText(path: string, text: string, rules: readonly MarkerRule[] = PRIVATE_MARKER_RULES): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const rule of rules) {
    const haystack = rule.caseInsensitive ? text.toLowerCase() : text;
    const needle = rule.caseInsensitive ? rule.needle.toLowerCase() : rule.needle;
    let from = 0;
    while (needle && from <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      findings.push({ ruleId: rule.id, markerClass: rule.markerClass, path, line: lineNumberAt(text, index) });
      from = index + needle.length;
    }
  }
  return findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId),
  );
}

export function trackedFiles(repositoryRoot: string): string[] {
  // Include tracked files plus untracked export candidates so a new file cannot bypass the gate.
  const output = execFileSync("git", ["-C", repositoryRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean).sort();
}

function readTextFile(absolute: string, includeSymlinkTarget = true): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let contents: Buffer;
  if (stat.isSymbolicLink() && includeSymlinkTarget) contents = Buffer.from(readlinkSync(absolute), "utf8");
  else if (stat.isFile()) contents = readFileSync(absolute);
  else return null;
  if (contents.subarray(0, 8192).includes(0)) return null;
  return contents.toString("utf8");
}

function readTrackedText(repositoryRoot: string, trackedPath: string): string | null {
  return readTextFile(resolve(repositoryRoot, trackedPath));
}

export function scanTrackedRepository(
  repositoryRoot: string,
  rules: readonly MarkerRule[] = PRIVATE_MARKER_RULES,
): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const trackedPath of trackedFiles(repositoryRoot)) {
    const text = readTrackedText(repositoryRoot, trackedPath);
    if (text !== null) findings.push(...scanText(trackedPath, text, rules));
  }
  return findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId),
  );
}

export function scanFilesystemPaths(
  repositoryRoot: string,
  paths: readonly string[],
  rules: readonly MarkerRule[] = PRIVATE_MARKER_RULES,
): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const visit = (absolute: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(resolve(absolute, entry));
      return;
    }
    const text = readTextFile(absolute, false);
    if (text !== null) findings.push(...scanText(relative(repositoryRoot, absolute), text, rules));
  };
  for (const path of paths) visit(resolve(repositoryRoot, path));
  return findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId),
  );
}

export interface FindingSummary {
  ruleId: string;
  path: string;
  count: number;
}

export function summarizeFindings(findings: readonly SafetyFinding[]): FindingSummary[] {
  const counts = new Map<string, FindingSummary>();
  for (const finding of findings) {
    const key = `${finding.ruleId}\0${finding.path}`;
    const current = counts.get(key);
    if (current) current.count++;
    else counts.set(key, { ruleId: finding.ruleId, path: finding.path, count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.path.localeCompare(b.path));
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDir, "..");
  const requestedPaths = process.argv.slice(2);
  const findings = requestedPaths.length
    ? scanFilesystemPaths(repositoryRoot, requestedPaths)
    : scanTrackedRepository(repositoryRoot);
  for (const finding of findings) process.stdout.write(`${JSON.stringify(finding)}\n`);
  process.stdout.write(`${findings.length} private-marker finding(s) in repository text files.\n`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
