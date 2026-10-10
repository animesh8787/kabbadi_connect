import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CATEGORIES } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { route } from "../lib/http.js";
import { istDate } from "../lib/time.js";

/** Aggregated impact for the last N days (default 30), summed from daily counters. */
export const impact = route(null, async (c) => {
  const days = Math.min(Math.max(Number(c.event.queryStringParameters?.days ?? 30) || 30, 1), 365);
  const from = istDate(Date.now() - days * 24 * 3600 * 1000);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "PK = :p AND SK >= :d",
      ExpressionAttributeValues: { ":p": "IMPACT#ALL", ":d": from },
    }),
  );
  const rows = res.Items ?? [];
  const sum = (k: string) => +rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2);
  const dispatch = sum("routeKm");
  const naive = sum("naiveKm");
  return {
    days,
    pickups: sum("pickups"),
    kg: sum("kg"),
    co2Kg: sum("co2Kg"),
    payout: sum("payout"),
    batches: sum("batches"),
    routeKm: dispatch,
    naiveKm: naive,
    ackKg: sum("ackKg"),
    ackPickups: sum("ackPickups"),
    segTotal: sum("segTotal"),
    segGood: sum("segGood"),
    kmSavedPct: naive > 0 ? Math.round(((naive - dispatch) / naive) * 100) : 0,
    byCategory: Object.fromEntries(CATEGORIES.map((k) => [k, sum(`kg_${k}`)])),
    daily: rows.map((r) => ({ date: r.SK, kg: Number(r.kg) || 0, pickups: Number(r.pickups) || 0 })),
  };
});
