import { randomUUID } from "node:crypto";
import { BatchGetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { NINETY_DAYS_S, TABLE, ddb } from "../lib/ddb.js";
import { planBatches, type Collector, type OpenReq } from "../lib/batching.js";
import { notifyCollector } from "../lib/notify.js";
import { orderStops } from "../lib/routing.js";
import { istDate } from "../lib/time.js";

type Item = Record<string, any>;

async function queryAll(params: ConstructorParameters<typeof QueryCommand>[0]): Promise<Item[]> {
  const out: Item[] = [];
  let key: Record<string, any> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: key }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

/**
 * Sweep all OPEN requests, plan batches, route each and commit atomically.
 * Safe to run concurrently or repeatedly: request moves OPEN -> ASSIGNED under a condition.
 * Triggered by SQS (new request) and by a 5-minute schedule (windows approaching, lost messages).
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * A batch nobody started two hours after its window opened is released: its requests go back to OPEN
 * and remember who sat on them, so the next plan picks another collector.
 */
export async function releaseStale(now: number): Promise<number> {
  const stale = await queryAll({
    TableName: TABLE(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p AND GSI1SK < :t",
    ExpressionAttributeValues: { ":p": "PENDING_BATCH", ":t": `${now - STALE_AFTER_MS}~` },
  });
  let released = 0;
  for (const b of stale) {
    const got = await ddb.send(
      new BatchGetCommand({ RequestItems: { [TABLE()]: { Keys: (b.stops as string[]).map((id) => ({ PK: `REQ#${id}`, SK: "META" })) } } }),
    );
    const live = (got.Responses?.[TABLE()] ?? []).filter((r) => r.status === "ASSIGNED" && r.collectorId === b.collectorId);
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE(),
                Key: { PK: `BATCH#${b.id}`, SK: "META" },
                UpdateExpression: "SET #s = :x REMOVE GSI1PK, GSI1SK",
                ConditionExpression: "#s = :a",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":x": "EXPIRED", ":a": "ASSIGNED" },
              },
            },
            ...live.map((r) => ({
              Update: {
                TableName: TABLE(),
                Key: { PK: `REQ#${r.id}`, SK: "META" },
                UpdateExpression:
                  "SET #s = :o, GSI1PK = :open, GSI1SK = :k, declinedBy = list_append(if_not_exists(declinedBy, :none), :c) REMOVE batchId, collectorId",
                ConditionExpression: "#s = :a AND collectorId = :c0",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":o": "OPEN",
                  ":a": "ASSIGNED",
                  ":open": "OPEN",
                  ":k": `${r.windowStart}#${r.gh5}#${r.id}`,
                  ":none": [],
                  ":c": [b.collectorId],
                  ":c0": b.collectorId,
                },
              },
            })),
          ],
        }),
      );
      released++;
    } catch (e) {
      // Started, cancelled or changed meanwhile: leave it, the next sweep looks again.
      if (!(e instanceof TransactionCanceledException)) throw e;
    }
  }
  return released;
}

export const handler = async (): Promise<{ batches: number; open: number }> => {
  const now = Date.now();
  await releaseStale(now);
  const open = await queryAll({
    TableName: TABLE(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :o",
    ExpressionAttributeValues: { ":o": "OPEN" },
  });
  if (!open.length) return { batches: 0, open: 0 };

  const reqs: OpenReq[] = open.map((r) => ({
    id: r.id,
    gh5: r.gh5,
    window: r.window,
    windowStart: r.windowStart,
    estKg: r.estKg,
    lat: r.lat,
    lng: r.lng,
    declined: r.declinedBy,
  }));

  const cells = [...new Set(reqs.map((r) => r.gh5))];
  const colIds = new Set<string>();
  for (const gh of cells) {
    const rows = await queryAll({
      TableName: TABLE(),
      KeyConditionExpression: "PK = :p",
      ExpressionAttributeValues: { ":p": `AREA#${gh}` },
    });
    rows.forEach((r) => colIds.add(String(r.SK).replace("COL#", "")));
  }
  const colItems: Item[] = [];
  const ids = [...colIds];
  for (let i = 0; i < ids.length; i += 100) {
    const out = await ddb.send(
      new BatchGetCommand({ RequestItems: { [TABLE()]: { Keys: ids.slice(i, i + 100).map((id) => ({ PK: `COL#${id}`, SK: "META" })) } } }),
    );
    colItems.push(...(out.Responses?.[TABLE()] ?? []));
  }
  const collectors: Collector[] = colItems.map((c) => ({ id: c.id, areas: c.areas, active: c.active !== false, lat: c.lat, lng: c.lng }));
  const colById = new Map(colItems.map((c) => [c.id as string, c]));
  const reqById = new Map(reqs.map((r) => [r.id, r]));

  let made = 0;
  for (const plan of planBatches(reqs, collectors, now)) {
    const col = colById.get(plan.collectorId)!;
    const stops = plan.requestIds.map((id) => ({ id, lat: reqById.get(id)!.lat, lng: reqById.get(id)!.lng }));
    const routed = await orderStops({ lat: col.lat, lng: col.lng }, stops);
    const batchId = randomUUID();
    const date = plan.window.split("#")[0]!;
    const estKg = stops.reduce((s, x) => s + reqById.get(x.id)!.estKg, 0);
    const day = istDate(now);
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
                  collectorId: plan.collectorId,
                  window: plan.window,
                  status: "ASSIGNED",
                  stops: routed.order,
                  naiveOrder: plan.requestIds, // the order requests came in, for the before/after comparison
                  estKg,
                  km: routed.km,
                  naiveKm: routed.naiveKm,
                  routeSource: routed.source,
                  // Listed in GSI1 until the collector starts it, so a stale one can be found and re-offered.
                  GSI1PK: "PENDING_BATCH",
                  GSI1SK: `${reqById.get(routed.order[0]!)!.windowStart}#${batchId}`,
                  GSI2PK: `COL#${plan.collectorId}`,
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
                ExpressionAttributeValues: { ":a": "ASSIGNED", ":b": batchId, ":c": plan.collectorId, ":o": "OPEN" },
              },
            })),
            {
              Update: {
                TableName: TABLE(),
                Key: { PK: "IMPACT#ALL", SK: day },
                UpdateExpression: "ADD batches :one, routeKm :rk, naiveKm :nk",
                ExpressionAttributeValues: { ":one": 1, ":rk": routed.km, ":nk": routed.naiveKm },
              },
            },
          ],
        }),
      );
    } catch (e) {
      // A request was cancelled or taken meanwhile; the next sweep re-plans the rest.
      if (e instanceof TransactionCanceledException) continue;
      throw e;
    }
    made++;
    await notifyCollector(
      col.phone,
      `Kabadi Connect: ${stops.length} pickups, about ${Math.round(estKg)} kg, ${plan.window.replace("#", " ")}. Open the app for your route.`,
    ).catch((e) => console.warn(JSON.stringify({ level: "warn", msg: "notify failed", reason: e.message })));
  }
  console.log(JSON.stringify({ level: "info", msg: "dispatch", open: open.length, batches: made }));
  return { batches: made, open: open.length };
};
