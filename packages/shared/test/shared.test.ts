import { describe, expect, it } from "vitest";
import { co2Kg, CreateRequestSchema, geohash, haversineKm, payout } from "../src/index.js";

describe("shared", () => {
  it("geohash matches the reference value", () => {
    expect(geohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });
  it("haversine Delhi -> Gurugram is ~25km", () => {
    const d = haversineKm({ lat: 28.6139, lng: 77.209 }, { lat: 28.4595, lng: 77.0266 });
    expect(d).toBeGreaterThan(22);
    expect(d).toBeLessThan(28);
  });
  it("payout uses collector rates over defaults", () => {
    expect(payout([{ cat: "metal", kg: 2 }])).toBe(56);
    expect(payout([{ cat: "metal", kg: 2 }], { metal: 40 })).toBe(80);
  });
  it("co2 is a weighted sum", () => {
    expect(co2Kg([{ cat: "paper", kg: 10 }])).toBe(39.4);
  });
  it("rejects duplicate categories and bad coords", () => {
    const base = { lat: 28.6, lng: 77.2, address: "12 Main Rd", date: "2026-10-12", slot: "morning" };
    expect(CreateRequestSchema.safeParse({ ...base, items: [{ cat: "paper", bucket: "<2" }] }).success).toBe(true);
    expect(
      CreateRequestSchema.safeParse({ ...base, items: [{ cat: "paper", bucket: "<2" }, { cat: "paper", bucket: "2-5" }] }).success,
    ).toBe(false);
    expect(CreateRequestSchema.safeParse({ ...base, lat: 120, items: [{ cat: "paper", bucket: "<2" }] }).success).toBe(false);
  });
});
