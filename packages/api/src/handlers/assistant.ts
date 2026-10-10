import { z } from "zod";
import { ItemsSchema } from "@kc/shared";
import { toolCall } from "../lib/bedrock.js";
import { labelItems } from "../lib/labels.js";
import { HttpError, route } from "../lib/http.js";
import { focusStop, planReply, ruleIntent, SYSTEM, TOOLS, UNCLEAR } from "../lib/intent.js";
import { takeQuota } from "../lib/quota.js";
import { synthesize, transcribe } from "../lib/speech.js";
import { loadBatches } from "./collector.js";

const AssistantSchema = z
  .object({
    // 16 kHz mono WAV, base64. ~30 s max.
    audio: z.string().max(1_400_000).optional(),
    text: z.string().max(300).optional(),
    focusStopId: z.string().max(64).optional(),
    // Yes/no answers are matched on the phone: just return the transcript, no model call.
    transcribeOnly: z.boolean().optional(),
  })
  .refine((b) => b.audio || b.text, "audio or text required");

/** Spoken reply for a failed or empty turn must never block the buttons, so speech errors are non-fatal. */
async function speak(text: string) {
  try {
    return await synthesize(text);
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "tts failed", reason: (e as Error).message }));
    return null;
  }
}

/** Voice turn: speech -> intent (Bedrock) -> Hindi reply + proposed action. The phone performs the action after "haan". */
export const assistant = route(["collector"], async (c) => {
  const b = c.body(AssistantSchema);
  await takeQuota(c.sub, "assistant", c.groups.includes("demo") ? 30 : 200);

  let heard = b.text?.trim() ?? "";
  let sttProvider: string | undefined;
  if (!heard) {
    try {
      const t = await transcribe(Buffer.from(b.audio!, "base64"));
      heard = t.text;
      sttProvider = t.provider;
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "stt failed", reason: (e as Error).message }));
    }
  }

  if (b.transcribeOnly) return { heard };

  let plan = { say: UNCLEAR } as ReturnType<typeof planReply>;
  let intentVia: string | undefined;
  if (heard) {
    const batches = await loadBatches(c.sub);
    const focus = focusStop(batches, b.focusStopId);
    let via = "model";
    let call;
    try {
      call = await toolCall({
        system: [{ text: SYSTEM }],
        messages: [{ role: "user", content: [{ text: `Current stop status: ${focus?.status ?? "none"}. Said: ${heard}` }] }],
        toolConfig: TOOLS as any,
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      });
    } catch (e) {
      // Model unavailable (access, throttling): keyword rules still cover the common phrases.
      console.error(JSON.stringify({ level: "error", msg: "bedrock failed, using rules", reason: (e as Error).message }));
      call = ruleIntent(heard);
      via = "rules";
    }
    plan = planReply(call, batches, b.focusStopId);
    intentVia = via;
  }
  const spoken = await speak(plan.say);
  console.log(JSON.stringify({ level: "info", msg: "assistant", stt: sttProvider, tts: spoken?.provider, via: intentVia, action: plan.action?.type }));
  return { heard, ...plan, via: intentVia, audio: spoken?.audio, audioMime: spoken?.mime };
});

/** Read any short text aloud (the Sunao buttons and fixed prompts). */
export const speakText = route(["collector"], async (c) => {
  const { text } = c.body(z.object({ text: z.string().trim().min(1).max(300) }));
  await takeQuota(c.sub, "assistant", c.groups.includes("demo") ? 30 : 200);
  const spoken = await speak(text);
  if (!spoken) throw new HttpError(502, "speech unavailable");
  return { audio: spoken.audio, audioMime: spoken.mime };
});

const PHOTO_PROMPT = `Look at this photo of household recyclable waste in India. Report what materials are visible and a rough weight bucket for each, using the report tool. Materials: paper (newspaper, cardboard), plastic, metal (tin, iron, aluminium, steel), ewaste (electronics, cables, batteries), glass. Buckets: "<2", "2-5", "5-10", "10+" kg. Only include materials you can actually see. If the photo shows no recyclables, report an empty list.`;

/** Household photo -> suggested categories and weight buckets. The image is never stored. */
export const estimatePhoto = route(["household", "admin"], async (c) => {
  const { image } = c.body(z.object({ image: z.string().max(3_000_000) }));
  await takeQuota(c.sub, "photo", 20);
  const bytes = Buffer.from(image, "base64");
  let items: unknown;
  let note = "";
  let via = "model";
  try {
    const call = await toolCall({
      messages: [
        {
          role: "user",
          content: [{ image: { format: "jpeg", source: { bytes } } }, { text: PHOTO_PROMPT }],
        },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "report",
              description: "Materials seen with rough weight buckets",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          cat: { type: "string", enum: ["paper", "plastic", "metal", "ewaste", "glass"] },
                          bucket: { type: "string", enum: ["<2", "2-5", "5-10", "10+"] },
                        },
                        required: ["cat", "bucket"],
                      },
                    },
                    note: { type: "string" },
                  },
                  required: ["items"],
                },
              },
            },
          },
        ],
        toolChoice: { tool: { name: "report" } },
      } as any,
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    });
    items = call?.input.items;
    note = typeof call?.input.note === "string" ? call.input.note.slice(0, 200) : "";
  } catch (e) {
    // Model unavailable (access, throttling): fall back to image labels.
    console.error(JSON.stringify({ level: "error", msg: "photo model failed, using rekognition", reason: (e as Error).message }));
    via = "rekognition";
    items = await labelItems(bytes).catch((e2) => {
      console.error(JSON.stringify({ level: "error", msg: "rekognition failed", reason: (e2 as Error).message }));
      throw new HttpError(503, "photo estimate temporarily unavailable");
    });
    note = "Recognised from photo labels. Please check the weights.";
  }
  console.log(JSON.stringify({ level: "info", msg: "photo", via }));
  const parsed = ItemsSchema.safeParse(items);
  if (!parsed.success) throw new HttpError(422, "could not recognise recyclables in this photo");
  return { items: parsed.data, note };
});
