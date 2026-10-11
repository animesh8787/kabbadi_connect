import { CalculateRoutesCommand, GeoRoutesClient } from "@aws-sdk/client-geo-routes";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { maneuversOf, type LngLat } from "@kc/shared";
import { ddb, TABLE } from "../lib/ddb.js";
import { HttpError, route } from "../lib/http.js";
import { takeQuota } from "../lib/quota.js";

const client = new GeoRoutesClient({ region: process.env.ROUTES_REGION || process.env.AWS_REGION });

/**
 * Turn-by-turn route from where the collector is now to one of their stops.
 * The route line comes from Amazon Location; each turn's left/right is measured from that line so the
 * phone can speak it in any language without depending on the API's wording.
 */
export const routeTo = route(["collector"], async (c) => {
  const q = c.event.queryStringParameters ?? {};
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (!q.stopId || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "stopId, lat and lng are required");

  const [{ Item: r }, { Item: me }] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `REQ#${q.stopId}`, SK: "META" } })),
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `COL#${c.sub}`, SK: "META" } })),
  ]);
  // Only a stop assigned to this collector: no routing to other people's addresses.
  if (!r || r.collectorId !== c.sub) throw new HttpError(404, "not found");
  await takeQuota(c.sub, "route", 300);

  const res = await client.send(
    new CalculateRoutesCommand({
      Origin: [lng, lat],
      Destination: [r.lng, r.lat],
      TravelMode: me?.travelMode === "scooter" ? "Scooter" : "Pedestrian",
      TravelStepType: "TurnByTurn",
      LegGeometryFormat: "Simple",
    }),
  );
  const leg = res.Routes?.[0]?.Legs?.[0];
  const line = (leg?.Geometry?.LineString ?? []) as LngLat[];
  if (line.length < 2) throw new HttpError(502, "no route found");
  const details: any = leg?.PedestrianLegDetails ?? leg?.VehicleLegDetails;
  const maneuvers = maneuversOf(line, details?.TravelSteps ?? []);
  return {
    line,
    maneuvers,
    distanceM: Math.round(details?.Summary?.Overview?.Distance ?? 0),
    durationS: Math.round(details?.Summary?.Overview?.Duration ?? 0),
  };
});
