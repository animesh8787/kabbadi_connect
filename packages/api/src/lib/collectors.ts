import { haversineKm } from "@kc/shared";
import type { Collector } from "./batching.js";
import { queryAll, TABLE } from "./ddb.js";

type Item = Record<string, any>;
export const DEFAULT_RADIUS_KM = 8;

/**
 * Every real, active collector. Demo collectors are excluded so judge demos never take real requests.
 * shortcut: reads the whole list each time; fine to a few hundred collectors, then index by map cell.
 */
export async function activeCollectors(): Promise<Item[]> {
  const rows = await queryAll({
    TableName: TABLE(),
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :p",
    ExpressionAttributeValues: { ":p": "COLLECTORS" },
  });
  return rows.filter((c) => c.active !== false && !c.demo);
}

export const toCollector = (c: Item): Collector => ({
  id: c.id,
  areas: c.areas ?? [],
  active: c.active !== false,
  lat: c.lat,
  lng: c.lng,
  radiusKm: c.serviceRadiusKm ?? DEFAULT_RADIUS_KM,
});

/** A collector serves a point when it is inside their radius or in one of their listed map cells. */
export function covers(c: Collector, p: { lat: number; lng: number; gh5?: string }): boolean {
  return (!!p.gh5 && c.areas.includes(p.gh5)) || haversineKm(c, p) <= (c.radiusKm ?? DEFAULT_RADIUS_KM);
}
