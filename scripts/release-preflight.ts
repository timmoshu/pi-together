import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyExportPaths } from "./public-export-policy.js";

interface EvidenceManifest {
  approvals?: Record<string, boolean>;
  decisions?: { licenseDirection?: "Apache-2.0" | "MIT" };
  explicitSkips?: Array<{ lane?: string }>;
  lanes?: Record<string, boolean>;
}
interface PackageManifest { private?: boolean; license?: string }
interface PreflightBlocker { code: string; summary: string }

const REQUIRED_APPROVALS = [
  "rightsholder-release-authority",
  "project-license-and-copyright",
  "retained-visual-provenance",
  "security-and-supported-versions",
  "npm-name-strategy",
  "contribution-licensing",
  "independent-non-affiliation-language",
] as const;

const root = process.cwd();
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter((path) => path && existsSync(resolve(root, path)));
const classification = classifyExportPaths(paths);
const blockers: PreflightBlocker[] = [];

if (classification.unexpected.length) blockers.push({
  code: "PTP-001",
  summary: `${classification.unexpected.length} working-tree path(s) are outside the public export policy`,
});
if (classification.missingRequired.length) blockers.push({
  code: "PTP-002",
  summary: `${classification.missingRequired.length} required public path(s) are missing`,
});
const symlinks = classification.included.filter((path) => lstatSync(resolve(root, path)).isSymbolicLink());
if (symlinks.length) blockers.push({ code: "PTP-003", summary: `${symlinks.length} public export path(s) are symlinks` });

const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageManifest;
if (packageManifest.private !== false) blockers.push({ code: "PTP-101", summary: "package.json remains private" });
if (!packageManifest.license || !["Apache-2.0", "MIT"].includes(packageManifest.license)) {
  blockers.push({ code: "PTP-102", summary: "approved Apache-2.0 or MIT SPDX license is not configured" });
}
if (!paths.includes("LICENSE")) blockers.push({ code: "PTP-103", summary: "approved LICENSE file is not present" });

const evidencePath = process.env.PI_TOGETHER_RELEASE_EVIDENCE
  ?? resolve(root, "planning-artifacts/s21-release-gates.json");
let evidence: EvidenceManifest = {};
try {
  evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as EvidenceManifest;
} catch {
  blockers.push({ code: "PTP-004", summary: "release-gate evidence was not supplied" });
}
if (packageManifest.license && packageManifest.license !== evidence.decisions?.licenseDirection) {
  blockers.push({ code: "PTP-104", summary: "package SPDX license does not match the approved license direction" });
}
for (const approval of REQUIRED_APPROVALS) {
  if (evidence.approvals?.[approval] !== true) {
    blockers.push({ code: "PTP-200", summary: `mandatory approval remains open: ${approval}` });
  }
}
if (evidence.lanes?.["tailscale-funnel-real-tailnet"] !== true) {
  blockers.push({ code: "PTP-202", summary: "protected real-tailnet Funnel/GitHub OAuth lane has not passed" });
}
for (const skip of evidence.explicitSkips ?? []) {
  blockers.push({ code: "PTP-201", summary: `release evidence lane remains skipped: ${skip.lane ?? "unknown"}` });
}
const status = git("status", "--porcelain=v1").trim();
if (status) blockers.push({ code: "PTP-301", summary: "source worktree is not clean" });

const report = {
  schemaVersion: 1,
  ready: blockers.length === 0,
  sourceCommit: git("rev-parse", "HEAD").trim(),
  export: {
    includedPaths: classification.included.length,
    intentionallyExcludedPaths: classification.intentionallyExcluded.length,
    unexpectedPaths: classification.unexpected,
    missingRequiredPaths: classification.missingRequired,
    symlinks,
  },
  blockers,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.argv.includes("--require-ready") && blockers.length) process.exitCode = 1;
