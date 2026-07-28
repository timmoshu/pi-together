import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  engines?: { node?: string };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, PackageManifest>;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as PackageLock;

function versionOf(range: string | undefined): [number, number] {
  const match = range?.match(/(\d+)\.(\d+)/);
  if (!match) throw new Error(`dependency range has no version: ${range}`);
  return [Number(match[1]), Number(match[2])];
}

function isAtLeast(range: string | undefined, expectedMajor: number, expectedMinor = 0): boolean {
  const [major, minor] = versionOf(range);
  return major > expectedMajor || (major === expectedMajor && minor >= expectedMinor);
}

describe("supported toolchain contract", () => {
  it("matches Pi's minimum supported Node runtime in manifest and lockfile", () => {
    expect(manifest.engines?.node).toBe(">=22.19.0");
    expect(lock.packages?.[""]?.engines?.node).toBe(manifest.engines?.node);

    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(major! > 22 || (major === 22 && minor! >= 19)).toBe(true);
  });

  it("keeps the modernized build/test majors and a high-severity audit gate", () => {
    expect(isAtLeast(manifest.devDependencies?.vite, 8)).toBe(true);
    expect(isAtLeast(manifest.devDependencies?.vitest, 4)).toBe(true);
    expect(isAtLeast(manifest.devDependencies?.esbuild, 0, 28)).toBe(true);
    expect(manifest.scripts?.["audit:ci"]).toContain("--include=dev --audit-level=high");
    expect(manifest.scripts?.["audit:ci"]).toContain("--omit=dev --audit-level=high");
  });
});
