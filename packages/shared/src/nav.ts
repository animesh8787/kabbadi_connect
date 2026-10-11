import { haversineKm } from "./geo.js";

/** Turn-by-turn helpers shared by the Lambda (builds maneuvers) and the phone (tracks progress and speaks). */

export type LngLat = [number, number];
export type Turn = "left" | "right" | "slight-left" | "slight-right" | "sharp-left" | "sharp-right" | "uturn" | "straight";
export interface Maneuver {
  /** Index into the route line where the maneuver happens. */
  idx: number;
  kind: "depart" | "turn" | "arrive";
  turn: Turn;
  road?: string;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Left or right by how much the path bends at vertex i (positive = right). */
export function classifyTurn(line: LngLat[], i: number): Turn {
  const a = line[Math.max(0, i - 1)]!;
  const b = line[i]!;
  const c = line[Math.min(line.length - 1, i + 1)]!;
  if (a === b || b === c) return "straight";
  let d = bearing(b, c) - bearing(a, b);
  d = ((d + 540) % 360) - 180; // -180..180
  const m = Math.abs(d);
  const side = d > 0 ? "right" : "left";
  if (m < 20) return "straight";
  if (m < 60) return `slight-${side}` as Turn;
  if (m < 125) return side;
  if (m < 160) return `sharp-${side}` as Turn;
  return "uturn";
}

interface RawStep {
  Type?: string;
  GeometryOffset?: number;
  CurrentRoad?: { RoadName?: { Value?: string }[] };
  NextRoad?: { RoadName?: { Value?: string }[] };
}

/** Maneuvers from the routing API's steps, with turn direction measured from the geometry (no language dependency). */
export function maneuversOf(line: LngLat[], steps: RawStep[]): Maneuver[] {
  return steps
    .filter((s) => s.Type === "Turn" || s.Type === "Arrive" || s.Type === "Depart" || s.Type === "Continue" || s.Type === "Keep")
    .map((s) => {
      const idx = Math.min(s.GeometryOffset ?? 0, line.length - 1);
      const kind = s.Type === "Arrive" ? "arrive" : s.Type === "Depart" ? "depart" : "turn";
      return { idx, kind, turn: kind === "turn" ? classifyTurn(line, idx) : "straight", road: s.NextRoad?.RoadName?.[0]?.Value } as Maneuver;
    })
    .filter((m, i, all) => m.kind !== "turn" || m.turn !== "straight" || all[i + 1] === undefined);
}

const TURN_HI: Record<Turn, string> = {
  left: "बाएँ मुड़ें",
  right: "दाएँ मुड़ें",
  "slight-left": "हल्का बाएँ मुड़ें",
  "slight-right": "हल्का दाएँ मुड़ें",
  "sharp-left": "तेज़ बाएँ मुड़ें",
  "sharp-right": "तेज़ दाएँ मुड़ें",
  uturn: "यू-टर्न लें",
  straight: "सीधे चलते रहें",
};
const TURN_EN: Record<Turn, string> = {
  left: "turn left",
  right: "turn right",
  "slight-left": "bear left",
  "slight-right": "bear right",
  "sharp-left": "turn sharp left",
  "sharp-right": "turn sharp right",
  uturn: "make a U-turn",
  straight: "keep going straight",
};

/** Distance rounded the way people say it: 10 m steps under 50 m, 50 m steps under 1 km. */
export function sayDistance(m: number, lang: "hi" | "en" = "hi"): string {
  if (m >= 950) {
    const km = Math.round(m / 100) / 10;
    return lang === "hi" ? `${km} किलोमीटर` : `${km} kilometres`;
  }
  const r = m < 50 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
  return lang === "hi" ? `${r} मीटर` : `${r} metres`;
}

/** "150 मीटर बाद बाएँ मुड़ें", "आप पहुँच गए", "सीधे चलते रहें". */
export function instruction(m: Maneuver, distanceM: number, lang: "hi" | "en" = "hi", stopLabel?: string): string {
  if (m.kind === "arrive") {
    const where = stopLabel ? ` ${stopLabel}` : "";
    return distanceM > 30 ? (lang === "hi" ? `${sayDistance(distanceM)} बाद आप पहुँच जाएँगे${where}` : `you will arrive in ${sayDistance(distanceM, "en")}${where}`) : lang === "hi" ? `आप पहुँच गए${where}` : `you have arrived${where}`;
  }
  const what = (lang === "hi" ? TURN_HI : TURN_EN)[m.turn];
  if (distanceM <= 30) return what.charAt(0).toUpperCase() + what.slice(1);
  return lang === "hi" ? `${sayDistance(distanceM)} बाद ${what}` : `In ${sayDistance(distanceM, "en")}, ${what}`;
}

export interface Progress {
  /** The line segment (vertex seg to seg+1) the position is closest to. */
  seg: number;
  /** How far along that segment, 0..1. */
  t: number;
  /** Straight-line metres from the position to the line. */
  offRouteM: number;
}

const M_PER_DEG = 111_320;

/** Project a position onto the route (local flat-earth maths is exact enough over a few hundred metres). */
export function progressOn(line: LngLat[], pos: { lat: number; lng: number }): Progress {
  const kx = Math.cos(rad(pos.lat)) * M_PER_DEG;
  let best: Progress = { seg: 0, t: 0, offRouteM: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i]![0] - pos.lng) * kx;
    const ay = (line[i]![1] - pos.lat) * M_PER_DEG;
    const bx = (line[i + 1]![0] - pos.lng) * kx;
    const by = (line[i + 1]![1] - pos.lat) * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.offRouteM) best = { seg: i, t, offRouteM: d };
  }
  return best;
}

const segM = (line: LngLat[], i: number) => haversineKm({ lat: line[i]![1], lng: line[i]![0] }, { lat: line[i + 1]![1], lng: line[i + 1]![0] }) * 1000;

/** Metres along the line from vertex `from` to vertex `to`. */
export function alongM(line: LngLat[], from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(to, line.length - 1); i++) m += segM(line, i);
  return m;
}

/** The next maneuver ahead of the position and how far away it is along the route. */
export function nextManeuver(line: LngLat[], ms: Maneuver[], pos: { lat: number; lng: number }) {
  const p = progressOn(line, pos);
  const ahead = ms.find((m) => m.idx > p.seg);
  if (!ahead) return { maneuver: undefined, distanceM: 0, offRouteM: p.offRouteM };
  const rest = (1 - p.t) * segM(line, p.seg) + alongM(line, p.seg + 1, ahead.idx);
  return { maneuver: ahead, distanceM: Math.round(rest), offRouteM: p.offRouteM };
}
