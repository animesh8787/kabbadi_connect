import { BATCH_MAX_STOPS, BATCH_MIN_KG, haversineKm } from "@kc/shared";
import type { Pt } from "./routing.js";

export interface OpenReq extends Pt {
  id: string;
  gh5: string;
  window: string; // "<date>#<slot>"
  windowStart: number; // epoch ms
  estKg: number;
}
export interface Collector extends Pt {
  id: string;
  areas: string[];
  active: boolean;
}
export interface Plan {
  collectorId: string;
  gh5: string;
  window: string;
  requestIds: string[];
}

const DISPATCH_LEAD_MS = 60 * 60 * 1000;

/**
 * Group open requests by cell+window; dispatch a group when it is heavy enough or its window is
 * about to start; split into batches of <= BATCH_MAX_STOPS; give each to the least-loaded nearby collector.
 */
export function planBatches(reqs: OpenReq[], collectors: Collector[], now: number): Plan[] {
  const groups = new Map<string, OpenReq[]>();
  for (const r of reqs) {
    const k = `${r.gh5}|${r.window}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const load = new Map<string, number>(); // collectorId|window -> batches assigned this run
  const plans: Plan[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const kg = g.reduce((s, r) => s + r.estKg, 0);
    if (kg < BATCH_MIN_KG && first.windowStart - now > DISPATCH_LEAD_MS) continue;
    const centre = { lat: g.reduce((s, r) => s + r.lat, 0) / g.length, lng: g.reduce((s, r) => s + r.lng, 0) / g.length };
    const eligible = collectors.filter((c) => c.active && c.areas.includes(first.gh5));
    if (!eligible.length) continue;
    // Distance-from-centre order keeps each chunk geographically compact.
    const sorted = [...g].sort((a, b) => haversineKm(centre, a) - haversineKm(centre, b));
    for (let i = 0; i < sorted.length; i += BATCH_MAX_STOPS) {
      const chunk = sorted.slice(i, i + BATCH_MAX_STOPS);
      const key = (c: Collector) => `${c.id}|${first.window}`;
      const best = eligible
        .map((c) => ({ c, score: (load.get(key(c)) ?? 0) * 100 + haversineKm(c, centre) }))
        .sort((a, b) => a.score - b.score)[0]!.c;
      load.set(key(best), (load.get(key(best)) ?? 0) + 1);
      plans.push({ collectorId: best.id, gh5: first.gh5, window: first.window, requestIds: chunk.map((r) => r.id) });
    }
  }
  return plans;
}
