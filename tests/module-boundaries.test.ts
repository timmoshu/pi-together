import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const lines = (path: string) => read(path).split("\n").length;

function productionTypeScript(directory: string): string[] {
  const output: string[] = [];
  const visit = (path: string) => {
    for (const name of readdirSync(join(root, path))) {
      const child = join(path, name);
      const info = statSync(join(root, child));
      if (info.isDirectory()) visit(child);
      else if (/\.tsx?$/.test(name)) output.push(relative(root, join(root, child)));
    }
  };
  visit(directory);
  return output;
}

describe("module boundaries", () => {
  it("keeps composition modules bounded while allowing cohesive boundary adapters", () => {
    expect(lines("client/src/App.tsx")).toBeLessThanOrEqual(200);
    expect(lines("client/src/store.ts")).toBeLessThanOrEqual(450);
    expect(lines("server/app.ts")).toBeLessThanOrEqual(450);
    for (const path of productionTypeScript("client/src/ui")) expect(lines(path), path).toBeLessThanOrEqual(500);
    for (const directory of ["cli", "client/src", "deployment", "extension", "pi-adapter", "privileged", "server", "shared"]) {
      for (const path of productionTypeScript(directory)) expect(lines(path), path).toBeLessThanOrEqual(800);
    }
  });

  it("keeps pure client transitions outside React/network orchestration", () => {
    const transitions = read("client/src/store-events.ts");
    expect(transitions).not.toContain('from "react"');
    expect(transitions).not.toContain('from "./api"');
    expect(read("client/src/App.tsx")).not.toContain('from "./api"');
  });

  it("uses one privileged process runner for all lifecycle commands", () => {
    for (const path of ["cli/apply.ts", "cli/upgrade.ts", "cli/uninstall.ts", "cli/users.ts"]) {
      const source = read(path);
      expect(source, path).toContain("privileged-runner.js");
      expect(source, path).not.toContain('from "node:child_process"');
    }
  });

  it("keeps transport and lease coordination outside the API router", () => {
    const app = read("server/app.ts");
    expect(app).toContain("http-surface.js");
    expect(app).toContain("collaboration-leases.js");
    expect(app).not.toContain('from "node:fs"');
    expect(app).not.toContain("setInterval(");
  });
});
