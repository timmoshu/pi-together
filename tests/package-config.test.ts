import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PI_COMPATIBILITY } from "../cli/pi-version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  private: boolean;
  license: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  piCompatibility: string;
  repository: { url: string };
  bugs: { url: string };
  homepage: string;
  os: string[];
  cpu: string[];
};
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { license?: string }>;
};

describe("prebuilt package configuration", () => {
  it("ships only runtime artifacts behind the stable binary while publication remains private", () => {
    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("MIT");
    expect(lock.packages[""]?.license).toBe("MIT");
    expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toContain("Copyright (c) 2026 Tim Xu");
    expect(pkg.bin).toEqual({ "pi-together": "dist/cli/pi-together.js" });
    expect(pkg.files).toContain("dist/server/index.js");
    expect(pkg.files).toContain("dist/extension");
    expect(pkg.files.some((path) => /^(client|server|cli|tests|planning-artifacts)\//.test(path))).toBe(false);
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.repository.url).toBe("git+https://github.com/timmoshu/pi-together.git");
    expect(pkg.bugs.url).toBe("https://github.com/timmoshu/pi-together/issues");
    expect(pkg.homepage).toBe("https://github.com/timmoshu/pi-together#readme");
    expect(pkg.os).toEqual(["linux"]);
    expect(pkg.cpu).toEqual(["x64"]);
  });

  it("keeps compilers and browser build dependencies out of consumer runtime dependencies", () => {
    expect(Object.keys(pkg.dependencies)).toEqual([
      "@inquirer/checkbox",
      "@inquirer/confirm",
      "@inquirer/input",
      "@inquirer/password",
      "@inquirer/select",
      "zod",
    ]);
    expect(pkg.devDependencies).toHaveProperty("typescript");
    expect(pkg.devDependencies).toHaveProperty("vite");
    expect(pkg.devDependencies).toHaveProperty("esbuild");
    expect(pkg.piCompatibility).toBe(PI_COMPATIBILITY);
  });
});
