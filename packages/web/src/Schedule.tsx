import { useContext, useEffect } from "react";
import { BOOKABLE_SLOTS, slotLabel, windowStartMs, type Slot } from "@kc/shared";
import { LangCtx, useT } from "./i18n";

const IST = 5.5 * 3600_000;
export const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

/** The next 7 calendar days (IST), starting today. */
export function nextDays(now = Date.now()): string[] {
  return Array.from({ length: 7 }, (_, i) => istDay(now + i * 86_400_000));
}

/** A slot can be booked while at least 30 minutes of it are still ahead. */
export const slotOpen = (date: string, slot: Slot, now = Date.now()) => windowStartMs(date, slot) + 2 * 3600_000 > now + 30 * 60_000;

/** First open slot of a day, or null if the whole day is gone. */
export const firstOpenSlot = (date: string, now = Date.now()): Slot | null => BOOKABLE_SLOTS.find((s) => slotOpen(date, s, now)) ?? null;

/** Pick a day from the next week and one of six two-hour slots; slots that have passed today are disabled. */
export function Schedule({ date, slot, onChange }: { date: string; slot: string; onChange: (date: string, slot: Slot) => void }) {
  const t = useT();
  const { lang } = useContext(LangCtx);
  const days = nextDays();

  // If the chosen slot is no longer available (day changed, or time passed), move to the first open one.
  useEffect(() => {
    if (!slotOpen(date, slot as Slot)) {
      const s = firstOpenSlot(date);
      if (s) onChange(date, s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, slot]);

  const label = (d: string, i: number) =>
    i === 0 ? t("today") : i === 1 ? t("tomorrow") : new Date(`${d}T12:00:00+05:30`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "short", day: "numeric", timeZone: "Asia/Kolkata" });

  return (
    <>
      <fieldset>
        <legend>{t("pickDay")}</legend>
        <div className="chips">
          {days.map((d, i) => {
            const gone = !firstOpenSlot(d);
            return (
              <button type="button" key={d} className={"chip" + (d === date ? " on" : "")} aria-pressed={d === date} disabled={gone} onClick={() => onChange(d, firstOpenSlot(d) ?? (slot as Slot))}>
                {label(d, i)}
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("pickTime")}</legend>
        <div className="chips">
          {BOOKABLE_SLOTS.map((s) => (
            <button type="button" key={s} className={"chip" + (s === slot ? " on" : "")} aria-pressed={s === slot} disabled={!slotOpen(date, s)} onClick={() => onChange(date, s)}>
              {slotLabel(s)}
            </button>
          ))}
        </div>
      </fieldset>
    </>
  );
}
