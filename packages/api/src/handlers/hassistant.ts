import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ddb, TABLE } from "../lib/ddb.js";
import { route } from "../lib/http.js";
import { HOUSEHOLD_SYSTEM, HOUSEHOLD_TOOLS, householdContext, planHousehold, ruleHousehold } from "../lib/household.js";
import { historyText } from "../lib/intent.js";
import { chooseTool } from "../lib/llm.js";
import { takeQuota } from "../lib/quota.js";
import { transcribe } from "../lib/speech.js";
import { HistorySchema, speak } from "./assistant.js";

const Body = z
  .object({
    audio: z.string().max(1_400_000).optional(),
    text: z.string().max(400).optional(),
    history: HistorySchema,
    // Read the reply aloud (for someone who cannot read well); typing users leave it off.
    speak: z.boolean().optional(),
  })
  .refine((b) => b.audio || b.text, "audio or text required");

/** Household chat: typed or spoken. Answers questions and proposes bookings; every change needs a tap in the app. */
export const householdAssistant = route(["household", "admin"], async (c) => {
  const b = c.body(Body);
  await takeQuota(c.sub, "hassistant", 50);
  const nowMs = Date.now();

  let heard = b.text?.trim() ?? "";
  if (!heard && b.audio) {
    try {
      heard = (await transcribe(Buffer.from(b.audio, "base64"))).text;
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "household stt failed", reason: (e as Error).message }));
    }
  }
  if (!heard) return { heard: "", say: "I could not hear that. Please try again. / सुनाई नहीं दिया, फिर बोलिए।" };

  const [mine, profile] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: "GSI3",
        KeyConditionExpression: "GSI3PK = :u",
        ExpressionAttributeValues: { ":u": `USER#${c.sub}` },
        ScanIndexForward: false,
        Limit: 20,
      }),
    ),
    ddb.send(new GetCommand({ TableName: TABLE(), Key: { PK: `USER#${c.sub}`, SK: "PROFILE" } })),
  ]);
  const reqs = (mine.Items ?? []).map((r) => ({ id: r.id as string, status: r.status as string, items: r.items as { cat: string }[], date: r.date as string, slot: r.slot as string }));
  const ctx = householdContext({ requests: reqs, hasProfile: !!profile.Item, nowMs });
  const hist = historyText(b.history);
  const user = `CONTEXT:\n${ctx}\n\n${hist ? `CONVERSATION SO FAR:\n${hist}\n\n` : ""}USER SAID: ${heard}`;

  const chosen = await chooseTool({ system: HOUSEHOLD_SYSTEM, user, tools: HOUSEHOLD_TOOLS, smart: true });
  let via: string = chosen.via;
  let call = chosen.call;
  if (!call) {
    call = ruleHousehold(heard, nowMs);
    via = "rules";
  }
  const plan = planHousehold(call, reqs, nowMs);
  const spoken = b.speak ? await speak(plan.say) : null;
  console.log(JSON.stringify({ level: "info", msg: "household assistant", via, action: plan.action?.type }));
  return { heard, ...plan, via, audio: spoken?.audio, audioMime: spoken?.mime };
});
