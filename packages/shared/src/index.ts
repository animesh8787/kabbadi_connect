import { z } from "zod";
import factors from "./factors.json";
import ewaste from "./ewaste-recyclers.json";

export * from "./geo.js";
export { factors, ewaste };

export const CATEGORIES = ["paper", "plastic", "metal", "ewaste", "glass"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Weight buckets shown to households; estKg is the midpoint used for batching only. */
export const WEIGHT_BUCKETS = { "<2": 1, "2-5": 3.5, "5-10": 7.5, "10+": 15 } as const;
export type WeightBucket = keyof typeof WEIGHT_BUCKETS;

export const STATUSES = ["OPEN", "ASSIGNED", "EN_ROUTE", "PICKED", "MISSED", "CANCELLED"] as const;
export type Status = (typeof STATUSES)[number];

export const SLOTS = { morning: [8, 12], evening: [16, 20] } as const;
export type Slot = keyof typeof SLOTS;

export const BATCH_MIN_KG = 15;
export const BATCH_MAX_STOPS = 20;

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const CreateRequestSchema = z.object({
  items: z
    .array(z.object({ cat: z.enum(CATEGORIES), bucket: z.enum(["<2", "2-5", "5-10", "10+"]) }))
    .min(1)
    .max(CATEGORIES.length)
    .refine((a) => new Set(a.map((i) => i.cat)).size === a.length, "duplicate category"),
  lat,
  lng,
  address: z.string().trim().min(3).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.enum(["morning", "evening"]),
  phone: z.string().regex(/^\+?\d{10,13}$/).optional(),
});
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

export const ConfirmSchema = z.object({
  items: z.array(z.object({ cat: z.enum(CATEGORIES), actualKg: z.number().min(0).max(1000) })).min(1),
  /** How well the household sorted the material; feeds the segregation rate on the dashboard. */
  segregation: z.enum(["good", "mixed"]).optional(),
});
export type Confirm = z.infer<typeof ConfirmSchema>;

export const PhoneSchema = z.string().regex(/^\+?\d{10,13}$/);

export const CollectorSchema = z.object({
  name: z.string().trim().min(1).max(60),
  phone: PhoneSchema,
  areas: z.array(z.string().regex(/^[0-9a-z]{5}$/)).min(1).max(20),
  rates: z.record(z.enum(CATEGORIES), z.number().min(0).max(1000)).optional(),
  lat,
  lng,
  active: z.boolean().default(true),
});
export type CollectorInput = z.infer<typeof CollectorSchema>;

export function estKg(items: { bucket: WeightBucket }[]): number {
  return items.reduce((s, i) => s + WEIGHT_BUCKETS[i.bucket], 0);
}

export function payout(items: { cat: Category; kg: number }[], rates: Partial<Record<Category, number>> = {}): number {
  return Math.round(items.reduce((s, i) => s + i.kg * (rates[i.cat] ?? factors.ratePerKg[i.cat]), 0));
}

export function co2Kg(items: { cat: Category; kg: number }[]): number {
  return +items.reduce((s, i) => s + i.kg * factors.co2PerKg[i.cat], 0).toFixed(2);
}

export const windowId = (date: string, slot: Slot) => `${date}#${slot}`;

/** Start of the window as an epoch ms (IST = UTC+5:30). */
export function windowStartMs(date: string, slot: Slot): number {
  return Date.parse(`${date}T${String(SLOTS[slot][0]).padStart(2, "0")}:00:00+05:30`);
}

/** Rough items a household can describe, reused for photo estimates. */
export const ItemsSchema = CreateRequestSchema.shape.items;

/** Start/end epoch ms of a calendar month ("YYYY-MM") in IST. */
export function monthRangeMs(month: string): [number, number] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [Date.parse(`${month}-01T00:00:00+05:30`), Date.parse(`${next}-01T00:00:00+05:30`)];
}
