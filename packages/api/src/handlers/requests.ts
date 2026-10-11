import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { CreateRequestSchema, estKg, geohash, RescheduleSchema, WEIGHT_BUCKETS, windowId, windowStartMs } from "@kc/shared";
import { activeCollectors, covers, toCollector } from "../lib/collectors.js";
import { ddb, NINETY_DAYS_S, TABLE } from "../lib/ddb.js";
import { HttpError, route } from "../lib/http.js";
import { istDate, windowEndMs } from "../lib/time.js";

const sqs = new SQSClient({});
const MAX_OPEN_PER_USER = 5;

type Item = Record<string, any>;

/** Strip index keys and other users' private fields before returning a request. */
export const publicView = (r: Item, viewer: { sub: string; admin: boolean }) => ({
  id: r.id,
  status: r.status,
  items: r.items,
  address: r.address,
  lat: r.lat,
  lng: r.lng,
  date: r.date,
  slot: r.slot,
  estKg: r.estKg,
  notes: r.notes,
  // How many collectors could reach this address when it was booked; 0 means "no kabadiwala here yet".
  collectorsNearby: r.collectorsNearby,
  createdAt: r.createdAt,
  ...(r.status === "PICKED" || r.status === "MISSED"
    ? { actual: r.actual, payout: r.payout, co2Kg: r.co2Kg, householdAck: !!r.householdAck, segregation: r.segregation }
    : {}),
  ...(viewer.sub === r.userId || viewer.admin ? { collectorId: r.collectorId } : {}),
});

async function loadRequest(id: string): Promise<Item> {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${id}`, SK: "META" } }));
  if (!Item) throw new HttpError(404, "not found");
  return Item;
}

export const createRequest = route(["household", "admin"], async (c) => {
  const b = c.body(CreateRequestSchema);
  const now = Date.now();
  if (windowEndMs(b.date, b.slot) <= now) throw new HttpError(400, "that time window has already passed");
  if (windowStartMs(b.date, b.slot) - now > 7 * 24 * 3600 * 1000) throw new HttpError(400, "too far ahead");

  const mine = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :u",
      FilterExpression: "#s IN (:o, :a)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":u": `USER#${c.sub}`, ":o": "OPEN", ":a": "ASSIGNED" },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  if ((mine.Items?.length ?? 0) >= MAX_OPEN_PER_USER) throw new HttpError(429, "too many open pickups");

  const id = randomUUID();
  const gh5 = geohash(b.lat, b.lng, 5);
  const collectorsNearby = (await activeCollectors()).map(toCollector).filter((c) => covers(c, { lat: b.lat, lng: b.lng, gh5 })).length;
  const win = windowId(b.date, b.slot);
  const item = {
    PK: `REQ#${id}`,
    SK: "META",
    id,
    userId: c.sub,
    status: "OPEN",
    items: b.items.map((i) => ({ cat: i.cat, bucket: i.bucket, estKg: WEIGHT_BUCKETS[i.bucket] })),
    estKg: estKg(b.items),
    lat: b.lat,
    lng: b.lng,
    gh5,
    address: b.address,
    phone: b.phone,
    notes: b.notes,
    collectorsNearby,
    date: b.date,
    slot: b.slot,
    window: win,
    windowStart: windowStartMs(b.date, b.slot),
    createdAt: now,
    GSI1PK: "OPEN", // shortcut: single hot partition, fine to ~10^5 open requests; shard by gh5 beyond that
    GSI1SK: `${windowStartMs(b.date, b.slot)}#${gh5}#${id}`,
    GSI3PK: `USER#${c.sub}`,
    GSI3SK: now,
    ttl: Math.floor(now / 1000) + NINETY_DAYS_S,
  };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item, ConditionExpression: "attribute_not_exists(PK)" }));
  if (process.env.QUEUE_URL) {
    // The 5-minute sweep still picks the request up if this fails, so don't fail the call.
    await sqs
      .send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify({ gh5, window: win }) }))
      .catch((e) => console.warn(JSON.stringify({ level: "warn", msg: "enqueue failed", reason: e.message })));
  }
  return publicView(item, { sub: c.sub, admin: false });
});

export const getRequest = route(null, async (c) => {
  const r = await loadRequest(c.param("id"));
  const admin = c.groups.includes("admin");
  if (r.userId !== c.sub && r.collectorId !== c.sub && !admin) throw new HttpError(404, "not found");
  return publicView(r, { sub: c.sub, admin });
});

export const listMyRequests = route(["household", "admin"], async (c) => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :u",
      ExpressionAttributeValues: { ":u": `USER#${c.sub}` },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return { requests: (res.Items ?? []).map((r) => publicView(r, { sub: c.sub, admin: false })) };
});

export const cancelRequest = route(["household", "admin"], async (c) => {
  const id = c.param("id");
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `REQ#${id}`, SK: "META" },
        UpdateExpression: "SET #s = :c REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "userId = :u AND #s IN (:o, :a)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":c": "CANCELLED", ":u": c.sub, ":o": "OPEN", ":a": "ASSIGNED" },
      }),
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new HttpError(409, "cannot cancel this pickup");
    throw e;
  }
  return { id, status: "CANCELLED" };
});

/** Household confirms the collector's recorded weights (mutual confirmation). Counted once in the impact totals. */
export const ackPickup = route(["household", "admin"], async (c) => {
  const id = c.param("id");
  const r = await loadRequest(id);
  if (r.userId !== c.sub || r.status !== "PICKED") throw new HttpError(409, "nothing to confirm");
  if (r.householdAck) return { id, householdAck: true };
  const kg = +((r.actual ?? []) as { kg: number }[]).reduce((s, a) => s + a.kg, 0).toFixed(2);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE(),
              Key: { PK: `REQ#${id}`, SK: "META" },
              UpdateExpression: "SET householdAck = :t",
              ConditionExpression: "userId = :u AND #s = :p AND attribute_not_exists(householdAck)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":t": true, ":u": c.sub, ":p": "PICKED" },
            },
          },
          {
            Update: {
              TableName: TABLE(),
              Key: { PK: "IMPACT#ALL", SK: istDate(Date.now()) },
              UpdateExpression: "ADD ackPickups :one, ackKg :kg",
              ExpressionAttributeValues: { ":one": 1, ":kg": kg },
            },
          },
        ],
      }),
    );
  } catch (e) {
    if (e instanceof TransactionCanceledException) throw new HttpError(409, "nothing to confirm");
    throw e;
  }
  return { id, householdAck: true };
});

/** Move an OPEN or ASSIGNED pickup to a new date and slot. An assigned one is released from its batch and re-offered. */
export const reschedule = route(["household", "admin"], async (c) => {
  const id = c.param("id");
  const b = c.body(RescheduleSchema);
  const now = Date.now();
  if (windowEndMs(b.date, b.slot) <= now) throw new HttpError(400, "that time window has already passed");
  if (windowStartMs(b.date, b.slot) - now > 7 * 24 * 3600 * 1000) throw new HttpError(400, "too far ahead");
  const r = await loadRequest(id);
  if (r.userId !== c.sub && !c.groups.includes("admin")) throw new HttpError(404, "not found");
  const start = windowStartMs(b.date, b.slot);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `REQ#${id}`, SK: "META" },
        UpdateExpression:
          "SET #s = :open, #d = :date, slot = :slot, #w = :win, windowStart = :start, GSI1PK = :open, GSI1SK = :k REMOVE batchId, collectorId",
        ConditionExpression: "#s IN (:open, :asg)",
        ExpressionAttributeNames: { "#s": "status", "#d": "date", "#w": "window" },
        ExpressionAttributeValues: {
          ":open": "OPEN",
          ":asg": "ASSIGNED",
          ":date": b.date,
          ":slot": b.slot,
          ":win": windowId(b.date, b.slot),
          ":start": start,
          ":k": `${start}#${r.gh5}#${id}`,
        },
      }),
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new HttpError(409, "cannot reschedule this pickup");
    throw e;
  }
  return { id, status: "OPEN", date: b.date, slot: b.slot };
});
