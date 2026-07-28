import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_MARKER_RULES,
  scanFilesystemPaths,
  scanText,
  scanTrackedRepository,
  summarizeFindings,
  type MarkerRule,
} from "../scripts/repository-safety.js";

const repoRoot = process.cwd();

function initTempRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-together-safety-"));
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

describe("repository safety scanner", () => {
  it("reports only redacted rule/path/line metadata", () => {
    const marker = ["private", "example", "invalid"].join(".");
    const rules: MarkerRule[] = [{ id: "fixture-domain", markerClass: "synthetic domain", needle: marker }];
    const findings = scanText("docs/example.md", `safe line\nhttps://${marker}/path\n`, rules);

    expect(findings).toEqual([
      { ruleId: "fixture-domain", markerClass: "synthetic domain", path: "docs/example.md", line: 2 },
    ]);
    expect(JSON.stringify(findings)).not.toContain(marker);
  });

  it("uses narrow literals rather than generic secret, email, or home-directory matching", () => {
    const ordinaryPublicText = [
      "Document a secret-management strategy without including credentials.",
      "Contact maintainers@example.invalid.",
      "Use /home/example/project in generic Linux documentation.",
      "Read the project white paper before implementation.",
    ].join("\n");

    expect(scanText("docs/public.md", ordinaryPublicText)).toEqual([]);
  });

  it("scans tracked and untracked export candidates without following symlinks", () => {
    const root = initTempRepository();
    const marker = ["private", "tracked", "invalid"].join(".");
    const rules: MarkerRule[] = [{ id: "fixture", markerClass: "synthetic marker", needle: marker }];
    writeFileSync(join(root, "tracked.txt"), marker);
    writeFileSync(join(root, "untracked.txt"), marker);
    writeFileSync(join(root, "deleted.txt"), marker);
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
    writeFileSync(outside, marker);
    symlinkSync(outside, join(root, "link.txt"));
    execFileSync("git", ["-C", root, "add", "tracked.txt", "deleted.txt", "link.txt"]);
    unlinkSync(join(root, "deleted.txt"));

    expect(scanTrackedRepository(root, rules)).toEqual([
      { ruleId: "fixture", markerClass: "synthetic marker", path: "tracked.txt", line: 1 },
      { ruleId: "fixture", markerClass: "synthetic marker", path: "untracked.txt", line: 1 },
    ]);
  });

  it("scans generated artifact directories without following symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-together-artifacts-"));
    const marker = ["generated", "private", "invalid"].join(".");
    const rules: MarkerRule[] = [{ id: "artifact", markerClass: "synthetic artifact marker", needle: marker }];
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "bundle.js"), `const endpoint = "${marker}";`);

    expect(scanFilesystemPaths(root, ["dist"], rules)).toEqual([
      { ruleId: "artifact", markerClass: "synthetic artifact marker", path: "dist/bundle.js", line: 1 },
    ]);
  });

  it("keeps every configured marker rule executable", () => {
    for (const rule of PRIVATE_MARKER_RULES) {
      expect(scanText("fixture.txt", rule.needle, [rule])).toEqual([
        { ruleId: rule.id, markerClass: rule.markerClass, path: "fixture.txt", line: 1 },
      ]);
    }
  });

  it("keeps the public source tree free of known private markers", () => {
    expect(scanTrackedRepository(repoRoot)).toEqual([]);
  });

  it("produces a stable redacted summary without matched source text", () => {
    const summary = summarizeFindings([
      { ruleId: "b", markerClass: "class b", path: "z.md", line: 2 },
      { ruleId: "a", markerClass: "class a", path: "x.md", line: 3 },
      { ruleId: "a", markerClass: "class a", path: "x.md", line: 9 },
    ]);

    expect(summary).toEqual([
      { ruleId: "a", path: "x.md", count: 2 },
      { ruleId: "b", path: "z.md", count: 1 },
    ]);
  });
});
