import { randomInt, randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult } from "aws-lambda";
import { geohash } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { HttpError, json } from "../lib/http.js";
import { takeQuota } from "../lib/quota.js";
import { localOrder, tourKm } from "../lib/routing.js";
import { istDate } from "../lib/time.js";
import { provisionCollector } from "./admin.js";

/**
 * Public judge demo: no login. Each call creates a throwaway collector (in the "demo" group, with a
 * smaller voice quota) plus three ready pickups assigned to it, and returns a one-time card code.
 * Demo rows are flagged `demo`, never enter the dispatcher (no OPEN index, dummy area), expire after
 * 3 days, and their confirmed pickups are counted outside the real impact totals.
 */
const DAILY_DEMO_STARTS = 100;
const HOME = { lat: 28.7041, lng: 77.1025 };
const STOPS = [
  { address: "Demo house 1, Sector 4, Rohini", dlat: 0.004, dlng: 0.003, items: [{ cat: "paper", bucket: "5-10" }, { cat: "plastic", bucket: "2-5" }] },
  { address: "Demo house 2, Sector 7, Rohini", dlat: -0.003, dlng: 0.006, items: [{ cat: "metal", bucket: "2-5" }, { cat: "ewaste", bucket: "<2" }] },
  { address: "Demo house 3, Sector 9, Rohini", dlat: 0.007, dlng: -0.004, items: [{ cat: "glass", bucket: "<2" }, { cat: "paper", bucket: "2-5" }] },
] as const;
const KG: Record<string, number> = { "<2": 1, "2-5": 3.5, "5-10": 7.5, "10+": 15 };

export const handler = async (): Promise<APIGatewayProxyResult> => {
  try {
    await takeQuota("GLOBAL", "demo-start", DAILY_DEMO_STARTS);
    const phone = `8${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    const card = await provisionCollector(
      { name: "Demo Collector", phone, areas: ["demo0"], lat: HOME.lat, lng: HOME.lng, active: true },
      ["demo"],
    );
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + 3 * 24 * 3600;
    const date = istDate(now);
    const batchId = randomUUID();
    const stops = STOPS.map((s) => ({ id: randomUUID(), lat: HOME.lat + s.dlat, lng: HOME.lng + s.dlng, ...s }));
    const pts = stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng }));
    const order = localOrder(HOME, pts).map((s) => s.id);
    // Demo only: make the "request order" the zig-zag one so the comparison is visible; real batches use the true arrival order.
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((p) => p.map((i) => pts[i]!));
    const naive = perms.reduce((worst, p) => (tourKm(HOME, p) > tourKm(HOME, worst) ? p : worst));
    const naiveOrder = naive.map((s) => s.id);

    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `COL#${card.id}`, SK: "META" },
        UpdateExpression: "SET demo = :t, #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":t": true, ":ttl": ttl },
      }),
    );
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
                collectorId: card.id,
                window: `${date}#evening`,
                status: "ASSIGNED",
                stops: order,
                estKg: stops.reduce((a, s) => a + s.items.reduce((b, i) => b + KG[i.bucket]!, 0), 0),
                km: tourKm(HOME, order.map((id) => pts.find((p) => p.id === id)!)),
                naiveKm: tourKm(HOME, naive),
                naiveOrder,
                routeSource: "demo",
                demo: true,
                // No GSI1 keys: the stale-batch sweep and dispatcher must never touch demo rows.
                GSI2PK: `COL#${card.id}`,
                GSI2SK: `BATCH#${date}#${batchId}`,
                createdAt: now,
                ttl,
              },
            },
          },
          ...stops.map((s) => ({
            Put: {
              TableName: TABLE(),
              Item: {
                PK: `REQ#${s.id}`,
                SK: "META",
                id: s.id,
                userId: "demo-household",
                status: "ASSIGNED",
                batchId,
                collectorId: card.id,
                items: s.items.map((i) => ({ cat: i.cat, bucket: i.bucket, estKg: KG[i.bucket] })),
                estKg: s.items.reduce((a, i) => a + KG[i.bucket]!, 0),
                lat: s.lat,
                lng: s.lng,
                gh5: geohash(s.lat, s.lng, 5),
                address: s.address,
                date,
                slot: "evening",
                window: `${date}#evening`,
                windowStart: now,
                createdAt: now,
                demo: true,
                ttl,
              },
            },
          })),
        ],
      }),
    );
    return json(200, { username: card.username, code: card.code, validUntil: card.validUntil });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.status === 429 ? "The demo is busy today, please try again tomorrow." : e.message });
    console.error(JSON.stringify({ level: "error", msg: "demo start failed", reason: (e as Error).message }));
    return json(500, { error: "internal error" });
  }
};
