import { describe, expect, it } from "vitest";
import { parsePiVersion, PI_COMPATIBILITY, supportsPiVersion } from "../cli/pi-version.js";

describe("packaged Pi compatibility boundary", () => {
  it("matches the release range and accepts the tested 0.82 and 0.83 lines", () => {
    expect(PI_COMPATIBILITY).toBe(">=0.82.0 <0.84.0");
    expect(supportsPiVersion("0.82.0\n")).toBe(true);
    expect(supportsPiVersion("0.82.99")).toBe(true);
    expect(supportsPiVersion("0.83.0")).toBe(true);
    expect(supportsPiVersion("0.83.99")).toBe(true);
    expect(parsePiVersion("0.83.0")).toEqual({ major: 0, minor: 83, patch: 0 });
  });

  it.each(["0.81.9", "0.84.0", "1.0.0", "v0.83.0", "unknown", "", "0.83"])(
    "rejects unsupported or ambiguous output %j",
    (version) => expect(supportsPiVersion(version)).toBe(false),
  );
});
