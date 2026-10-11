import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ProfileSchema } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { route } from "../lib/http.js";

const key = (sub: string) => ({ PK: `USER#${sub}`, SK: "PROFILE" });

/** The household's saved address, pin and phone, so the next booking is two taps. */
export const getProfile = route(["household", "admin"], async (c) => {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: key(c.sub) }));
  return { profile: Item ? { address: Item.address, lat: Item.lat, lng: Item.lng, phone: Item.phone } : null };
});

export const putProfile = route(["household", "admin"], async (c) => {
  const b = c.body(ProfileSchema);
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { ...key(c.sub), ...b } }));
  return { ok: true };
});
