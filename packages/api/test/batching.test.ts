import { describe, expect, it } from "vitest";
import { planBatches, type Collector, type OpenReq } from "../src/lib/batching.js";
import { localOrder, orderStops, tourKm } from "../src/lib/routing.js";

const HOUR = 3600 * 1000;
const now = Date.parse("2026-10-10T06:00:00Z");
const mk = (i: number, kg: number, startIn: number): OpenReq => ({
  id: `r${i}`,
  gh5: "ttnfv",
  window: "2026-10-10#evening",
  windowStart: now + startIn,
  estKg: kg,
  lat: 28.6 + i * 0.002,
  lng: 77.2 + (i % 3) * 0.002,
});
const col = (id: string, areas = ["ttnfv"], active = true): Collector => ({ id, areas, active, lat: 28.6, lng: 77.2 });

describe("planBatches", () => {
  it("waits when light and the window is far away", () => {
    expect(planBatches([mk(1, 3.5, 5 * HOUR)], [col("c1")], now)).toEqual([]);
  });
  it("dispatches once total kg reaches the threshold", () => {
    const plans = planBatches([mk(1, 7.5, 5 * HOUR), mk(2, 7.5, 5 * HOUR)], [col("c1")], now);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.requestIds.sort()).toEqual(["r1", "r2"]);
  });
  it("dispatches a light group when its window is within an hour", () => {
    expect(planBatches([mk(1, 1, 0.5 * HOUR)], [col("c1")], now)).toHaveLength(1);
  });
  it("splits more than 20 stops across batches and spreads load over collectors", () => {
    const reqs = Array.from({ length: 45 }, (_, i) => mk(i, 7.5, 5 * HOUR));
    const plans = planBatches(reqs, [col("c1"), col("c2"), col("c3")], now);
    expect(plans.map((p) => p.requestIds.length).sort((a, b) => a - b)).toEqual([5, 20, 20]);
    expect(new Set(plans.map((p) => p.collectorId)).size).toBe(3);
  });
  it("skips groups with no active collector in the area", () => {
    expect(planBatches([mk(1, 20, 0)], [col("c1", ["other"]), col("c2", ["ttnfv"], false)], now)).toEqual([]);
  });
});

describe("routing", () => {
  const origin = { lat: 28.6, lng: 77.2 };
  const stops = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    lat: 28.6 + Math.sin(i * 7.3) * 0.02,
    lng: 77.2 + Math.cos(i * 4.1) * 0.02,
  }));
  it("local heuristic keeps every stop and is no worse than input order", () => {
    const out = localOrder(origin, stops);
    expect(out.map((s) => s.id).sort()).toEqual(stops.map((s) => s.id).sort());
    expect(tourKm(origin, out)).toBeLessThanOrEqual(tourKm(origin, stops));
  });
  it("orderStops falls back when Location is disabled", async () => {
    process.env.USE_LOCATION = "false";
    const r = await orderStops(origin, stops);
    expect(r.source).toBe("fallback");
    expect(r.km).toBeLessThanOrEqual(r.naiveKm);
  });
});
