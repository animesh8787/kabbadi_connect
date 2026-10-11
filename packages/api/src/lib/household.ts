import { BOOKABLE_SLOTS, BookingProposalSchema, bucketOf, CATEGORIES, RescheduleSchema, slotLabel, SLOTS, windowStartMs, type Slot } from "@kc/shared";
import type { ToolCall } from "./bedrock.js";
import { parseWeights, referenceFacts } from "./intent.js";
import { tool, type ToolDef } from "./llm.js";
import { addDays, istDate, weekday, windowEndMs } from "./time.js";

/** The household assistant: understands "kal shaam 5 kilo raddi le jao", proposes a booking, and never books without a tap. */
export interface ReqView {
  id: string;
  status: string;
  items: { cat: string }[];
  date: string;
  slot: string;
}

const slotEnum = [...BOOKABLE_SLOTS];
const SAY = { type: "string", description: "One short sentence asking the user to confirm, in the language they used" };

export const HOUSEHOLD_TOOLS: ToolDef[] = [
  tool("answer", "Reply to a question or small talk using only the CONTEXT", { type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
  tool("propose_booking", "Propose a new pickup. The user must confirm before it is booked.", {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { cat: { type: "string", enum: [...CATEGORIES] }, bucket: { type: "string", enum: ["<2", "2-5", "5-10", "10+"], description: "rough kg" } }, required: ["cat", "bucket"] },
      },
      date: { type: "string", description: "YYYY-MM-DD, resolved from the dates in CONTEXT" },
      slot: { type: "string", enum: slotEnum, description: "two-hour slot: s0810 = 8-10am ... s1820 = 6-8pm" },
      notes: { type: "string", description: "gate number, call before coming, etc." },
      say: SAY,
    },
    required: ["items", "date", "slot"],
  }),
  tool("reschedule", "Propose moving an existing pickup to another day or time", {
    type: "object",
    properties: { number: { type: "number", description: "the # of the pickup in CONTEXT; omit for the soonest one" }, date: { type: "string" }, slot: { type: "string", enum: slotEnum }, say: SAY },
    required: ["date", "slot"],
  }),
  tool("cancel_pickup", "Propose cancelling an existing pickup", { type: "object", properties: { number: { type: "number" }, say: SAY } }),
];

export const HOUSEHOLD_SYSTEM = `You are the booking assistant of Kabadi Connect, helping a household in India book a pickup of recyclable waste (raddi) by a local kabadiwala. They write or speak Hindi, English or Hinglish, often imperfectly. Reply in the language they use (Devanagari Hindi for Hindi).
Always call exactly one tool.
- To book, call propose_booking with the materials, a rough weight bucket each, the date and a two-hour slot. Use the dates in CONTEXT to resolve "kal", "parso", "Monday". If they gave no time, pick a sensible slot (shaam = s1618, subah = s1012, dopahar = s1214). If materials are missing, call answer and ask what they have.
- To change or cancel an existing pickup call reschedule or cancel_pickup.
- For questions (rates, how to sort, where e-waste goes, status of their pickup) call answer using ONLY the CONTEXT; if it is not there, say you do not know. Never invent prices or times.
Nothing is booked until the user confirms, so propose without asking permission first. Materials: ${CATEGORIES.join(", ")}. Weight buckets: "<2", "2-5", "5-10", "10+" kg ("thoda" = "<2", "kaafi" = "5-10").`;

export function householdContext(o: { requests: ReqView[]; hasProfile: boolean; nowMs: number }): string {
  const today = istDate(o.nowMs);
  const days = Array.from({ length: 8 }, (_, i) => `${addDays(today, i)} ${weekday(addDays(today, i))}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  const live = o.requests.filter((r) => r.status === "OPEN" || r.status === "ASSIGNED" || r.status === "EN_ROUTE");
  return [
    `Now (IST): ${new Date(o.nowMs + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16)}`,
    `Dates: ${days.join("; ")}`,
    `Slots: ${BOOKABLE_SLOTS.map((s) => `${s}=${slotLabel(s)}`).join(", ")}`,
    live.length ? `Their open pickups:\n${live.map((r, i) => `#${i + 1}: ${r.status} ${r.items.map((x) => x.cat).join("+")} on ${r.date} ${slotLabel(r.slot)}`).join("\n")}` : "They have no open pickups.",
    o.hasProfile ? "A saved address exists, so a booking only needs their confirmation." : "No saved address yet: the app will ask for it when they confirm.",
    referenceFacts(),
  ].join("\n");
}

export type HAction =
  | { type: "book"; booking: { items: { cat: string; bucket: string }[]; date: string; slot: string; notes?: string } }
  | { type: "reschedule"; id: string; date: string; slot: string }
  | { type: "cancel"; id: string };
export interface HPlan {
  say: string;
  action?: HAction;
  needsConfirm?: boolean;
}

const UNSURE = "Samajh nahi aaya. Kya, kab aur kitna? / I didn't catch that: what material, which day and time?";
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Turn a tool call into a reply and a proposed action. Everything is re-validated here; the model only suggests. */
export function planHousehold(call: ToolCall | null, reqs: ReqView[], nowMs: number): HPlan {
  if (!call) return { say: UNSURE };
  const live = reqs.filter((r) => r.status === "OPEN" || r.status === "ASSIGNED");
  const inWindow = (date: string, slot: Slot) => windowEndMs(date, slot) > nowMs && windowStartMs(date, slot) - nowMs <= 7 * 86_400_000;
  const pick = () => {
    const n = Number(call.input.number);
    return Number.isInteger(n) && n >= 1 ? reqs.filter((r) => ["OPEN", "ASSIGNED", "EN_ROUTE"].includes(r.status))[n - 1] : [...live].sort((a, b) => a.date.localeCompare(b.date))[0];
  };

  switch (call.name) {
    case "answer":
      return { say: text(call.input.text, 450) || UNSURE };
    case "propose_booking": {
      const parsed = BookingProposalSchema.safeParse({ items: call.input.items, date: call.input.date, slot: call.input.slot, notes: text(call.input.notes, 140) || undefined });
      if (!parsed.success) return { say: UNSURE };
      const b = parsed.data;
      if (!inWindow(b.date, b.slot)) return { say: `That time is not available (it has passed, or is more than a week away). Which other day or time? / वह समय उपलब्ध नहीं है, कोई और समय बताइए।` };
      const what = b.items.map((i) => `${i.bucket} kg ${i.cat}`).join(", ");
      return { say: text(call.input.say, 200) || `${what}, ${b.date} ${slotLabel(b.slot)}. Book it?`, action: { type: "book", booking: b }, needsConfirm: true };
    }
    case "reschedule": {
      const r = pick();
      const parsed = RescheduleSchema.safeParse({ date: call.input.date, slot: call.input.slot });
      if (!r || !live.some((x) => x.id === r.id)) return { say: "You have no pickup that can be moved. / कोई पिकअप नहीं है जिसे बदला जा सके।" };
      if (!parsed.success || !inWindow(parsed.data.date, parsed.data.slot)) return { say: UNSURE };
      return { say: text(call.input.say, 200) || `Move it to ${parsed.data.date} ${slotLabel(parsed.data.slot)}?`, action: { type: "reschedule", id: r.id, ...parsed.data }, needsConfirm: true };
    }
    case "cancel_pickup": {
      const r = pick();
      if (!r || !live.some((x) => x.id === r.id)) return { say: "You have no pickup that can be cancelled. / रद्द करने लायक कोई पिकअप नहीं है।" };
      return { say: text(call.input.say, 200) || `Cancel the pickup on ${r.date} ${slotLabel(r.slot)}?`, action: { type: "cancel", id: r.id }, needsConfirm: true };
    }
    default:
      return { say: UNSURE };
  }
}

const SLOT_WORDS: [RegExp, Slot][] = [
  [/(subah|सुबह|morning)/, "s1012"],
  [/(dopahar|दोपहर|afternoon|noon)/, "s1214"],
  [/(shaam|शाम|evening)/, "s1618"],
  [/(raat|रात|night)/, "s1820"],
];

/** Keyword fallback for when no model is reachable: weights + a day word + a time word make a booking. */
export function ruleHousehold(textIn: string, nowMs: number): ToolCall | null {
  const t = textIn.toLowerCase();
  if (/(cancel|रद्द|radd (karo|kar do|kardo)|hata do|mat aana)/.test(t)) return { name: "cancel_pickup", input: {} };
  const today = istDate(nowMs);
  const offset = /(parso|परसों|day after)/.test(t) ? 2 : /(kal|कल|tomorrow)/.test(t) ? 1 : 0;
  let date = addDays(today, offset);
  let slot: Slot = SLOT_WORDS.find(([re]) => re.test(t))?.[1] ?? "s1618";
  if (windowEndMs(date, slot) <= nowMs) {
    // that slot is gone today: take the next slot still open, else tomorrow morning
    const open = BOOKABLE_SLOTS.find((s) => windowEndMs(date, s) > nowMs + 30 * 60_000);
    if (open && !SLOT_WORDS.some(([re]) => re.test(t))) slot = open;
    else {
      date = addDays(date, 1);
      slot = SLOTS[slot] ? slot : "s1012";
    }
  }
  if (/(reschedule|badal|बदल|shift|postpone|aage kar)/.test(t)) return { name: "reschedule", input: { date, slot } };
  const weights = parseWeights(t);
  if (!weights.length) return null;
  return { name: "propose_booking", input: { items: weights.map((w) => ({ cat: w.cat, bucket: bucketOf(w.kg) })), date, slot } };
}
