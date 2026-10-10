import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { CollectorSchema, ConfirmSchema, co2Kg, monthRangeMs, payout, type Category, type CollectorInput } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { HttpError, route } from "../lib/http.js";
import { istDate } from "../lib/time.js";

type Item = Record<string, any>;

async function loadBatch(id: string, sub: string): Promise<Item> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `BATCH#${id}`, SK: "META" } }));
  if (!Item || Item.collectorId !== sub) throw new HttpError(404, "not found");
  return Item;
}

/** Today's and upcoming batches for a collector, with stop details in route order. */
export async function loadBatches(sub: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "GSI2",
      // BATCH# range only: the same index also holds PICK# ledger rows for this collector.
      KeyConditionExpression: "GSI2PK = :c AND GSI2SK BETWEEN :d AND :e",
      ExpressionAttributeValues: { ":c": `COL#${sub}`, ":d": `BATCH#${istDate(Date.now() - 24 * 3600 * 1000)}`, ":e": "BATCH#~" },
    }),
  );
  const batches = res.Items ?? [];
  const ids = [...new Set(batches.flatMap((b) => b.stops as string[]))];
  const reqs = new Map<string, Item>();
  for (let i = 0; i < ids.length; i += 100) {
    const out = await ddb.send(
      new BatchGetCommand({
        RequestItems: { [TABLE()]: { Keys: ids.slice(i, i + 100).map((id) => ({ PK: `REQ#${id}`, SK: "META" })) } },
      }),
    );
    for (const r of out.Responses?.[TABLE()] ?? []) reqs.set(r.id, r);
  }
  return batches.map((b) => {
    const stops = (b.stops as string[])
      .map((id) => reqs.get(id))
      .filter((r): r is Item => !!r && r.collectorId === sub)
      .map((r) => ({
        id: r.id as string,
        status: r.status as string,
        address: r.address as string,
        lat: r.lat as number,
        lng: r.lng as number,
        items: r.items as { cat: Category; bucket: string; estKg: number }[],
        estKg: r.estKg as number,
        phone: r.phone as string | undefined,
        actual: r.actual,
        payout: r.payout,
      }));
    return {
      id: b.id as string,
      window: b.window as string,
      status: b.status as string,
      km: b.km,
      naiveKm: b.naiveKm,
      routeSource: b.routeSource,
      estKg: stops.reduce((s, x) => s + x.estKg, 0),
      stops,
    };
  });
}

export const collectorToday = route(["collector"], async (c) => ({ batches: await loadBatches(c.sub) }));

/** Stops still assigned to this collector (households may have cancelled since dispatch). */
async function liveStops(ids: string[], sub: string): Promise<string[]> {
  const out = await ddb.send(
    new BatchGetCommand({ RequestItems: { [TABLE()]: { Keys: ids.map((id) => ({ PK: `REQ#${id}`, SK: "META" })) } } }),
  );
  return (out.Responses?.[TABLE()] ?? [])
    .filter((r) => r.collectorId === sub && ["ASSIGNED", "EN_ROUTE"].includes(r.status))
    .map((r) => r.id);
}

/** Start a batch: batch ASSIGNED -> ACTIVE and every still-assigned stop -> EN_ROUTE, atomically. */
export const acceptBatch = route(["collector"], async (c) => {
  const b = await loadBatch(c.param("id"), c.sub);
  if (b.status === "ACTIVE") return { id: b.id, status: "ACTIVE" };
  const live = await liveStops(b.stops as string[], c.sub);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE(),
              Key: { PK: `BATCH#${b.id}`, SK: "META" },
              UpdateExpression: "SET #s = :a REMOVE GSI1PK, GSI1SK",
              ConditionExpression: "#s = :as",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":a": "ACTIVE", ":as": "ASSIGNED" },
            },
          },
          ...live.map((id) => ({
            Update: {
              TableName: TABLE(),
              Key: { PK: `REQ#${id}`, SK: "META" },
              UpdateExpression: "SET #s = :e",
              ConditionExpression: "collectorId = :c AND #s IN (:as, :e)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":e": "EN_ROUTE", ":c": c.sub, ":as": "ASSIGNED" },
            },
          })),
        ],
      }),
    );
  } catch (e) {
    if (e instanceof TransactionCanceledException) throw new HttpError(409, "batch changed, refresh and retry");
    throw e;
  }
  return { id: b.id, status: "ACTIVE" };
});

async function ownRequest(id: string, sub: string): Promise<Item> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${id}`, SK: "META" } }));
  if (!Item || Item.collectorId !== sub) throw new HttpError(404, "not found");
  return Item;
}

export const markMissed = route(["collector"], async (c) => {
  const r = await ownRequest(c.param("id"), c.sub);
  if (r.status === "MISSED") return { id: r.id, status: "MISSED" };
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `REQ#${r.id}`, SK: "META" },
        UpdateExpression: "SET #s = :m",
        ConditionExpression: "#s = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":m": "MISSED", ":e": "EN_ROUTE" },
      }),
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new HttpError(409, "pickup is not in progress");
    throw e;
  }
  return { id: r.id, status: "MISSED" };
});

/** Record actual weights, compute payout and CO2, bump impact counters. Idempotent. */
export const confirmPickup = route(["collector"], async (c) => {
  const r = await ownRequest(c.param("id"), c.sub);
  if (r.status === "PICKED") return { id: r.id, status: "PICKED", actual: r.actual, payout: r.payout, co2Kg: r.co2Kg };
  if (r.status !== "EN_ROUTE") throw new HttpError(409, "start the batch before confirming");
  const body = c.body(ConfirmSchema);

  const col = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${c.sub}`, SK: "META" } }));
  const rates = (col.Item?.rates ?? {}) as Partial<Record<Category, number>>;
  const kgs = body.items.map((i) => ({ cat: i.cat, kg: i.actualKg }));
  const totalKg = +kgs.reduce((s, i) => s + i.kg, 0).toFixed(2);
  const money = payout(kgs, rates);
  const co2 = co2Kg(kgs);

  const now = Date.now();
  const day = istDate(now);
  const seg = body.segregation;
  const add = (pk: string) => ({
    Update: {
      TableName: TABLE(),
      Key: { PK: pk, SK: day },
      UpdateExpression:
        "ADD pickups :one, kg :kg, co2Kg :co2, payout :pay" +
        (seg ? ", segTotal :one, segGood :sg" : "") +
        kgs.map((_, i) => `, kg_${kgs[i]!.cat} :k${i}`).join(""),
      ExpressionAttributeValues: {
        ":one": 1,
        ":kg": totalKg,
        ":co2": co2,
        ":pay": money,
        ...(seg ? { ":sg": seg === "good" ? 1 : 0 } : {}),
        ...Object.fromEntries(kgs.map((k, i) => [`:k${i}`, k.kg])),
      },
    },
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE(),
              Key: { PK: `REQ#${r.id}`, SK: "META" },
              // The GSI2 row doubles as the collector's ledger entry (see buildLedger).
              UpdateExpression:
                "SET #s = :p, actual = :a, payout = :m, co2Kg = :co, pickedAt = :t, segregation = :sg, GSI2PK = :g2, GSI2SK = :g2s",
              ConditionExpression: "#s = :e AND collectorId = :c",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":p": "PICKED",
                ":a": kgs,
                ":m": money,
                ":co": co2,
                ":t": now,
                ":sg": seg ?? null,
                ":g2": `COL#${c.sub}`,
                ":g2s": `PICK#${String(now).padStart(13, "0")}`,
                ":e": "EN_ROUTE",
                ":c": c.sub,
              },
            },
          },
          // Judge-demo pickups are kept out of the real impact totals.
          ...(r.demo ? [add("IMPACT#DEMO")] : [add("IMPACT#ALL"), add(`IMPACT#${r.gh5}`)]),
        ],
      }),
    );
  } catch (e) {
    if (e instanceof TransactionCanceledException) throw new HttpError(409, "already confirmed or changed");
    throw e;
  }
  return { id: r.id, status: "PICKED", actual: kgs, payout: money, co2Kg: co2 };
});

/** Create or update a collector profile and the area index used by dispatch; keeps card/enrolment fields. */
export async function saveCollector(id: string, b: CollectorInput): Promise<void> {
  const { Item: old } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${id}`, SK: "META" } }));
  const oldAreas: string[] = old?.areas ?? [];
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        // GSI2PK=COLLECTORS lists every collector for the admin screen.
        { Put: { TableName: TABLE(), Item: { ...old, PK: `COL#${id}`, SK: "META", id, ...b, rates: b.rates ?? old?.rates, GSI2PK: "COLLECTORS", GSI2SK: `COL#${id}` } } },
        ...b.areas.map((a) => ({ Put: { TableName: TABLE(), Item: { PK: `AREA#${a}`, SK: `COL#${id}` } } })),
        ...oldAreas
          .filter((a) => !b.areas.includes(a))
          .map((a) => ({ Delete: { TableName: TABLE(), Key: { PK: `AREA#${a}`, SK: `COL#${id}` } } })),
      ],
    }),
  );
}

export const upsertCollector = route(["admin"], async (c) => {
  const id = c.param("id");
  await saveCollector(id, c.body(CollectorSchema));
  return { id };
});

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Monthly statement of confirmed pickups: income proof for the collector, traceable record for EPR. */
export async function buildLedger(sub: string, month: string) {
  const [from, to] = monthRangeMs(month);
  const pad = (n: number) => String(n).padStart(13, "0");
  const rows: Item[] = [];
  let key: Record<string, any> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :c AND GSI2SK BETWEEN :a AND :b",
        ExpressionAttributeValues: { ":c": `COL#${sub}`, ":a": `PICK#${pad(from)}`, ":b": `PICK#${pad(to - 1)}` },
        ExclusiveStartKey: key,
      }),
    );
    rows.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);

  const byCategory: Record<string, number> = {};
  let kg = 0;
  let money = 0;
  let co2 = 0;
  let verified = 0;
  let good = 0;
  let rated = 0;
  for (const r of rows) {
    for (const a of (r.actual ?? []) as { cat: string; kg: number }[]) {
      byCategory[a.cat] = +((byCategory[a.cat] ?? 0) + a.kg).toFixed(2);
      kg += a.kg;
    }
    money += r.payout ?? 0;
    co2 += r.co2Kg ?? 0;
    if (r.householdAck) verified++;
    if (r.segregation) {
      rated++;
      if (r.segregation === "good") good++;
    }
  }
  const { Item: col } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${sub}`, SK: "META" } }));
  return {
    month,
    collector: { name: col?.name ?? "", phone: col?.phone ?? "" },
    pickups: rows.length,
    verifiedPickups: verified,
    kg: +kg.toFixed(2),
    byCategory,
    payout: money,
    co2Kg: +co2.toFixed(2),
    segregationGoodPct: rated ? Math.round((good / rated) * 100) : null,
    // No household address here: the statement is shared with lenders and producers.
    rows: rows.map((r) => ({
      date: istDate(r.pickedAt),
      kg: +((r.actual ?? []) as { kg: number }[]).reduce((s, a) => s + a.kg, 0).toFixed(2),
      payout: r.payout ?? 0,
      verified: !!r.householdAck,
    })),
  };
}

const monthOf = (q?: string) => MonthSchema.parse(q ?? istDate(Date.now()).slice(0, 7));

export const collectorLedger = route(["collector"], (c) => buildLedger(c.sub, monthOf(c.event.queryStringParameters?.month)));
export const adminLedger = route(["admin"], (c) => buildLedger(c.param("id"), monthOf(c.event.queryStringParameters?.month)));
