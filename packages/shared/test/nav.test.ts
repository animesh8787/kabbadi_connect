import { describe, expect, it } from "vitest";
import { alongM, bucketOf, classifyTurn, instruction, maneuversOf, nextManeuver, progressOn, RescheduleSchema, sayDistance, slotLabel, CreateRequestSchema, type LngLat } from "../src/index.js";

// An L-shaped walk: north for ~220 m, then east for ~220 m.
const NORTH: LngLat[] = [[77.1, 28.7], [77.1, 28.701], [77.1, 28.702]];
const L: LngLat[] = [...NORTH, [77.1022, 28.702], [77.1044, 28.702]];

describe("turn classification", () => {
  it("knows left, right, straight and U-turn from the geometry", () => {
    expect(classifyTurn(L, 2)).toBe("right"); // north then east
    const west: LngLat[] = [[77.1, 28.7], [77.1, 28.701], [77.098, 28.701]];
    expect(classifyTurn(west, 1)).toBe("left");
    expect(classifyTurn(NORTH, 1)).toBe("straight");
    const back: LngLat[] = [[77.1, 28.7], [77.1, 28.701], [77.1, 28.7001]];
    expect(classifyTurn(back, 1)).toBe("uturn");
  });
});

describe("maneuvers and instructions", () => {
  const steps = [{ Type: "Depart", GeometryOffset: 0 }, { Type: "Turn", GeometryOffset: 2 }, { Type: "Arrive", GeometryOffset: 4 }];
  const ms = maneuversOf(L, steps);

  it("keeps the real turn and the arrival, with turn direction from the line", () => {
    expect(ms.map((m) => [m.kind, m.turn])).toEqual([["depart", "straight"], ["turn", "right"], ["arrive", "straight"]]);
  });
  it("says distances the way people do", () => {
    expect(sayDistance(148)).toBe("150 मीटर");
    expect(sayDistance(20)).toBe("20 मीटर");
    expect(sayDistance(1240)).toBe("1.2 किलोमीटर");
    expect(sayDistance(148, "en")).toBe("150 metres");
  });
  it("builds Hindi and English instructions, and flips to the bare action when close", () => {
    expect(instruction(ms[1]!, 150)).toBe("150 मीटर बाद दाएँ मुड़ें");
    expect(instruction(ms[1]!, 10)).toBe("दाएँ मुड़ें");
    expect(instruction(ms[1]!, 150, "en")).toBe("In 150 metres, turn right");
    expect(instruction(ms[2]!, 10)).toBe("आप पहुँच गए");
    expect(instruction(ms[2]!, 120, "hi", "स्टॉप 2")).toContain("पहुँच जाएँगे स्टॉप 2");
  });
  it("tracks the next maneuver from the position along the line", () => {
    const start = nextManeuver(L, ms, { lat: 28.7, lng: 77.1 });
    expect(start.maneuver?.kind).toBe("turn");
    expect(start.distanceM).toBeGreaterThan(200);
    expect(start.distanceM).toBeLessThan(240);
    const afterTurn = nextManeuver(L, ms, { lat: 28.702, lng: 77.1030 });
    expect(afterTurn.maneuver?.kind).toBe("arrive");
    expect(afterTurn.distanceM).toBeLessThan(150);
    expect(afterTurn.distanceM).toBeGreaterThan(100);
  });
  it("measures how far off the route a position is", () => {
    expect(progressOn(L, { lat: 28.7, lng: 77.1 }).offRouteM).toBeLessThan(1);
    expect(progressOn(L, { lat: 28.7005, lng: 77.103 }).offRouteM).toBeGreaterThan(50);
    expect(alongM(L, 0, 2)).toBeGreaterThan(200);
  });
});

describe("scheduling helpers", () => {
  it("labels two-hour slots and keeps the old wide ones", () => {
    expect(slotLabel("s1416")).toBe("2pm–4pm");
    expect(slotLabel("s0810")).toBe("8am–10am");
    expect(slotLabel("morning")).toBe("8am–12pm");
  });
  it("accepts the new slots and a note, rejects unknown slots and long notes", () => {
    const base = { items: [{ cat: "paper", bucket: "2-5" }], lat: 28.6, lng: 77.2, address: "12 Main Rd", date: "2026-10-12" };
    expect(CreateRequestSchema.safeParse({ ...base, slot: "s1416", notes: "ring the bell" }).success).toBe(true);
    expect(CreateRequestSchema.safeParse({ ...base, slot: "s0000" }).success).toBe(false);
    expect(CreateRequestSchema.safeParse({ ...base, slot: "s1416", notes: "x".repeat(141) }).success).toBe(false);
    expect(RescheduleSchema.safeParse({ date: "2026-10-12", slot: "s1012" }).success).toBe(true);
  });
  it("maps spoken kilos to weight buckets", () => {
    expect([1, 2, 4.9, 5, 9, 10, 40].map(bucketOf)).toEqual(["<2", "2-5", "2-5", "5-10", "5-10", "10+", "10+"]);
  });
});
