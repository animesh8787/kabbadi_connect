import { GeoRoutesClient, OptimizeWaypointsCommand } from "@aws-sdk/client-geo-routes";
import { haversineKm } from "@kc/shared";

export interface Pt {
  lat: number;
  lng: number;
}
export interface Stop extends Pt {
  id: string;
}
export interface Routed {
  order: string[];
  source: "location" | "fallback";
  km: number;
  naiveKm: number;
}

/** Closed tour length: origin -> stops in order -> origin. */
export function tourKm(origin: Pt, stops: Pt[]): number {
  let km = 0;
  let prev = origin;
  for (const s of stops) {
    km += haversineKm(prev, s);
    prev = s;
  }
  return +(km + haversineKm(prev, origin)).toFixed(2);
}

/** Nearest-neighbour then 2-opt. shortcut: O(n^3) per pass, fine for <=20 stops. */
export function localOrder(origin: Pt, stops: Stop[]): Stop[] {
  const left = [...stops];
  let cur: Pt = origin;
  let tour: Stop[] = [];
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (haversineKm(cur, left[i]!) < haversineKm(cur, left[bi]!)) bi = i;
    const next = left.splice(bi, 1)[0]!;
    tour.push(next);
    cur = next;
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let j = i + 1; j < tour.length; j++) {
        const cand = [...tour.slice(0, i), ...tour.slice(i, j + 1).reverse(), ...tour.slice(j + 1)];
        if (tourKm(origin, cand) < tourKm(origin, tour) - 1e-9) {
          tour = cand;
          improved = true;
        }
      }
    }
  }
  return tour;
}

async function viaLocation(origin: Pt, stops: Stop[]): Promise<Stop[]> {
  const client = new GeoRoutesClient({ region: process.env.ROUTES_REGION || process.env.AWS_REGION });
  const res = await client.send(
    new OptimizeWaypointsCommand({
      Origin: [origin.lng, origin.lat],
      Destination: [origin.lng, origin.lat],
      TravelMode: "Pedestrian",
      Waypoints: stops.map((s) => ({ Id: s.id, Position: [s.lng, s.lat] })),
    }),
  );
  const byId = new Map(stops.map((s) => [s.id, s]));
  const ordered = (res.OptimizedWaypoints ?? []).map((w) => byId.get(w.Id ?? "")).filter((s): s is Stop => !!s);
  if (ordered.length !== stops.length) throw new Error("location service returned incomplete route");
  return ordered;
}

/** Order stops with Amazon Location; fall back to the local heuristic on any failure. */
export async function orderStops(origin: Pt, stops: Stop[]): Promise<Routed> {
  const naiveKm = tourKm(origin, stops);
  if (stops.length < 2) return { order: stops.map((s) => s.id), source: "fallback", km: naiveKm, naiveKm };
  let ordered: Stop[];
  let source: Routed["source"] = "location";
  try {
    if (process.env.USE_LOCATION === "false") throw new Error("disabled");
    ordered = await viaLocation(origin, stops);
  } catch (e) {
    const reason = (e as Error).message;
    if (reason !== "disabled") console.warn(JSON.stringify({ level: "warn", msg: "routing fallback", reason }));
    ordered = localOrder(origin, stops);
    source = "fallback";
  }
  return { order: ordered.map((s) => s.id), source, km: tourKm(origin, ordered), naiveKm };
}
