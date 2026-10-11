import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const TABLE = () => process.env.TABLE ?? "kabadi";
export const NINETY_DAYS_S = 90 * 24 * 3600;

type Item = Record<string, any>;

/** Query that follows LastEvaluatedKey until the result is complete. */
export async function queryAll(params: ConstructorParameters<typeof QueryCommand>[0]): Promise<Item[]> {
  const out: Item[] = [];
  let key: Record<string, any> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: key }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}
