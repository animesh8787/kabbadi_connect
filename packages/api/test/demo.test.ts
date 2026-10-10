import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handlers/demo.js";
import { confirmPickup } from "../src/handlers/collector.js";

const db = mockClient(DynamoDBDocumentClient);
const idp = mockClient(CognitoIdentityProviderClient);
process.env.USER_POOL_ID = "pool";

beforeEach(() => {
  db.reset();
  idp.reset();
  idp.on(AdminCreateUserCommand).resolves({ User: { Attributes: [{ Name: "sub", Value: "demo-sub" }] } });
  idp.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: "email", Value: "8123456789@collectors.kabadi.invalid" }] });
  idp.on(AdminSetUserPasswordCommand).resolves({});
  idp.on(AdminAddUserToGroupCommand).resolves({});
  idp.on(AdminEnableUserCommand).resolves({});
  db.on(UpdateCommand).resolves({});
  db.on(GetCommand).resolves({});
  db.on(TransactWriteCommand).resolves({});
});

describe("public judge demo", () => {
  it("creates a throwaway demo collector with three assigned pickups and returns a card", async () => {
    const res = await handler();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBeTruthy();
    expect(body.username).toMatch(/@collectors\.kabadi\.invalid$/);

    const groups = idp.commandCalls(AdminAddUserToGroupCommand).map((c) => c.args[0].input.GroupName);
    expect(groups).toEqual(["collector", "demo"]);

    // last transaction is the demo seed: 1 batch + 3 requests
    const seed = db.commandCalls(TransactWriteCommand).at(-1)!.args[0].input.TransactItems!;
    expect(seed).toHaveLength(4);
    for (const t of seed) {
      const item = t.Put!.Item!;
      expect(item.demo).toBe(true);
      expect(item.ttl).toBeGreaterThan(Date.now() / 1000);
      // never visible to the dispatcher or the stale-batch sweep
      expect(item.GSI1PK).toBeUndefined();
    }
    const reqs = seed.slice(1).map((t) => t.Put!.Item!);
    expect(reqs.every((r) => r.status === "ASSIGNED" && r.collectorId === "demo-sub" && r.userId === "demo-household")).toBe(true);
    expect(reqs.some((r) => r.items.some((i: any) => i.cat === "ewaste"))).toBe(true);
    expect(JSON.stringify(reqs)).not.toMatch(/"phone"/); // no real or fake phone numbers to dial
  });

  it("stores an optimised route that is shorter than the request order", async () => {
    await handler();
    const batch = db.commandCalls(TransactWriteCommand).at(-1)!.args[0].input.TransactItems![0]!.Put!.Item!;
    expect(batch.naiveOrder).toHaveLength(3);
    expect([...batch.naiveOrder].sort()).toEqual([...batch.stops].sort());
    expect(batch.km).toBeGreaterThan(0);
    expect(batch.naiveKm).toBeGreaterThanOrEqual(batch.km);
  });

  it("keeps demo collectors out of dispatch by using a dummy area", async () => {
    await handler();
    const profile = db.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.find((t) => t.Put?.Item?.PK === "COL#demo-sub")!;
    expect(profile.Put!.Item!.areas).toEqual(["demo0"]);
  });

  it("stops when the daily demo cap is reached, without creating any user", async () => {
    db.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    const res = await handler();
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toMatch(/busy/);
    expect(idp.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("demo pickups and real impact", () => {
  const ev = (): any => ({
    requestContext: { authorizer: { claims: { sub: "demo-sub", "cognito:groups": "collector,demo" } } },
    body: JSON.stringify({ items: [{ cat: "paper", actualKg: 2 }] }),
    pathParameters: { id: "r1" },
  });

  it("writes demo confirmations to a separate impact bucket", async () => {
    db.on(GetCommand, { Key: { PK: "REQ#r1", SK: "META" } }).resolves({ Item: { id: "r1", collectorId: "demo-sub", status: "EN_ROUTE", demo: true, gh5: "demo0" } });
    db.on(GetCommand, { Key: { PK: "COL#demo-sub", SK: "META" } }).resolves({ Item: {} });
    await confirmPickup(ev());
    const items = db.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const keys = items.map((i) => i.Update!.Key!.PK);
    expect(keys).toEqual(["REQ#r1", "IMPACT#DEMO"]);
  });
});
