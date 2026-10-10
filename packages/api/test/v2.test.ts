import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { create, define, hashCode, verify } from "../src/handlers/customAuth.js";
import { buildLedger } from "../src/handlers/collector.js";
import { focusStop, parseWeights, planReply, ruleIntent, type BatchView } from "../src/lib/intent.js";
import { itemsFromLabels } from "../src/lib/labels.js";
import { pcmOf } from "../src/lib/speech.js";
import { takeQuota } from "../src/lib/quota.js";

const db = mockClient(DynamoDBDocumentClient);
beforeEach(() => db.reset());

const verifyEvent = (answer: string): any => ({ request: { challengeAnswer: answer, userAttributes: { sub: "c1" } }, response: {} });

describe("collector card login", () => {
  const good = "abc123";
  const item = (over = {}) => ({ Item: { enrollHash: hashCode(good), enrollExp: Date.now() + 60_000, ...over } });

  it("accepts the right code once and consumes it", async () => {
    db.on(GetCommand).resolves(item());
    db.on(UpdateCommand).resolves({});
    expect((await verify(verifyEvent(good))).response.answerCorrect).toBe(true);
    expect(db.commandCalls(UpdateCommand)[0]!.args[0].input.ConditionExpression).toBe("enrollHash = :h");
  });
  it("rejects a wrong code without consuming the card", async () => {
    db.on(GetCommand).resolves(item());
    expect((await verify(verifyEvent("nope"))).response.answerCorrect).toBe(false);
    expect(db.commandCalls(UpdateCommand)).toHaveLength(0);
  });
  it("rejects an expired card and a revoked card", async () => {
    db.on(GetCommand).resolves(item({ enrollExp: Date.now() - 1 }));
    expect((await verify(verifyEvent(good))).response.answerCorrect).toBe(false);
    db.on(GetCommand).resolves({ Item: {} });
    expect((await verify(verifyEvent(good))).response.answerCorrect).toBe(false);
  });
  it("loses a race: second use of the same code fails", async () => {
    db.on(GetCommand).resolves(item());
    db.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect((await verify(verifyEvent(good))).response.answerCorrect).toBe(false);
  });
  it("define/create drive a single challenge then issue tokens, failing after 3 misses", async () => {
    const ev = (session: any[]): any => ({ request: { session }, response: {} });
    expect((await define(ev([]))).response.challengeName).toBe("CUSTOM_CHALLENGE");
    expect((await define(ev([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }]))).response.issueTokens).toBe(true);
    const miss = { challengeName: "CUSTOM_CHALLENGE", challengeResult: false };
    expect((await define(ev([miss, miss, miss]))).response.failAuthentication).toBe(true);
    expect((await create({ request: {}, response: {} } as any)).response.publicChallengeParameters).toBeTruthy();
  });
});

describe("assistant intent mapping", () => {
  const stop = (id: string, status: string, extra = {}) => ({ id, status, address: `Addr ${id}`, lat: 1, lng: 2, items: [{ cat: "paper" as const }], estKg: 5, ...extra });
  const batches: BatchView[] = [{ id: "b1", status: "ACTIVE", stops: [stop("s1", "PICKED"), stop("s2", "EN_ROUTE", { phone: "9800000001" }), stop("s3", "EN_ROUTE")] }];

  it("focuses the stop on screen, else the one in progress", () => {
    expect(focusStop(batches, "s3")?.id).toBe("s3");
    expect(focusStop(batches)?.id).toBe("s2");
    expect(focusStop(batches, "s1")?.id).toBe("s2"); // finished stops are not focusable
  });
  it("read-only intents need no confirmation", () => {
    const p = planReply({ name: "next_stop", input: {} }, batches);
    expect(p.needsConfirm).toBeUndefined();
    expect(p.say).toContain("Addr s2");
    expect(planReply({ name: "today_summary", input: {} }, batches).say).toContain("3");
  });
  it("confirm_pickup proposes the action but never executes, and requires yes", () => {
    const p = planReply({ name: "confirm_pickup", input: { items: [{ cat: "paper", kg: 2.5 }], segregation: "good" } }, batches);
    expect(p.needsConfirm).toBe(true);
    expect(p.action).toEqual({ type: "confirm", stopId: "s2", items: [{ cat: "paper", actualKg: 2.5 }], segregation: "good" });
  });
  it("rejects nonsense weights and unknown materials from the model", () => {
    expect(planReply({ name: "confirm_pickup", input: { items: [{ cat: "paper", kg: -3 }] } }, batches).action).toBeUndefined();
    expect(planReply({ name: "confirm_pickup", input: { items: [{ cat: "gold", kg: 3 }] } }, batches).action).toBeUndefined();
    expect(planReply({ name: "confirm_pickup", input: { items: [{ cat: "paper", kg: 5000 }] } }, batches).action).toBeUndefined();
  });
  it("needs a started pickup for confirm and not-home; unknown tools degrade to the buttons message", () => {
    const waiting: BatchView[] = [{ id: "b", status: "ASSIGNED", stops: [stop("a", "ASSIGNED")] }];
    expect(planReply({ name: "confirm_pickup", input: { items: [{ cat: "paper", kg: 1 }] } }, waiting).action).toBeUndefined();
    expect(planReply({ name: "start_batch", input: {} }, waiting).action).toEqual({ type: "start", batchId: "b" });
    expect(planReply({ name: "mark_not_home", input: {} }, waiting).action).toBeUndefined();
    expect(planReply({ name: "delete_everything", input: {} }, waiting).action).toBeUndefined();
    expect(planReply(null, waiting).say).toContain("बटन");
  });
  it("calls the household only when a number exists", () => {
    expect(planReply({ name: "call_household", input: {} }, batches).action).toEqual({ type: "call", phone: "9800000001" });
    expect(planReply({ name: "call_household", input: {} }, [{ id: "b", status: "ACTIVE", stops: [stop("x", "EN_ROUTE")] }]).action).toBeUndefined();
  });
});

describe("speech helpers", () => {
  it("strips the WAV header and rejects non-WAV input", () => {
    const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(16), Buffer.from("data"), Buffer.from([4, 0, 0, 0]), Buffer.from([1, 2, 3, 4])]);
    expect([...pcmOf(wav)]).toEqual([1, 2, 3, 4]);
    expect(() => pcmOf(Buffer.from("hello"))).toThrow();
  });
});

describe("quota", () => {
  it("allows under the cap and returns 429 at the cap", async () => {
    db.on(UpdateCommand).resolvesOnce({});
    await expect(takeQuota("u", "photo", 20)).resolves.toBeUndefined();
    db.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    await expect(takeQuota("u", "photo", 20)).rejects.toMatchObject({ status: 429 });
  });
});

describe("ledger", () => {
  it("totals kg, money, verified count and segregation without exposing addresses", async () => {
    db.on(QueryCommand).resolves({
      Items: [
        { pickedAt: Date.parse("2026-10-05T10:00:00+05:30"), actual: [{ cat: "paper", kg: 5 }, { cat: "metal", kg: 1.5 }], payout: 90, co2Kg: 21, householdAck: true, segregation: "good", address: "secret" },
        { pickedAt: Date.parse("2026-10-06T10:00:00+05:30"), actual: [{ cat: "paper", kg: 2 }], payout: 24, co2Kg: 6, segregation: "mixed", address: "secret" },
      ],
    });
    db.on(GetCommand).resolves({ Item: { name: "Ramesh", phone: "9800000001" } });
    const l = await buildLedger("c1", "2026-10");
    expect(l).toMatchObject({ pickups: 2, verifiedPickups: 1, kg: 8.5, payout: 114, co2Kg: 27, segregationGoodPct: 50, byCategory: { paper: 7, metal: 1.5 } });
    expect(JSON.stringify(l)).not.toContain("secret");
    const range = db.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues!;
    expect(range[":a"] < range[":b"]).toBe(true);
  });
});

describe("keyword fallback", () => {
  it("parses Hindi and Hinglish weights, number words and half values", () => {
    expect(parseWeights("paanch kilo kagaz aur do kilo loha")).toEqual([{ cat: "paper", kg: 5 }, { cat: "metal", kg: 2 }]);
    expect(parseWeights("पाँच किलो कागज़")).toEqual([{ cat: "paper", kg: 5 }]);
    expect(parseWeights("kagaz 2.5 kilo")).toEqual([{ cat: "paper", kg: 2.5 }]);
    expect(parseWeights("dhai kilo plastic")).toEqual([{ cat: "plastic", kg: 2.5 }]);
    expect(parseWeights("sade teen kilo kaanch")).toEqual([{ cat: "glass", kg: 3.5 }]);
    expect(parseWeights("kuch nahi")).toEqual([]);
  });
  it("maps common phrases to intents and weights to confirm_pickup", () => {
    expect(ruleIntent("agla ghar kahan hai")?.name).toBe("next_stop");
    expect(ruleIntent("aaj kitne pickup hain")?.name).toBe("today_summary");
    expect(ruleIntent("चलो शुरू करो")?.name).toBe("start_batch");
    expect(ruleIntent("ghar par koi nahi")?.name).toBe("mark_not_home");
    expect(ruleIntent("rasta batao")?.name).toBe("navigate");
    expect(ruleIntent("blah blah")).toBeNull();
    expect(ruleIntent("5 kilo kagaz achha alag tha")).toEqual({ name: "confirm_pickup", input: { items: [{ cat: "paper", kg: 5 }], segregation: "good" } });
  });
});

describe("wider keyword coverage", () => {
  it("handles more number words, grams and kabaad words", () => {
    expect(parseWeights("pandrah kilo botalein")).toEqual([{ cat: "plastic", kg: 15 }]);
    expect(parseWeights("aadha kilo taar")).toEqual([{ cat: "ewaste", kg: 0.5 }]);
    expect(parseWeights("500 gram kagaz")).toEqual([{ cat: "paper", kg: 0.5 }]);
    expect(parseWeights("sariya 250 gram")).toEqual([{ cat: "metal", kg: 0.25 }]);
    expect(parseWeights("paav kilo battery")).toEqual([{ cat: "ewaste", kg: 0.25 }]);
  });
  it("hears more phrasings of each intent", () => {
    const name = (s: string) => ruleIntent(s)?.name;
    expect(name("aage kahan jana hai")).toBe("next_stop");
    expect(name("aaj kitna kamaya")).toBe("today_summary");
    expect(name("kitna hua")).toBe("today_summary");
    expect(name("start karo")).toBe("start_batch");
    expect(name("darwaza band hai")).toBe("mark_not_home");
    expect(name("number lagao")).toBe("call_household");
    expect(name("map dikhao")).toBe("navigate");
  });
});

describe("photo label fallback", () => {
  it("maps Rekognition labels and their parents to materials, one bucket each", () => {
    const items = itemsFromLabels([
      { Name: "Newspaper" },
      { Name: "Water Bottle", Parents: [{ Name: "Bottle" }] },
      { Name: "Laptop" },
      { Name: "House" },
    ]);
    expect(items).toEqual([
      { cat: "paper", bucket: "2-5" },
      { cat: "plastic", bucket: "2-5" },
      { cat: "ewaste", bucket: "2-5" },
    ]);
    expect(itemsFromLabels([{ Name: "Sky" }, { Name: "Tree" }])).toEqual([]);
  });
});
