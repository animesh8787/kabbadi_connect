import { SLOTS, type Slot } from "@kc/shared";

const IST_MS = 5.5 * 3600 * 1000;
export const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

/** End of the window as epoch ms (IST). */
export function windowEndMs(date: string, slot: Slot): number {
  return Date.parse(`${date}T${String(SLOTS[slot][1]).padStart(2, "0")}:00:00+05:30`);
}
