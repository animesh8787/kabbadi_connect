import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { AdminSetUserPasswordCommand, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminGetUserCommand, AdminEnableUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const bedrock = vi.hoisted(() => ({ toolCall: vi.fn() }));
vi.mock("../src/lib/bedrock.js", () => bedrock);
const secrets = vi.hoisted(() => ({ secret: vi.fn() }));
vi.mock("../src/lib/secrets.js", () => secrets);

import { chooseTool, resetLlmState, tool } from "../src/lib/llm.js";
import { planHousehold, ruleHousehold, householdContext } from "../src/lib/household.js";
import { collectorContext, planReply, ruleIntent } from "../src/lib/intent.js";
import { claim, nearby, eta } from "../src/handlers/board.js";
import { createRequest, reschedule } from "../src/handlers/requests.js";
import { createCollector, ownPassword, submitJoin } from "../src/handlers/admin.js";

const db = mockClient(DynamoDBDocumentClient);
const idp = mockClient(CognitoIdentityProviderClient);
process.env.USER_POOL_ID = "pool";
const NOW = Date.parse("2026-10-11T08:30:00Z"); // 14:00 IST, a Sunday
const ev = (sub: string, groups: string, body: unknown = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): any => ({
  requestContext: { authorizer: { claims: { sub, "cognito:groups": groups } } },
  body: JSON.stringify(body),
  pathParameters: params,
  queryStringParameters: query,
});

beforeEach(() => {
  db.reset();
  idp.reset();
  bedrock.toolCall.mockReset();
  secrets.secret.mockReset();
  resetLlmState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LLM chain: Bedrock, then Groq, then nothing", () => {
  const tools = [tool("answer", "reply", { type: "object", properties: { text: { type: "string" } } })];
  it("uses Bedrock when it answers", async () => {
    bedrock.toolCall.mockResolvedValue({ name: "answer", input: { text: "hi" } });
    expect(await chooseTool({ system: "s", user: "u", tools })).toEqual({ call: { name: "answer", input: { text: "hi" } }, via: "bedrock" });
  });
  it("falls back to Groq when Bedrock access is denied, and stops retrying Bedrock for a while", async () => {
    bedrock.toolCall.mockRejectedValue(new Error("Your account is currently being verified"));
    secrets.secret.mockResolvedValue("gsk_test");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "answer", arguments: '{"text":"namaste"}' } }] } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const r = await chooseTool({ system: "s", user: "u", tools, smart: true });
    expect(r).toEqual({ call: { name: "answer", input: { text: "namaste" } }, via: "groq" });
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.model).toBe("openai/gpt-oss-120b");
    expect(sent.reasoning_effort).toBe("low");
    expect(sent.tool_choice).toBe("required");
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer gsk_test");
    await chooseTool({ system: "s", user: "u", tools });
    expect(bedrock.toolCall).toHaveBeenCalledTimes(1); // second turn skipped Bedrock
  });
  it("uses the fast Groq model for plain intents", async () => {
    bedrock.toolCall.mockRejectedValue(new Error("AccessDeniedException"));
    secrets.secret.mockResolvedValue("k");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await chooseTool({ system: "s", user: "u", tools });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe("openai/gpt-oss-20b");
  });
  it("returns no call (callers use keyword rules) when there is no Groq key or Groq errors", async () => {
    bedrock.toolCall.mockRejectedValue(new Error("verified"));
    secrets.secret.mockResolvedValue(null);
    expect((await chooseTool({ system: "s", user: "u", tools })).via).toBe("none");
    secrets.secret.mockResolvedValue("k");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect((await chooseTool({ system: "s", user: "u", tools })).call).toBeNull();
  });
});

describe("collector assistant: answers and navigation", () => {
  it("passes a free-form answer through, capped, and never as an action", () => {
    const p = planReply({ name: "answer", input: { text: "इस महीने ₹1200 कमाए।" } }, []);
    expect(p.say).toContain("1200");
    expect(p.action).toBeUndefined();
    expect(planReply({ name: "answer", input: { text: "x".repeat(900) } }, []).say.length).toBeLessThanOrEqual(450);
    expect(planReply({ name: "answer", input: {} }, []).say).toContain("बटन");
  });
  it("asks the phone to speak its live next turn", () => {
    expect(planReply({ name: "next_turn", input: {} }, []).action).toEqual({ type: "next_turn" });
    expect(ruleIntent("ab kidhar mudna hai")?.name).toBe("next_turn");
  });
  it("gives the model facts without addresses or phone numbers", () => {
    const ctx = collectorContext({
      now: new Date(NOW),
      month: { kg: 80, payout: 1200, pickups: 9, verifiedPickups: 5 },
      nearby: 3,
      batches: [{ id: "b", status: "ACTIVE", stops: [{ id: "s", status: "EN_ROUTE", address: "221B Secret Road", lat: 1, lng: 2, items: [{ cat: "paper" }], estKg: 4, phone: "9876543210" }] }],
    });
    expect(ctx).toContain("Rs 1200");
    expect(ctx).toContain("[EN_ROUTE] paper");
    expect(ctx).toContain("Unclaimed requests near them: 3");
    expect(ctx).not.toContain("Secret Road");
    expect(ctx).not.toContain("9876543210");
  });
});

describe("household assistant", () => {
  const live = [{ id: "r1", status: "OPEN", items: [{ cat: "paper" }], date: "2026-10-12", slot: "s1618" }];
  it("turns a proposed booking into a confirm-first action", () => {
    const p = planHousehold({ name: "propose_booking", input: { items: [{ cat: "paper", bucket: "5-10" }], date: "2026-10-12", slot: "s1618", say: "Kal shaam 4-6 baje, book karun?" } }, [], NOW);
    expect(p.needsConfirm).toBe(true);
    expect(p.action).toMatchObject({ type: "book", booking: { date: "2026-10-12", slot: "s1618" } });
    expect(p.say).toBe("Kal shaam 4-6 baje, book karun?");
  });
  it("rejects times that have passed, are too far ahead, or are malformed, without proposing", () => {
    const base = { items: [{ cat: "paper", bucket: "2-5" }], slot: "s1012" };
    expect(planHousehold({ name: "propose_booking", input: { ...base, date: "2026-10-11" } }, [], NOW).action).toBeUndefined(); // 10-12am is over at 2pm
    expect(planHousehold({ name: "propose_booking", input: { ...base, date: "2026-10-30" } }, [], NOW).action).toBeUndefined();
    expect(planHousehold({ name: "propose_booking", input: { items: [{ cat: "gold", bucket: "2-5" }], date: "2026-10-12", slot: "s1012" } }, [], NOW).action).toBeUndefined();
    expect(planHousehold(null, [], NOW).action).toBeUndefined();
  });
  it("proposes reschedule and cancel only for pickups that can still move", () => {
    expect(planHousehold({ name: "reschedule", input: { date: "2026-10-13", slot: "s1012" } }, live, NOW).action).toEqual({ type: "reschedule", id: "r1", date: "2026-10-13", slot: "s1012" });
    expect(planHousehold({ name: "cancel_pickup", input: { number: 1 } }, live, NOW).action).toEqual({ type: "cancel", id: "r1" });
    expect(planHousehold({ name: "cancel_pickup", input: {} }, [{ ...live[0]!, status: "PICKED" }], NOW).action).toBeUndefined();
    expect(planHousehold({ name: "cancel_pickup", input: { number: 7 } }, live, NOW).action).toBeUndefined();
  });
  it("keyword fallback books from weights, a day word and a time word", () => {
    const c = ruleHousehold("kal shaam paanch kilo raddi aur do kilo plastic", NOW)!;
    expect(c.name).toBe("propose_booking");
    expect(c.input).toMatchObject({ date: "2026-10-12", slot: "s1618", items: [{ cat: "paper", bucket: "5-10" }, { cat: "plastic", bucket: "2-5" }] });
    expect(ruleHousehold("parso subah 3 kilo loha", NOW)!.input).toMatchObject({ date: "2026-10-13", slot: "s1012" });
    expect(ruleHousehold("meri pickup cancel karo", NOW)!.name).toBe("cancel_pickup");
    expect(ruleHousehold("hello", NOW)).toBeNull();
  });
  it("fallback never picks a slot that is already over today", () => {
    const c = ruleHousehold("aaj subah 2 kilo kagaz", NOW)!; // it is 2pm: this morning is gone
    expect(c.input.date).toBe("2026-10-12");
  });
  it("gives the model the next dates and the user's open pickups only", () => {
    const ctx = householdContext({ requests: live, hasProfile: true, nowMs: NOW });
    expect(ctx).toContain("2026-10-12 Monday (tomorrow)");
    expect(ctx).toContain("#1: OPEN paper on 2026-10-12");
    expect(ctx).not.toContain("r1");
  });
});

describe("nearby board and claiming", () => {
  const me = { Item: { id: "c1", lat: 28.7, lng: 77.1, serviceRadiusKm: 8 } };
  const open = (id: string, lat: number, lng: number, extra = {}) => ({ id, gh5: "x", lat, lng, estKg: 4, items: [{ cat: "paper" }], date: "2099-01-01", slot: "s1012", window: "2099-01-01#s1012", windowStart: 1, ...extra });

  it("lists open requests within the radius, nearest first, hiding contact details", async () => {
    db.on(GetCommand).resolves(me);
    db.on(QueryCommand).resolves({ Items: [open("far", 29.5, 77.1), open("b", 28.72, 77.1, { phone: "9999999999", address: "secret" }), open("a", 28.705, 77.1), open("mine", 28.71, 77.1, { declinedBy: ["c1"] }), open("demo", 28.7, 77.1, { demo: true })] });
    const res = await nearby(ev("c1", "collector"));
    const list = JSON.parse(res.body).requests;
    expect(list.map((r: any) => r.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(list)).not.toMatch(/9999999999|secret/);
  });
  it("uses the phone's position when given", async () => {
    db.on(GetCommand).resolves(me);
    db.on(QueryCommand).resolves({ Items: [open("far", 29.5, 77.1)] });
    const res = await nearby(ev("c1", "collector", {}, {}, { lat: "29.49", lng: "77.1" }));
    expect(JSON.parse(res.body).requests).toHaveLength(1);
  });
  it("claims a free request in one transaction and gives a clean 409 when someone else got it first", async () => {
    db.on(GetCommand, { Key: { PK: "COL#c1", SK: "META" } }).resolves(me);
    db.on(GetCommand, { Key: { PK: "REQ#r1", SK: "META" } }).resolves({ Item: { ...open("r1", 28.705, 77.1), status: "OPEN" } });
    db.on(TransactWriteCommand).resolvesOnce({});
    process.env.USE_LOCATION = "false";
    const ok = await claim(ev("c1", "collector", {}, { id: "r1" }));
    expect(ok.statusCode).toBe(200);
    expect(db.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.some((t) => t.Update?.ConditionExpression === "#s = :o")).toBe(true);
    db.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [] }));
    expect((await claim(ev("c1", "collector", {}, { id: "r1" }))).statusCode).toBe(409);
  });
  it("refuses requests that are not open, that this collector declined, or that are far outside their area", async () => {
    db.on(GetCommand, { Key: { PK: "COL#c1", SK: "META" } }).resolves(me);
    db.on(GetCommand, { Key: { PK: "REQ#t", SK: "META" } }).resolves({ Item: { ...open("t", 28.705, 77.1), status: "ASSIGNED" } });
    expect((await claim(ev("c1", "collector", {}, { id: "t" }))).statusCode).toBe(409);
    db.on(GetCommand, { Key: { PK: "REQ#f", SK: "META" } }).resolves({ Item: { ...open("f", 31, 75.8), status: "OPEN" } });
    expect((await claim(ev("c1", "collector", {}, { id: "f" }))).statusCode).toBe(403);
    expect((await claim(ev("u1", "household", {}, { id: "f" }))).statusCode).toBe(403);
  });
  it("tells a household how far away the kabadiwala is, only while heading to their pickup", async () => {
    const now = Date.now();
    db.on(GetCommand, { Key: { PK: "REQ#r1", SK: "META" } }).resolves({ Item: { id: "r1", userId: "u1", status: "EN_ROUTE", collectorId: "c1", lat: 28.7, lng: 77.1 } });
    db.on(GetCommand, { Key: { PK: "POS#c1", SK: "META" } }).resolves({ Item: { lat: 28.709, lng: 77.1, stopId: "r1", at: now - 1000 } });
    db.on(GetCommand, { Key: { PK: "COL#c1", SK: "META" } }).resolves({ Item: { travelMode: "walking" } });
    const e = JSON.parse((await eta(ev("u1", "household", {}, { id: "r1" }))).body).eta;
    expect(e.distanceKm).toBeGreaterThan(1);
    expect(e.minutes).toBeGreaterThan(10);
    db.on(GetCommand, { Key: { PK: "POS#c1", SK: "META" } }).resolves({ Item: { lat: 28.709, lng: 77.1, stopId: "other", at: now } });
    expect(JSON.parse((await eta(ev("u1", "household", {}, { id: "r1" }))).body).eta).toBeNull();
    expect((await eta(ev("stranger", "household", {}, { id: "r1" }))).statusCode).toBe(404);
  });
});

describe("booking: slots, notes, coverage, reschedule", () => {
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const payload = { items: [{ cat: "paper", bucket: "2-5" }], lat: 28.6, lng: 77.2, address: "12 Main Rd", date: future, slot: "s1416", notes: "ring twice" };

  it("accepts a two-hour slot with a note and records how many collectors can reach it", async () => {
    db.on(QueryCommand).callsFake((i) => (i.IndexName === "GSI2" && i.ExpressionAttributeValues[":p"] === "COLLECTORS" ? { Items: [{ id: "c1", lat: 28.6, lng: 77.2, areas: [], active: true }, { id: "d", demo: true, lat: 28.6, lng: 77.2, areas: [] }, { id: "far", lat: 31, lng: 75, areas: [] }] } : { Items: [] }));
    db.on(PutCommand).resolves({});
    const res = await createRequest(ev("u1", "household", payload));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.notes).toBe("ring twice");
    expect(body.collectorsNearby).toBe(1); // the demo collector and the far one do not count
    const put = db.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(put.window).toBe(`${future}#s1416`);
    expect(put.windowStart).toBe(Date.parse(`${future}T14:00:00+05:30`));
  });
  it("reports zero when nobody covers the address", async () => {
    db.on(QueryCommand).resolves({ Items: [] });
    db.on(PutCommand).resolves({});
    expect(JSON.parse((await createRequest(ev("u1", "household", payload))).body).collectorsNearby).toBe(0);
  });
  it("reschedule re-opens an assigned pickup in the new window", async () => {
    db.on(GetCommand).resolves({ Item: { id: "r1", userId: "u1", status: "ASSIGNED", gh5: "ttng6" } });
    db.on(UpdateCommand).resolves({});
    const res = await reschedule(ev("u1", "household", { date: future, slot: "s1012" }, { id: "r1" }));
    expect(res.statusCode).toBe(200);
    const u = db.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(u.UpdateExpression).toContain("REMOVE batchId, collectorId");
    expect(u.ExpressionAttributeValues![":win"]).toBe(`${future}#s1012`);
    expect(u.ConditionExpression).toContain("#s IN");
  });
  it("reschedule refuses other people's pickups, started pickups and past windows", async () => {
    db.on(GetCommand).resolves({ Item: { id: "r1", userId: "u1", status: "EN_ROUTE" } });
    db.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect((await reschedule(ev("u1", "household", { date: future, slot: "s1012" }, { id: "r1" }))).statusCode).toBe(409);
    expect((await reschedule(ev("intruder", "household", { date: future, slot: "s1012" }, { id: "r1" }))).statusCode).toBe(404);
    expect((await reschedule(ev("u1", "household", { date: "2020-01-01", slot: "s1012" }, { id: "r1" }))).statusCode).toBe(400);
  });
});

describe("collector sign-in with a password, and join requests", () => {
  beforeEach(() => {
    idp.on(AdminCreateUserCommand).resolves({ User: { Attributes: [{ Name: "sub", Value: "new-sub" }] } });
    idp.on(AdminGetUserCommand).resolves({ UserAttributes: [{ Name: "email", Value: "9800000001@collectors.kabadi.invalid" }] });
    idp.on(AdminSetUserPasswordCommand).resolves({});
    idp.on(AdminAddUserToGroupCommand).resolves({});
    idp.on(AdminEnableUserCommand).resolves({});
    db.on(GetCommand).resolves({});
    db.on(UpdateCommand).resolves({});
    db.on(TransactWriteCommand).resolves({});
  });
  const body = { name: "Ramesh", phone: "9800000001", areas: ["ttng6"], lat: 28.7, lng: 77.1 };

  it("an admin can set a password at creation, and it never reaches the stored profile", async () => {
    const res = await createCollector(ev("admin", "admin", { ...body, password: "Str0ngPassw0rd" }));
    expect(res.statusCode).toBe(200);
    expect(idp.commandCalls(AdminSetUserPasswordCommand).some((c) => c.args[0].input.Password === "Str0ngPassw0rd" && c.args[0].input.Permanent)).toBe(true);
    expect(JSON.stringify(db.commandCalls(TransactWriteCommand).map((c) => c.args[0].input))).not.toContain("Str0ngPassw0rd");
  });
  it("rejects weak passwords with a readable message", async () => {
    const res = await createCollector(ev("admin", "admin", { ...body, password: "short" }));
    expect(res.statusCode).toBe(400);
    expect((await ownPassword(ev("c1", "collector", { password: "alllowercase1234" }))).statusCode).toBe(400);
  });
  it("a collector sets only their own password", async () => {
    expect((await ownPassword(ev("c1", "collector", { password: "Str0ngPassw0rd" }))).statusCode).toBe(200);
    expect(idp.commandCalls(AdminSetUserPasswordCommand)[0]!.args[0].input.Username).toBe("c1");
    expect((await ownPassword(ev("u1", "household", { password: "Str0ngPassw0rd" }))).statusCode).toBe(403);
  });
  it("join requests are validated, capped per day, and stored for admin review (no account is created)", async () => {
    db.on(PutCommand).resolves({});
    const ok = await submitJoin({ body: JSON.stringify({ name: "Sunil", phone: "9811111111", area: "Rohini Sector 7" }) });
    expect(ok.statusCode).toBe(200);
    const item = db.commandCalls(PutCommand).at(-1)!.args[0].input.Item!;
    expect(item.PK).toMatch(/^JOIN#/);
    expect(item.ttl).toBeGreaterThan(Date.now() / 1000);
    expect(idp.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
    expect((await submitJoin({ body: JSON.stringify({ name: "S", phone: "123", area: "x" }) })).statusCode).toBe(400);
    expect((await submitJoin({ body: "not json" })).statusCode).toBe(400);
    db.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect((await submitJoin({ body: JSON.stringify({ name: "Sunil", phone: "9811111111", area: "Rohini" }) })).statusCode).toBe(429);
  });
});
