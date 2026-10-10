import { randomBytes } from "node:crypto";
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
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CollectorSchema, PhoneSchema } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { HttpError, route } from "../lib/http.js";
import { hashCode } from "./customAuth.js";
import { saveCollector } from "./collector.js";

const cognito = new CognitoIdentityProviderClient({});
const pool = () => process.env.USER_POOL_ID!;
const CARD_VALID_MS = 7 * 24 * 3600 * 1000;

const CreateSchema = CollectorSchema.extend({ phone: PhoneSchema });

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

/** Admin: create a collector (login + profile) and return the one-time QR card code. */
export const createCollector = route(["admin"], async (c) => {
  const b = c.body(CreateSchema);
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
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool(), Username: sub, GroupName: "collector" }));
  await saveCollector(sub, b);
  return { id: sub, ...(await issueCard(sub)) };
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
    collectors: (res.Items ?? []).map((i) => ({
      id: i.id,
      name: i.name,
      phone: i.phone,
      areas: i.areas,
      lat: i.lat,
      lng: i.lng,
      active: i.active !== false,
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
