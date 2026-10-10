import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createRequest } from "../src/handlers/requests.js";
import { confirmPickup } from "../src/handlers/collector.js";

const db = mockClient(DynamoDBDocumentClient);
const ev = (sub: string, groups: string, body: unknown, params: Record<string, string> = {}): any => ({
  requestContext: { authorizer: { claims: { sub, "cognito:groups": groups } } },
  body: JSON.stringify(body),
  pathParameters: params,
});
const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const payload = { items: [{ cat: "paper", bucket: "2-5" }], lat: 28.6, lng: 77.2, address: "12 Main Rd", date: future, slot: "evening" };

beforeEach(() => {
  db.reset();
  delete process.env.QUEUE_URL;
});

describe("createRequest", () => {
  it("rejects unauthenticated and wrong-group callers", async () => {
    expect((await createRequest({ requestContext: {} } as any)).statusCode).toBe(401);
    expect((await createRequest(ev("u1", "collector", payload))).statusCode).toBe(403);
  });
  it("creates a request for a household", async () => {
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    const res = await createRequest(ev("u1", "household", payload));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("OPEN");
    expect(body.estKg).toBe(3.5);
    expect(body).not.toHaveProperty("PK");
  });
  it("caps open pickups per user", async () => {
    db.on(QueryCommand).resolves({ Items: Array(5).fill({}) });
    expect((await createRequest(ev("u1", "household", payload))).statusCode).toBe(429);
  });
  it("rejects invalid input and past windows", async () => {
    expect((await createRequest(ev("u1", "household", { ...payload, items: [] }))).statusCode).toBe(400);
    expect((await createRequest(ev("u1", "household", { ...payload, date: "2020-01-01" }))).statusCode).toBe(400);
  });
});

describe("confirmPickup", () => {
  const picked = { id: "r1", collectorId: "c1", status: "PICKED", actual: [], payout: 10, co2Kg: 1 };
  const body = { items: [{ cat: "paper", actualKg: 2.5 }] };
  it("hides requests that belong to another collector", async () => {
    db.on(GetCommand).resolves({ Item: { ...picked, collectorId: "someone-else" } });
    expect((await confirmPickup(ev("c1", "collector", body, { id: "r1" }))).statusCode).toBe(404);
  });
  it("is idempotent for an already picked request", async () => {
    db.on(GetCommand).resolves({ Item: picked });
    const res = await confirmPickup(ev("c1", "collector", body, { id: "r1" }));
    expect(res.statusCode).toBe(200);
    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it("computes payout and writes the request plus two impact counters in one transaction", async () => {
    db.on(GetCommand, { Key: { PK: "REQ#r1", SK: "META" } }).resolves({ Item: { ...picked, status: "EN_ROUTE", gh5: "ttnfv" } });
    db.on(GetCommand, { Key: { PK: "COL#c1", SK: "META" } }).resolves({ Item: { rates: { paper: 20 } } });
    db.on(TransactWriteCommand).resolves({});
    const res = await confirmPickup(ev("c1", "collector", body, { id: "r1" }));
    expect(JSON.parse(res.body)).toMatchObject({ status: "PICKED", payout: 50, co2Kg: 9.85 });
    expect(db.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems).toHaveLength(3);
  });
});
