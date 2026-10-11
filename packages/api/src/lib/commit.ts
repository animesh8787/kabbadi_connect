import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { OpenReq } from "./batching.js";
import { ddb, NINETY_DAYS_S, TABLE } from "./ddb.js";
import { orderStops } from "./routing.js";
import { istDate } from "./time.js";

/**
 * Give a set of OPEN requests to one collector as a routed batch, atomically.
 * Each request moves OPEN -> ASSIGNED under a condition, so two callers (dispatcher, a claim, an admin)
 * can never assign the same request twice. Returns null when any request was taken or cancelled meanwhile.
 */
export async function commitBatch(
  col: { id: string; lat: number; lng: number },
  window: string,
  reqs: OpenReq[],
  now: number,
): Promise<{ batchId: string; estKg: number; km: number } | null> {
  const routed = await orderStops({ lat: col.lat, lng: col.lng }, reqs.map((r) => ({ id: r.id, lat: r.lat, lng: r.lng })));
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const batchId = randomUUID();
  const date = window.split("#")[0]!;
  const estKg = reqs.reduce((s, r) => s + r.estKg, 0);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE(),
              Item: {
                PK: `BATCH#${batchId}`,
                SK: "META",
                id: batchId,
                collectorId: col.id,
                window,
                status: "ASSIGNED",
                stops: routed.order,
                naiveOrder: reqs.map((r) => r.id), // the order requests came in, for the before/after comparison
                estKg,
                km: routed.km,
                naiveKm: routed.naiveKm,
                routeSource: routed.source,
                // Listed in GSI1 until the collector starts it, so a stale one can be found and re-offered.
                GSI1PK: "PENDING_BATCH",
                GSI1SK: `${byId.get(routed.order[0]!)!.windowStart}#${batchId}`,
                GSI2PK: `COL#${col.id}`,
                GSI2SK: `BATCH#${date}#${batchId}`,
                createdAt: now,
                ttl: Math.floor(now / 1000) + NINETY_DAYS_S,
              },
            },
          },
          ...routed.order.map((id) => ({
            Update: {
              TableName: TABLE(),
              Key: { PK: `REQ#${id}`, SK: "META" },
              UpdateExpression: "SET #s = :a, batchId = :b, collectorId = :c REMOVE GSI1PK, GSI1SK",
              ConditionExpression: "#s = :o",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":a": "ASSIGNED", ":b": batchId, ":c": col.id, ":o": "OPEN" },
            },
          })),
          {
            Update: {
              TableName: TABLE(),
              Key: { PK: "IMPACT#ALL", SK: istDate(now) },
              UpdateExpression: "ADD batches :one, routeKm :rk, naiveKm :nk",
              ExpressionAttributeValues: { ":one": 1, ":rk": routed.km, ":nk": routed.naiveKm },
            },
          },
        ],
      }),
    );
  } catch (e) {
    if (e instanceof TransactionCanceledException) return null;
    throw e;
  }
  return { batchId, estKg, km: routed.km };
}
