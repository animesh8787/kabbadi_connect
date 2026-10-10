import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { releaseStale } from "../src/handlers/dispatch.js";
import { planBatches } from "../src/lib/batching.js";

const db = mockClient(DynamoDBDocumentClient);
beforeEach(() => db.reset());

const HOUR = 3600_000;
const now = Date.parse("2026-10-10T12:00:00Z");
const staleBatch = { id: "b1", collectorId: "c1", stops: ["r1", "r2"] };
const req = (id: string, over = {}) => ({ id, status: "ASSIGNED", collectorId: "c1", windowStart: now - 3 * HOUR, gh5: "ttng6", ...over });

describe("re-offering stale batches", () => {
  it("queries only batches whose window opened more than two hours ago", async () => {
    db.on(QueryCommand).resolves({ Items: [] });
    expect(await releaseStale(now)).toBe(0);
    const v = db.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues!;
    expect(v[":p"]).toBe("PENDING_BATCH");
    expect(v[":t"]).toBe(`${now - 2 * HOUR}~`);
  });
  it("reopens still-assigned requests, remembers the collector, and expires the batch in one transaction", async () => {
    db.on(QueryCommand).resolves({ Items: [staleBatch] });
    db.on(BatchGetCommand).resolves({ Responses: { kabadi: [req("r1"), req("r2", { status: "CANCELLED" })] } });
    db.on(TransactWriteCommand).resolves({});
    process.env.TABLE = "kabadi";
    expect(await releaseStale(now)).toBe(1);
    const items = db.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2); // batch + only the still-assigned request
    expect(items[0]!.Update!.ExpressionAttributeValues![":x"]).toBe("EXPIRED");
    expect(items[1]!.Update!.UpdateExpression).toContain("declinedBy");
    expect(items[1]!.Update!.ExpressionAttributeValues![":c"]).toEqual(["c1"]);
  });
  it("leaves the batch alone if it changed meanwhile", async () => {
    db.on(QueryCommand).resolves({ Items: [staleBatch] });
    db.on(BatchGetCommand).resolves({ Responses: { kabadi: [req("r1")] } });
    db.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [] }));
    expect(await releaseStale(now)).toBe(0);
  });
});

describe("planBatches with declined collectors", () => {
  const col = (id: string) => ({ id, areas: ["ttng6"], active: true, lat: 28.7, lng: 77.1 });
  const r = (id: string, declined?: string[]) => ({ id, gh5: "ttng6", window: "2026-10-10#morning", windowStart: now - HOUR, estKg: 20, lat: 28.7, lng: 77.1, declined });

  it("gives a reopened request to a different collector", () => {
    const plans = planBatches([r("r1", ["c1"])], [col("c1"), col("c2")], now);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.collectorId).toBe("c2");
  });
  it("keeps it open when the only collector already declined it", () => {
    expect(planBatches([r("r1", ["c1"])], [col("c1")], now)).toEqual([]);
  });
  it("does not mix requests with different decline lists in one batch", () => {
    const plans = planBatches([r("a"), r("b", ["c1"])], [col("c1"), col("c2")], now);
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.requestIds.includes("b"))!.collectorId).toBe("c2");
  });
});
