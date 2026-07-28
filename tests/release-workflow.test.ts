import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release-bundle.yml", import.meta.url), "utf8");

describe("public release workflow", () => {
  it("publishes only an exact stable tag through signed, provenance-bound artifacts", () => {
    expect(workflow).toContain('      - "v[0-9]+.[0-9]+.[0-9]+"');
    expect(workflow).toContain("environment: release");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("secrets.PI_TOGETHER_RELEASE_KEY");
    expect(workflow).toContain("npm@11.6.2");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft --verify-tag");
    expect(workflow).toContain('archive="./release-bundle/pi-together-$version.tgz"');
    expect(workflow).toContain('npm publish "$archive" --provenance --access public');
    expect(workflow).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false');
  });
});
