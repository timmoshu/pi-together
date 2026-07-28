import { describe, expect, it } from "vitest";
import { resolvePrivilegedPath } from "../privileged/root-path.js";

describe("privileged root path resolution", () => {
  it("treats canonical absolute paths as contained beneath both slash and fixture roots", () => {
    expect(resolvePrivilegedPath("/", "/etc/pi-together/config.json", "apply"))
      .toBe("/etc/pi-together/config.json");
    expect(resolvePrivilegedPath("/tmp/synthetic-root", "/etc/pi-together/config.json", "apply"))
      .toBe("/tmp/synthetic-root/etc/pi-together/config.json");
  });

  it("rejects relative, traversal, and NUL-bearing paths", () => {
    expect(() => resolvePrivilegedPath("/", "etc/pi-together", "apply")).toThrow(/absolute/);
    expect(() => resolvePrivilegedPath("/", "/../etc/pi-together", "apply")).toThrow(/escapes root/);
    expect(() => resolvePrivilegedPath("/tmp/synthetic-root", "/../../etc/passwd", "apply")).toThrow(/escapes root/);
    expect(() => resolvePrivilegedPath("/", "/etc/pi-together\0other", "apply")).toThrow(/absolute/);
  });
});
