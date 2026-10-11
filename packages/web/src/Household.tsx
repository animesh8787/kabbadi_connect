import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, estKg, payout, type Category, type Slot, type WeightBucket, WEIGHT_BUCKETS } from "@kc/shared";
import { api, ApiError, type Req } from "./api";
import { MapView } from "./MapView";
import { firstOpenSlot, istDay, Schedule } from "./Schedule";
import { useT } from "./i18n";

const BUCKETS = Object.keys(WEIGHT_BUCKETS) as WeightBucket[];
export const EMOJI: Record<Category, string> = { paper: "📰", plastic: "🧴", metal: "🥫", ewaste: "🔌", glass: "🍾" };

export function NewPickup({ onCreated, initial }: { onCreated: () => void; initial?: { items: { cat: string; bucket: string }[]; date: string; slot: string; notes?: string } }) {
  const t = useT();
  const [picked, setPicked] = useState<Partial<Record<Category, WeightBucket>>>({});
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [date, setDate] = useState(() => istDay(Date.now()));
  const [slot, setSlot] = useState<Slot>(() => firstOpenSlot(istDay(Date.now())) ?? "s1012");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  // A booking the assistant proposed: fill the form and let the person place the pin.
  useEffect(() => {
    if (!initial) return;
    setPicked(Object.fromEntries(initial.items.map((i) => [i.cat, i.bucket])) as Partial<Record<Category, WeightBucket>>);
    setDate(initial.date);
    setSlot(initial.slot as Slot);
    setNotes(initial.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved address, pin and phone from the last booking: two taps next time.
  useEffect(() => {
    api.profile().then(({ profile }) => {
      if (!profile) return;
      setAddress((a) => a || profile.address);
      setPin((p) => p ?? { lat: profile.lat, lng: profile.lng });
      setPhone((p) => p || profile.phone || "");
    }).catch(() => {});
  }, []);

  const items = (Object.entries(picked) as [Category, WeightBucket][]).map(([cat, bucket]) => ({ cat, bucket }));
  const est = payout(items.map((i) => ({ cat: i.cat, kg: WEIGHT_BUCKETS[i.bucket] })));

  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setPin({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setErr(t("tapMap")),
    );
  }

  /** Shrink the photo on the phone, ask Bedrock what is in the pile, and pre-fill the chips. Nothing is stored. */
  async function fromPhoto(file: File) {
    setErr("");
    setPhotoBusy(true);
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      const r = await api.photo(c.toDataURL("image/jpeg", 0.8).split(",")[1]!);
      setPicked(Object.fromEntries(r.items.map((i) => [i.cat, i.bucket])) as Partial<Record<Category, WeightBucket>>);
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 429 ? x.message : t("photoFail"));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!items.length || !pin) return setErr(!items.length ? t("whatToGive") : t("tapMap"));
    setBusy(true);
    try {
      await api.create({ items, lat: pin.lat, lng: pin.lng, address, date, slot, phone: phone || undefined, notes: notes.trim() || undefined });
      api.saveProfile({ address, lat: pin.lat, lng: pin.lng, phone: phone || undefined }).catch(() => {});
      setPicked({});
      onCreated();
    } catch (x) {
      setErr((x as Error).message || t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{t("newPickup")}</h2>
      <label className="btn">
        {photoBusy ? t("photoWorking") : t("photoFill")}
        <input type="file" accept="image/*" capture="environment" hidden disabled={photoBusy} onChange={(e) => e.target.files?.[0] && fromPhoto(e.target.files[0])} />
      </label>
      <fieldset>
        <legend>{t("whatToGive")}</legend>
        <div className="chips">
          {CATEGORIES.map((c) => (
            <button
              type="button"
              key={c}
              className={"chip" + (picked[c] ? " on" : "")}
              aria-pressed={!!picked[c]}
              onClick={() => setPicked((p) => (p[c] ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== c)) : { ...p, [c]: "2-5" }))}
            >
              <span aria-hidden>{EMOJI[c]}</span> {t(c)}
            </button>
          ))}
        </div>
      </fieldset>
      {items.map((i) => (
        <label key={i.cat} className="row">
          <span>
            {EMOJI[i.cat]} {t(i.cat)} – {t("roughWeight")}
          </span>
          <select value={i.bucket} onChange={(e) => setPicked((p) => ({ ...p, [i.cat]: e.target.value as WeightBucket }))}>
            {BUCKETS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
      ))}
      <label>
        {t("address")}
        <input required minLength={3} maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
      </label>
      <button type="button" onClick={locate}>
        📍 {t("useLocation")}
      </button>
      <p className="muted">{t("tapMap")}</p>
      <MapView pin={pin} onPick={setPin} />
      <Schedule
        date={date}
        slot={slot}
        onChange={(d, sl) => {
          setDate(d);
          setSlot(sl);
        }}
      />
      <label>
        {t("notes")}
        <input maxLength={140} placeholder={t("notesHint")} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <label>
        {t("phone")}
        <input type="tel" inputMode="tel" pattern="\+?\d{10,13}" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
      </label>
      {items.length > 0 && (
        <p className="estimate">
          {t("estimate")}: <strong>₹{est}</strong> (~{estKg(items)} {t("kg")})<br />
          <small className="muted">{t("estimateNote")}</small>
        </p>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {t("schedule")}
      </button>
    </form>
  );
}

