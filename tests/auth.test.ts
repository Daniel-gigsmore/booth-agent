import { describe, expect, it } from "vitest";
import { isValidSecret } from "../src/server/auth";

describe("isValidSecret", () => {
  it("accepts the exact secret", () => {
    expect(isValidSecret("correct-horse-battery-staple", "correct-horse-battery-staple")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(isValidSecret("correct-horse-battery-staple", "wrong---horse-battery-staple")).toBe(false);
  });

  it("rejects a shorter or longer provided value without throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths - this must be
    // guarded before it's called, not just handled by an uncaught exception.
    expect(isValidSecret("correct-horse-battery-staple", "short")).toBe(false);
    expect(isValidSecret("correct-horse-battery-staple", "correct-horse-battery-staple-and-then-some")).toBe(
      false
    );
  });

  it("rejects an undefined provided value (no header or query token supplied)", () => {
    expect(isValidSecret("correct-horse-battery-staple", undefined)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidSecret("correct-horse-battery-staple", "")).toBe(false);
  });
});
