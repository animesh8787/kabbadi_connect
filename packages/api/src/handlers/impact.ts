import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult } from "aws-lambda";
import { CATEGORIES } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { json, route } from "../lib/http.js";
import { istDate } from "../lib/time.js";

/** Aggregated impact for the last N days, summed from daily counters. */
export async function summarize(days: number) {
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
}

export const impact = route(null, async (c) => {
  const days = Math.min(Math.max(Number(c.event.queryStringParameters?.days ?? 30) || 30, 1), 365);
  return summarize(days);
});

/** Public landing-page counters: totals only (no per-day rows, no money), cached for a minute. */
export const publicImpact = async (): Promise<APIGatewayProxyResult> => {
  try {
    const d = await summarize(365);
    const res = json(200, { pickups: d.pickups, kg: d.kg, co2Kg: d.co2Kg, ackKg: d.ackKg, segTotal: d.segTotal, segGood: d.segGood, kmSavedPct: d.kmSavedPct });
    res.headers = { ...res.headers, "cache-control": "public, max-age=60" };
    return res;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "public impact failed", reason: (e as Error).message }));
    return json(500, { error: "internal error" });
  }
};
