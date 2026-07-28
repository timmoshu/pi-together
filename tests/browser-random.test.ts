import { describe, expect, it, vi } from "vitest";
import { createViewerId } from "../client/src/browser-random.js";

describe("browser viewer ID generation", () => {
  it("uses crypto.randomUUID when the browser provides it", () => {
    const randomUUID = vi.fn(() => "12345678-1234-4234-9234-123456789abc");
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes);

    expect(createViewerId({ randomUUID, getRandomValues })).toBe("v_12345678-1234-4234-9234-123456789abc");
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("falls back to getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });

    expect(createViewerId({ getRandomValues })).toBe("v_00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
