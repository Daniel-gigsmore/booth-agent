import { describe, it, expect } from "vitest";
import { textVariables, fillVariables } from "../src/compositor/variables";

describe("text variables", () => {
  const now = new Date(2026, 8, 4, 9, 5); // local time, 4 Sep 2026 09:05
  const vars = textVariables("Gigsmore Launch", "e2e116bb-2acc-4c7f-b260-c73801a2449b", now);

  it("formats each variable", () => {
    expect(vars).toEqual({ event: "Gigsmore Launch", date: "4 Sep 2026", time: "09:05", code: "e2e116bb" });
  });

  it("fills known variables and leaves anything else as typed", () => {
    expect(fillVariables("{event} · {date} {time} #{code} {nope} {", vars)).toBe(
      "Gigsmore Launch · 4 Sep 2026 09:05 #e2e116bb {nope} {"
    );
  });
});
