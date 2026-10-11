import { randomBytes, randomUUID } from "node:crypto";
import type { APIGatewayProxyResult } from "aws-lambda";
import { z } from "zod";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CollectorSchema, PhoneSchema, type CollectorInput } from "@kc/shared";
import { haversineKm } from "@kc/shared";
import { ddb, queryAll, TABLE } from "../lib/ddb.js";
import { commitBatch } from "../lib/commit.js";
import { HttpError, json, route } from "../lib/http.js";
import { takeQuota } from "../lib/quota.js";
import { hashCode } from "./customAuth.js";
import { saveCollector } from "./collector.js";

const cognito = new CognitoIdentityProviderClient({});
const pool = () => process.env.USER_POOL_ID!;
const CARD_VALID_MS = 7 * 24 * 3600 * 1000;

/** Same rule the user pool enforces, checked first so the error is readable. */
export const PasswordSchema = z
  .string()
  .min(10, "at least 10 characters")
  .max(64)
  .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, "needs upper case, lower case and a number");

const CreateSchema = CollectorSchema.extend({ phone: PhoneSchema, password: PasswordSchema.optional() });

async function setPassword(sub: string, password: string) {
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: sub, Password: password, Permanent: true }));
}

/** Store a fresh one-time card code on the collector (replacing any earlier card) and return it. */
async function issueCard(sub: string): Promise<{ username: string; code: string; validUntil: number }> {
  const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: pool(), Username: sub }));
  const username = u.UserAttributes?.find((a) => a.Name === "email")?.Value;
  if (!username) throw new HttpError(409, "collector has no login");
  const code = randomBytes(24).toString("base64url");
  const validUntil = Date.now() + CARD_VALID_MS;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { PK: `COL#${sub}`, SK: "META" },
      UpdateExpression: "SET enrollHash = :h, enrollExp = :x",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":h": hashCode(code), ":x": validUntil },
    }),
  );
  // Re-enable in case an earlier revoke disabled the login.
  await cognito.send(new AdminEnableUserCommand({ UserPoolId: pool(), Username: sub }));
  return { username, code, validUntil };
}

/** Create the Cognito login, group membership, profile and first card for a collector. */
export async function provisionCollector(b: CollectorInput, extraGroups: string[] = []) {
  const digits = b.phone.replace(/\D/g, "").slice(-10);
  // Synthetic address: collectors never see or use email. .invalid is reserved and can never receive mail.
  const email = `${digits}@collectors.kabadi.invalid`;
  let sub: string;
  try {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: pool(),
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }),
    );
    sub = created.User!.Attributes!.find((a) => a.Name === "sub")!.Value!;
  } catch (e) {
    if ((e as Error).name === "UsernameExistsException") throw new HttpError(409, "a collector with this phone already exists");
    throw e;
  }
  // Random permanent password nobody knows: moves the user out of FORCE_CHANGE_PASSWORD; login is via card only.
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: pool(), Username: sub, Password: `Kc-${randomBytes(18).toString("base64url")}9a`, Permanent: true }),
  );
  for (const g of ["collector", ...extraGroups]) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: sub, GroupName: g }));
  }
  await saveCollector(sub, b);
  return { id: sub, ...(await issueCard(sub)) };
}

/** Admin: create a collector (login + profile) and return the one-time QR card code. */
export const createCollector = route(["admin"], async (c) => {
  // The password goes to the user pool only; it must never reach the stored profile.
  const { password, ...profile } = c.body(CreateSchema);
  const made = await provisionCollector(profile);
  if (password) await setPassword(made.id, password);
  return made;
});

/** Admin: set or reset a collector's password (for collectors who read and prefer a normal sign-in). */
export const adminSetPassword = route(["admin"], async (c) => {
  const { password } = c.body(z.object({ password: PasswordSchema }));
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${c.param("id")}`, SK: "META" } }));
  if (!Item) throw new HttpError(404, "not found");
  await setPassword(c.param("id"), password);
  return { ok: true };
});

/** A collector sets their own password after signing in with their card. */
export const ownPassword = route(["collector"], async (c) => {
  const { password } = c.body(z.object({ password: PasswordSchema }));
  await setPassword(c.sub, password);
  return { ok: true };
});

export const listCollectors = route(["admin"], async () => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :p",
      ExpressionAttributeValues: { ":p": "COLLECTORS" },
    }),
  );
  return {
    collectors: (res.Items ?? []).filter((i) => !i.demo).map((i) => ({
      id: i.id,
      name: i.name,
      phone: i.phone,
      areas: i.areas,
      lat: i.lat,
      lng: i.lng,
      active: i.active !== false,
      serviceRadiusKm: i.serviceRadiusKm ?? 8,
      travelMode: i.travelMode ?? "walking",
      cardActive: !!i.enrollHash && i.enrollExp > Date.now(),
    })),
  };
});

/** Admin: print a new card (the old one stops working). */
export const enrollCollector = route(["admin"], async (c) => {
  const id = c.param("id");
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${id}`, SK: "META" } }));
  if (!Item) throw new HttpError(404, "not found");
  return { id, ...(await issueCard(id)) };
});

/** Admin: lost phone or card. Kill the code, sign every session out and block login until a new card is issued. */
export const revokeCollector = route(["admin"], async (c) => {
  const id = c.param("id");
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${id}`, SK: "META" } }));
  if (!Item) throw new HttpError(404, "not found");
  await ddb.send(
    new UpdateCommand({ TableName: TABLE(), Key: { PK: `COL#${id}`, SK: "META" }, UpdateExpression: "REMOVE enrollHash, enrollExp" }),
  );
  await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: pool(), Username: id }));
  await cognito.send(new AdminDisableUserCommand({ UserPoolId: pool(), Username: id }));
  return { id, revoked: true };
});

/** Open requests older than 2 hours that no collector has taken: the admin's manual safety net. */
export const unassigned = route(["admin"], async () => {
  const open = await queryAll({ TableName: TABLE(), IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :o", ExpressionAttributeValues: { ":o": "OPEN" } });
  const cutoff = Date.now() - 2 * 3600 * 1000;
  return {
    requests: open
      .filter((r) => !r.demo && r.createdAt < cutoff)
      .map((r) => ({ id: r.id, items: r.items, estKg: r.estKg, address: r.address, lat: r.lat, lng: r.lng, date: r.date, slot: r.slot, collectorsNearby: r.collectorsNearby ?? 0 })),
  };
});

export const assign = route(["admin"], async (c) => {
  const { collectorId } = c.body(z.object({ collectorId: z.string().min(1).max(64) }));
  const [{ Item: r }, { Item: col }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${c.param("id")}`, SK: "META" } })),
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${collectorId}`, SK: "META" } })),
  ]);
  if (!r || !col || col.demo || r.demo) throw new HttpError(404, "not found");
  if (r.status !== "OPEN") throw new HttpError(409, "already assigned");
  const done = await commitBatch(
    { id: collectorId, lat: col.lat, lng: col.lng },
    r.window,
    [{ id: r.id, gh5: r.gh5, window: r.window, windowStart: r.windowStart, estKg: r.estKg, lat: r.lat, lng: r.lng }],
    Date.now(),
  );
  if (!done) throw new HttpError(409, "already assigned");
  return { batchId: done.batchId, distanceKm: Math.round(haversineKm({ lat: col.lat, lng: col.lng }, { lat: r.lat, lng: r.lng }) * 10) / 10 };
});

// ---- "I want to join as a kabadiwala": a request the admin reviews, never an open account ----
const JoinSchema = z.object({ name: z.string().trim().min(2).max(60), phone: PhoneSchema, area: z.string().trim().min(2).max(80) });

export const submitJoin = async (event: { body: string | null }): Promise<APIGatewayProxyResult> => {
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(event.body ?? "{}");
    } catch {
      return json(400, { error: "invalid json" });
    }
    const b = JoinSchema.safeParse(raw);
    if (!b.success) return json(400, { error: "invalid input" });
    await takeQuota("GLOBAL", "join", 50);
    const now = Date.now();
    const id = randomUUID();
    await ddb.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { PK: `JOIN#${id}`, SK: "META", id, ...b.data, createdAt: now, GSI2PK: "JOINS", GSI2SK: String(now), ttl: Math.floor(now / 1000) + 60 * 24 * 3600 },
      }),
    );
    return json(200, { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: "Too many requests today, please try again tomorrow." });
    console.error(JSON.stringify({ level: "error", msg: "join failed", reason: (e as Error).message }));
    return json(500, { error: "internal error" });
  }
};

export const listJoins = route(["admin"], async () => {
  const rows = await queryAll({ TableName: TABLE(), IndexName: "GSI2", KeyConditionExpression: "GSI2PK = :p", ExpressionAttributeValues: { ":p": "JOINS" } });
  return { joins: rows.map((j) => ({ id: j.id, name: j.name, phone: j.phone, area: j.area, createdAt: j.createdAt })) };
});

export const deleteJoin = route(["admin"], async (c) => {
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { PK: `JOIN#${c.param("id")}`, SK: "META" } }));
  return { ok: true };
});
