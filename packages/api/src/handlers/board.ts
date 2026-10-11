import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { haversineKm } from "@kc/shared";
import { DEFAULT_RADIUS_KM } from "../lib/collectors.js";
import { commitBatch } from "../lib/commit.js";
import { ddb, queryAll, TABLE } from "../lib/ddb.js";
import { HttpError, route } from "../lib/http.js";
import { windowEndMs } from "../lib/time.js";
import type { OpenReq } from "../lib/batching.js";

type Item = Record<string, any>;
const SPEED_KMPH = { walking: 4.5, cart: 10, scooter: 20 } as const;
const col = async (sub: string): Promise<Item> => {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${sub}`, SK: "META" } }));
  if (!Item) throw new HttpError(404, "collector profile not found");
  return Item;
};
const pt = (r: Item) => ({ lat: r.lat as number, lng: r.lng as number });
const openReq = (r: Item): OpenReq => ({ id: r.id, gh5: r.gh5, window: r.window, windowStart: r.windowStart, estKg: r.estKg, lat: r.lat, lng: r.lng, declined: r.declinedBy });

/** Requests nobody has taken yet, near the collector's position (or home), nearest first. Phone numbers stay hidden until claimed. */
export const nearby = route(["collector"], async (c) => {
  const me = await col(c.sub);
  const q = c.event.queryStringParameters ?? {};
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const from = Number.isFinite(lat) && Number.isFinite(lng) && q.lat ? { lat, lng } : { lat: me.lat as number, lng: me.lng as number };
  const radius = (me.serviceRadiusKm as number | undefined) ?? DEFAULT_RADIUS_KM;
  const now = Date.now();
  const open = await queryAll({ TableName: TABLE(), IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :o", ExpressionAttributeValues: { ":o": "OPEN" } });
  const list = open
    .filter((r) => !r.demo && !(r.declinedBy ?? []).includes(c.sub) && windowEndMs(r.date, r.slot) > now)
    .map((r) => ({ r, d: haversineKm(from, pt(r)) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, 30)
    .map(({ r, d }) => ({ id: r.id, items: r.items, estKg: r.estKg, date: r.date, slot: r.slot, notes: r.notes, distanceKm: Math.round(d * 10) / 10 }));
  return { requests: list, radiusKm: radius };
});

/** Take one open request now. The OPEN -> ASSIGNED condition inside commitBatch makes a double claim a clean 409. */
export const claim = route(["collector"], async (c) => {
  const me = await col(c.sub);
  const { Item: r } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${c.param("id")}`, SK: "META" } }));
  if (!r || r.demo || r.status !== "OPEN" || (r.declinedBy ?? []).includes(c.sub)) throw new HttpError(409, "this pickup was already taken");
  const radius = (me.serviceRadiusKm as number | undefined) ?? DEFAULT_RADIUS_KM;
  if (haversineKm(pt(me), pt(r)) > radius * 1.5) throw new HttpError(403, "too far from your area");
  const done = await commitBatch({ id: c.sub, lat: me.lat, lng: me.lng }, r.window, [openReq(r)], Date.now());
  if (!done) throw new HttpError(409, "this pickup was already taken");
  return { batchId: done.batchId };
});

const SettingsSchema = z.object({
  travelMode: z.enum(["walking", "cart", "scooter"]).optional(),
  serviceRadiusKm: z.number().min(1).max(30).optional(),
});

export const settings = route(["collector"], async (c) => {
  const b = c.body(SettingsSchema);
  await col(c.sub);
  const sets = Object.entries(b).filter(([, v]) => v !== undefined);
  if (!sets.length) return { ok: true };
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { PK: `COL#${c.sub}`, SK: "META" },
      UpdateExpression: `SET ${sets.map(([k], i) => `#k${i} = :v${i}`).join(", ")}`,
      ExpressionAttributeNames: Object.fromEntries(sets.map(([k], i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(sets.map(([, v], i) => [`:v${i}`, v])),
    }),
  );
  return { ok: true };
});

/** The collector's phone reports where it is while heading to a stop; expires on its own after 10 minutes. */
export const position = route(["collector"], async (c) => {
  const b = c.body(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), stopId: z.string().max(64).optional() }));
  const now = Date.now();
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { PK: `POS#${c.sub}`, SK: "META", ...b, at: now, ttl: Math.floor(now / 1000) + 600 } }));
  return { ok: true };
});

/** "On the way": straight-line distance and a rough ETA, only while the collector is heading to this very pickup. */
export const eta = route(["household", "admin"], async (c) => {
  const { Item: r } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${c.param("id")}`, SK: "META" } }));
  if (!r || (r.userId !== c.sub && !c.groups.includes("admin"))) throw new HttpError(404, "not found");
  if (r.status !== "EN_ROUTE" || !r.collectorId) return { eta: null };
  const [{ Item: pos }, { Item: me }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `POS#${r.collectorId}`, SK: "META" } })),
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${r.collectorId}`, SK: "META" } })),
  ]);
  if (!pos || pos.stopId !== r.id || Date.now() - pos.at > 5 * 60_000) return { eta: null };
  const km = haversineKm(pt(pos), pt(r)) * 1.3; // streets are longer than the straight line
  const speed = SPEED_KMPH[(me?.travelMode as keyof typeof SPEED_KMPH) ?? "walking"];
  return { eta: { distanceKm: Math.round(km * 10) / 10, minutes: Math.max(1, Math.round((km / speed) * 60)) } };
});
