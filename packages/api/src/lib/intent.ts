import { CATEGORIES, ConfirmSchema, ewaste, factors, type Category } from "@kc/shared";
import type { ToolCall } from "./bedrock.js";
import { tool, type ToolDef } from "./llm.js";

/**
 * Turns a model tool call into what the phone should say and do. The model only picks the intent and
 * reads out numbers; every spoken sentence is built here from real data, so it cannot invent facts,
 * and nothing is changed until the collector says yes (the client then calls the normal API).
 */
export interface StopView {
  id: string;
  status: string;
  address: string;
  lat: number;
  lng: number;
  items: { cat: Category }[];
  estKg: number;
  phone?: string;
}
export interface BatchView {
  id: string;
  status: string;
  stops: StopView[];
}

export type Action =
  | { type: "focus"; stopId: string }
  | { type: "start"; batchId: string }
  | { type: "confirm"; stopId: string; items: { cat: Category; actualKg: number }[]; segregation?: "good" | "mixed" }
  | { type: "missed"; stopId: string }
  | { type: "call"; phone: string }
  | { type: "navigate"; lat: number; lng: number }
  /** The phone answers from its live navigation state ("ab kidhar mudna hai"). */
  | { type: "next_turn" };

export interface Plan {
  say: string;
  action?: Action;
  needsConfirm?: boolean;
}

export const CAT_HI: Record<Category, string> = {
  paper: "कागज़",
  plastic: "प्लास्टिक",
  metal: "धातु",
  ewaste: "ई-वेस्ट",
  glass: "काँच",
};
export const UNCLEAR = "समझ नहीं आया। कृपया बटन दबाइए।";

const live = (s: StopView) => s.status === "ASSIGNED" || s.status === "EN_ROUTE";
const itemsHi = (s: StopView) => s.items.map((i) => CAT_HI[i.cat]).join(", ");

/** The stop the collector means: the one on screen, else the one in progress, else the next waiting one. */
export function focusStop(batches: BatchView[], focusId?: string): StopView | undefined {
  const all = batches.flatMap((b) => b.stops);
  return all.find((s) => s.id === focusId && live(s)) ?? all.find((s) => s.status === "EN_ROUTE") ?? all.find((s) => s.status === "ASSIGNED");
}

export function planReply(call: ToolCall | null, batches: BatchView[], focusId?: string): Plan {
  if (!call || call.name === "unclear") return { say: UNCLEAR };
  const stop = focusStop(batches, focusId);
  const all = batches.flatMap((b) => b.stops);
  const inProgress = stop?.status === "EN_ROUTE" ? stop : undefined;

  switch (call.name) {
    case "today_summary": {
      const open = all.filter(live);
      const done = all.filter((s) => s.status === "PICKED").length;
      if (!all.length) return { say: "आज कोई पिकअप नहीं है।" };
      const kg = Math.round(open.reduce((s, x) => s + x.estKg, 0));
      return { say: `आज ${all.length} पिकअप हैं। ${done} हो चुकी हैं, ${open.length} बाकी हैं, लगभग ${kg} किलो।` };
    }
    case "answer": {
      // A free-form reply the model wrote from the context it was given; capped, never an action.
      const text = typeof call.input.text === "string" ? call.input.text.trim().slice(0, 450) : "";
      return { say: text || UNCLEAR };
    }
    case "next_turn":
      return { say: "", action: { type: "next_turn" } };
    case "next_stop":
      if (!stop) return { say: "अभी कोई पिकअप बाकी नहीं है।" };
      return { say: `अगला पता: ${stop.address}। ${itemsHi(stop)}। लगभग ${Math.round(stop.estKg)} किलो।`, action: { type: "focus", stopId: stop.id } };
    case "start_batch": {
      const b = batches.find((x) => x.status === "ASSIGNED" && x.stops.some(live));
      if (!b) return { say: "शुरू करने के लिए कोई नई पिकअप नहीं है।" };
      return { say: `${b.stops.filter(live).length} पिकअप शुरू करूँ? हाँ बोलिए।`, action: { type: "start", batchId: b.id }, needsConfirm: true };
    }
    case "confirm_pickup": {
      if (!inProgress) return { say: "पहले पिकअप शुरू कीजिए।" };
      const parsed = ConfirmSchema.safeParse({
        items: Array.isArray(call.input.items) ? call.input.items.map((i: any) => ({ cat: i?.cat, actualKg: Number(i?.kg) })) : [],
        segregation: call.input.segregation,
      });
      if (!parsed.success || parsed.data.items.every((i) => i.actualKg <= 0)) return { say: "वज़न समझ नहीं आया। फिर से बोलिए।" };
      const said = parsed.data.items.map((i) => `${i.actualKg} किलो ${CAT_HI[i.cat]}`).join(", ");
      return {
        say: `${said}। सही है? हाँ बोलिए।`,
        action: { type: "confirm", stopId: inProgress.id, items: parsed.data.items, segregation: parsed.data.segregation },
        needsConfirm: true,
      };
    }
    case "mark_not_home":
      if (!inProgress) return { say: "पहले पिकअप शुरू कीजिए।" };
      return { say: "घर पर कोई नहीं है, ठीक है? हाँ बोलिए।", action: { type: "missed", stopId: inProgress.id }, needsConfirm: true };
    case "call_household":
      if (!stop?.phone) return { say: "इस पते का फ़ोन नंबर नहीं है।" };
      return { say: "फ़ोन लगा रहा हूँ।", action: { type: "call", phone: stop.phone } };
    case "navigate":
      if (!stop) return { say: "अभी कोई पिकअप बाकी नहीं है।" };
      return { say: "रास्ता खोल रहा हूँ।", action: { type: "navigate", lat: stop.lat, lng: stop.lng } };
    default:
      return { say: UNCLEAR };
  }
}

const catList = CATEGORIES.join("|");

export const SYSTEM = `You are the voice assistant of Kabadi Connect for an Indian kabadiwala (scrap collector). They speak Hindi, Hinglish or Devanagari, often with street noise, so the transcript may be imperfect.
Always call exactly one tool. Never write plain text outside a tool.
- If they ask a question (earnings, rates, how to sort, where to take e-waste, how many pickups, what is next, anything about their work), call answer with a short, friendly reply in their language (Devanagari Hindi unless they wrote English). Use ONLY the facts in CONTEXT. If the fact is not there, say you do not know. Never invent amounts, addresses or names, and never read out phone numbers.
- If they want to do something, call the matching tool: next_stop ("agla ghar"), today_summary ("kitne pickup"), start_batch ("shuru karo"), confirm_pickup (they report weights collected), mark_not_home ("ghar par koi nahi"), call_household ("phone lagao"), navigate ("rasta batao", "map kholo"), next_turn ("ab kidhar mudna hai", "aage kahan").
- If it is not about their work or too garbled, call answer asking them to repeat.
Materials: ${catList}. Map kagaz/raddi/gatta/akhbaar -> paper; plastic/botal/dibba -> plastic; loha/lohe/tin/dhatu/steel/peetal -> metal; e-waste/bijli ka saman/mobile/charger/computer -> ewaste; kaanch/sheesha/bottle of glass -> glass.
Weights are kilograms: "dhai"=2.5, "dedh"=1.5, "paune do"=1.75, "sade teen"=3.5, "paanch"=5, "das"=10. Gram values convert to kg. Use only numbers the speaker said.
segregation: "good" if they say the waste was well sorted ("achha alag kiya"), "mixed" if mixed or dirty ("mix tha", "ganda"); omit otherwise.`;

const itemsSchema = {
  type: "array",
  items: { type: "object", properties: { cat: { type: "string", enum: [...CATEGORIES] }, kg: { type: "number" } }, required: ["cat", "kg"] },
};

export const COLLECTOR_TOOLS: ToolDef[] = [
  tool("answer", "Reply to a question or small talk using only the CONTEXT", { type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
  tool("next_stop", "Read the next pickup"),
  tool("today_summary", "Summary of today's pickups"),
  tool("start_batch", "Start today's route"),
  tool("confirm_pickup", "Record the weights collected at the current stop", {
    type: "object",
    properties: { items: itemsSchema, segregation: { type: "string", enum: ["good", "mixed"] } },
    required: ["items"],
  }),
  tool("mark_not_home", "Nobody home at the current stop"),
  tool("call_household", "Call the household at the current stop"),
  tool("navigate", "Open turn-by-turn directions to the current stop"),
  tool("next_turn", "Say the next turn of the route being navigated"),
];

/** Short sorting advice the assistants can quote; kept in step with the guide in the app. */
export const SORT_TIPS = {
  paper: "Dry and flat. Newspapers, cardboard, books. Not greasy boxes.",
  plastic: "Rinse bottles and containers; keep caps and bags separate.",
  metal: "Tins, iron, steel, brass. Wrap sharp pieces.",
  ewaste: "Phones, chargers, cables, batteries: never in the bin. Give them to a collector who takes them to an authorised recycler.",
  glass: "Rinsed bottles and jars. Wrap broken glass in paper.",
} as const;

export const referenceFacts = () =>
  [
    `Default rates (Rs per kg): ${CATEGORIES.map((c) => `${c} ${factors.ratePerKg[c]}`).join(", ")} (as of ${factors.ratesAsOf}; collectors may post their own).`,
    `Sorting tips: ${CATEGORIES.map((c) => `${c}: ${SORT_TIPS[c]}`).join(" ")}`,
    `Authorised e-waste recyclers in Delhi (2023 list): ${ewaste.recyclers.map((r) => r.name).join("; ")}.`,
  ].join("\n");

/** What the collector assistant may use to answer. Stops are numbered, not addressed; no phone numbers. */
export function collectorContext(o: { batches: BatchView[]; month?: { kg: number; payout: number; pickups: number; verifiedPickups: number }; nearby?: number; now: Date }): string {
  const stops = o.batches.flatMap((b) => b.stops.map((s) => ({ s, batch: b.status })));
  const lines = stops.map(({ s }, i) => `${i + 1}) [${s.status}] ${s.items.map((x) => x.cat).join("+")} ~${Math.round(s.estKg)} kg`);
  return [
    `Now (IST): ${new Date(o.now.getTime() + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16)}`,
    stops.length ? `Today's stops in route order:\n${lines.join("\n")}` : "No pickups assigned today.",
    o.month ? `This month: ${o.month.pickups} pickups, ${o.month.kg} kg collected, Rs ${o.month.payout} earned, ${o.month.verifiedPickups} confirmed by households.` : "",
    o.nearby !== undefined ? `Unclaimed requests near them: ${o.nearby}.` : "",
    referenceFacts(),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The last few turns, so "and the day before?" makes sense. Plain text: works the same for every provider. */
export function historyText(history: { role: "user" | "assistant"; text: string }[] | undefined): string {
  return (history ?? [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text.slice(0, 300)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Offline fallback: keyword intents for when the model is unavailable. Covers the common phrases only;
// the model handles messy or unusual speech.

const NUM: Record<string, number> = {
  एक: 1, ek: 1, दो: 2, do: 2, तीन: 3, teen: 3, चार: 4, char: 4, पाँच: 5, पांच: 5, paanch: 5, panch: 5, छह: 6, छः: 6, chhe: 6, chah: 6,
  सात: 7, saat: 7, आठ: 8, aath: 8, नौ: 9, nau: 9, दस: 10, das: 10, ग्यारह: 11, gyarah: 11, बारह: 12, barah: 12, पंद्रह: 15, pandrah: 15, बीस: 20, bees: 20, आधा: 0.5, aadha: 0.5, adha: 0.5, पाव: 0.25, paav: 0.25, pav: 0.25, ढाई: 2.5, dhai: 2.5, डेढ़: 1.5, डेढ: 1.5, dedh: 1.5,
};
const HALF = /^(साढ़े|साढे|साड़े|sade|saade|sadhe)$/;
const MAT: [RegExp, Category][] = [
  [/^(कागज़|कागज|काग़ज़|अख़बार|अखबार|रद्दी|गत्ता|kagaz|raddi|gatta|akhbaar|akhbar|paper)$/, "paper"],
  [/^(प्लास्टिक|बोतल|बोतलें|डिब्बा|plastic|botal|botalein|dibba|dabba)$/, "plastic"],
  [/^(लोहा|लोहे|धातु|टीन|पीतल|स्टील|सरिया|loha|lohe|dhatu|tin|steel|peetal|metal|sariya)$/, "metal"],
  [/^(मोबाइल|चार्जर|तार|बैटरी|ewaste|e-waste|mobile|charger|bijli|taar|tar|battery)$/, "ewaste"],
  [/^(काँच|कांच|शीशा|kaanch|kanch|sheesha|glass)$/, "glass"],
];

/** Pull "5 kilo kagaz, 2 kilo loha" style weights out of a transcript. */
export function parseWeights(text: string): { cat: Category; kg: number }[] {
  const out = new Map<Category, number>();
  let num: number | undefined;
  let half = false;
  let lastMat: Category | undefined; // material heard before its number ("kagaz paanch kilo")
  let lastSet: Category | undefined;
  for (const raw of text.toLowerCase().split(/[\s,।]+/).map((w) => w.replace(/\.+$/, "")).filter(Boolean)) {
    if (HALF.test(raw)) {
      half = true;
      continue;
    }
    if (/^(gram|grams|ग्राम|gm)$/.test(raw)) {
      // "500 gram kagaz" (number still pending) or "kagaz 500 gram" (already stored)
      if (num !== undefined) num /= 1000;
      else if (lastSet) out.set(lastSet, out.get(lastSet)! / 1000);
      continue;
    }
    const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NUM[raw];
    if (n !== undefined) {
      const kg = n + (half ? 0.5 : 0);
      half = false;
      if (lastMat) out.set(lastMat, kg), (lastSet = lastMat), (lastMat = undefined);
      else num = kg;
      continue;
    }
    const mat = MAT.find(([re]) => re.test(raw))?.[1];
    if (mat) {
      if (num !== undefined) out.set(mat, num), (lastSet = mat), (num = undefined);
      else lastMat = mat;
    }
  }
  return [...out].map(([cat, kg]) => ({ cat, kg }));
}

export function ruleIntent(text: string): ToolCall | null {
  const t = text.toLowerCase();
  const weights = parseWeights(t);
  if (weights.length) {
    const segregation = /(अच्छा अलग|achha alag|well sorted|साफ़|saaf)/.test(t) ? "good" : /(मिक्स|mix|गंदा|ganda|मिला)/.test(t) ? "mixed" : undefined;
    return { name: "confirm_pickup", input: { items: weights, segregation } };
  }
  const rules: [RegExp, string][] = [
    [/(कोई नहीं|ghar par nahi|ghar pe nahi|koi nahi|बंद है|band hai|darwaza band|दरवाज़ा बंद|koi nahi mila|not home)/, "mark_not_home"],
    [/(kidhar mud|किधर मुड़|mudna|मुड़ना)/, "next_turn"],
    [/(अगला|agla|agle|aage kahan|आगे कहाँ|कहाँ जाना|kahan jana|next)/, "next_stop"],
    [/(कितने|kitne|kitna hua|कितना हुआ|kitna kamaya|कितना कमाया|हिसाब|hisaab|hisab|summary)/, "today_summary"],
    [/(शुरू|shuru|chalo|चलो|start karo|start)/, "start_batch"],
    [/(फ़ोन|फोन|phone|call karo|number lagao|नंबर लगाओ|call|कॉल)/, "call_household"],
    [/(रास्ता|rasta|map dikhao|map|नक्शा|navigate)/, "navigate"],
  ];
  const hit = rules.find(([re]) => re.test(t));
  return hit ? { name: hit[1], input: {} } : null;
}
