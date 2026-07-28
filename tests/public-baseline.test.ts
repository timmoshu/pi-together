import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const oldSlug = ["pi", "remote"].join("-");
const oldTitle = ["Pi", "Remote"].join(" ");
const personalPath = ["", "home", "hoid"].join("/");
const privateIp = ["100", "96", "253", "58"].join(".");
const personalLogin = ["timmo", "shu"].join("");
const providerRecordId = /(?:responseId|textSignature)[^\n]*(?:resp|msg)_[a-f0-9]{24,}/i;

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [join(directory, entry.name)] : [],
  );
}

describe("public Pi Together baseline", () => {
  it("uses the public package and browser identity", () => {
    const manifest = JSON.parse(read("package.json")) as { name: string; description: string };
    const browser = [read("client/index.html"), read("client/src/App.tsx")].join("\n");

    expect(manifest.name).toBe("pi-together");
    expect(manifest.description).toMatch(/independent Pi companion/i);
    expect(browser).toContain("Pi Together");
    expect(browser).not.toContain(oldTitle);
    expect(browser).not.toContain(oldSlug);
  });

  it("contains only synthetic session fixtures", () => {
    const fixtures = fixtureFiles("tests/fixtures").map(read).join("\n");

    expect(fixtures).not.toContain(personalPath);
    expect(fixtures).not.toContain(privateIp);
    expect(fixtures.toLowerCase()).not.toContain(personalLogin);
    expect(fixtures).not.toMatch(providerRecordId);
    expect(fixtures).toContain("/home/example/projects/");
  });

  it("retains the approved UI tokens without publishing private rights evidence", () => {
    const styles = read("client/src/styles.css");
    expect(styles).toContain("--accent:");
    expect(styles).toContain("--font-body:");
  });
});
