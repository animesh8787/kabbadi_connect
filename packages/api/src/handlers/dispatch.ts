import { BatchGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TABLE, ddb, queryAll } from "../lib/ddb.js";
import { commitBatch } from "../lib/commit.js";
import { activeCollectors, toCollector } from "../lib/collectors.js";
import { planBatches, type Collector, type OpenReq } from "../lib/batching.js";
import { notifyCollector } from "../lib/notify.js";

type Item = Record<string, any>;

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

  const colItems = await activeCollectors();
  const collectors = colItems.map(toCollector);
  const colById = new Map(colItems.map((c) => [c.id as string, c]));
  const reqById = new Map(reqs.map((r) => [r.id, r]));

  let made = 0;
  for (const plan of planBatches(reqs, collectors, now)) {
    const col = colById.get(plan.collectorId)!;
    const done = await commitBatch(col as { id: string; lat: number; lng: number }, plan.window, plan.requestIds.map((id) => reqById.get(id)!), now);
    // A request was cancelled or taken meanwhile; the next sweep re-plans the rest.
    if (!done) continue;
    made++;
    await notifyCollector(
      col.phone,
      `Kabadi Connect: ${plan.requestIds.length} pickups, about ${Math.round(done.estKg)} kg, ${plan.window.replace("#", " ")}. Open the app for your route.`,
    ).catch((e) => console.warn(JSON.stringify({ level: "warn", msg: "notify failed", reason: e.message })));
  }
  console.log(JSON.stringify({ level: "info", msg: "dispatch", open: open.length, batches: made }));
  return { batches: made, open: open.length };
};
