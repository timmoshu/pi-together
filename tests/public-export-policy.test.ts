import { describe, expect, it } from "vitest";
import { classifyExportPaths, isPublicExportPath, REQUIRED_PUBLIC_PATHS } from "../scripts/public-export-policy.js";

describe("public export policy", () => {
  it("allows only explicit source roots and root files", () => {
    expect(isPublicExportPath("server/app.ts")).toBe(true);
    expect(isPublicExportPath("README.md")).toBe(true);
    expect(isPublicExportPath("planning-artifacts/pi-together-prd.md")).toBe(false);
    expect(isPublicExportPath("private-rc/metadata.json")).toBe(false);
    expect(isPublicExportPath("server/private.env")).toBe(false);
    expect(isPublicExportPath("server/credential")).toBe(false);
    expect(isPublicExportPath("../README.md")).toBe(false);
    expect(isPublicExportPath("server\\app.ts")).toBe(false);
  });

  it("distinguishes intentional planning exclusions from unexpected paths", () => {
    const paths = [
      ...REQUIRED_PUBLIC_PATHS,
      "server/app.ts",
      "planning-artifacts/backlog.md",
      "CLAUDE.md",
      "private-rc/metadata.json",
    ];
    const result = classifyExportPaths(paths);
    expect(result.missingRequired).toEqual([]);
    expect(result.intentionallyExcluded).toEqual(["CLAUDE.md", "planning-artifacts/backlog.md"]);
    expect(result.unexpected).toEqual(["private-rc/metadata.json"]);
  });
});
