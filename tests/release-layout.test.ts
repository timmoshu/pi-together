import { describe, expect, it } from "vitest";
import { versionedReleasePath } from "../cli/release-layout.js";

describe("immutable release layout", () => {
  it("selects only a versioned destination and never an activation alias", () => {
    expect(versionedReleasePath("/opt/pi-together", "0.1.0")).toBe("/opt/pi-together/releases/0.1.0");
    expect(versionedReleasePath("/srv/pi-together", "0.2.0-rc.1")).toBe("/srv/pi-together/releases/0.2.0-rc.1");
  });

  it.each([
    ["relative", "0.1.0"],
    ["/opt/pi-together", "main"],
    ["/opt/pi-together", "../current"],
    ["/opt/pi-together", ""],
  ])("rejects prefix/version %s %s", (prefix, version) => {
    expect(() => versionedReleasePath(prefix, version)).toThrow();
  });
});
