import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./ddb.js";
import { HttpError } from "./http.js";
import { istDate } from "./time.js";

/** Count one use of a paid feature (Bedrock, speech) per user per day; 429 once the cap is reached. */
export async function takeQuota(sub: string, kind: string, max: number): Promise<void> {
  const now = Date.now();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `QUOTA#${sub}`, SK: `${kind}#${istDate(now)}` },
        UpdateExpression: "ADD n :one SET #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(n) OR n < :max",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":max": max, ":ttl": Math.floor(now / 1000) + 3 * 24 * 3600 },
      }),
    );
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new HttpError(429, "daily limit reached");
    throw e;
  }
}
