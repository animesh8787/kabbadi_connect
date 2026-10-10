import { describe, expect, it } from "vitest";
import { yesNo } from "../src/voice";

describe("yesNo", () => {
  it("hears Hindi and Hinglish yes", () => {
    for (const s of ["हाँ", "हां जी", "जी", "सही है", "haan", "Ji, theek hai", "yes", "ok"]) expect(yesNo(s)).toBe("yes");
  });
  it("hears no", () => {
    for (const s of ["नहीं", "नहीं नहीं", "galat hai", "nahi", "ना"]) expect(yesNo(s)).toBe("no");
  });
  it("lets no win when both are said, and ignores other speech", () => {
    expect(yesNo("हाँ नहीं")).toBe("no");
    expect(yesNo("haan nahi nahi")).toBe("no");
    expect(yesNo("agla ghar kahan hai")).toBeNull();
    expect(yesNo("")).toBeNull();
  });
});
