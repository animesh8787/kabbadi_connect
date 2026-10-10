import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, estKg, payout, type Category, type WeightBucket, WEIGHT_BUCKETS } from "@kc/shared";
import { api, ApiError, type Req } from "./api";
import { MapView } from "./MapView";
import { useT } from "./i18n";

const BUCKETS = Object.keys(WEIGHT_BUCKETS) as WeightBucket[];
export const EMOJI: Record<Category, string> = { paper: "📰", plastic: "🧴", metal: "🥫", ewaste: "🔌", glass: "🍾" };
const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export function NewPickup({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const [picked, setPicked] = useState<Partial<Record<Category, WeightBucket>>>({});
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [day, setDay] = useState<0 | 1>(0);
  const [slot, setSlot] = useState<"morning" | "evening">("evening");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

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
      const date = ymd(new Date(Date.now() + day * 86400000));
      await api.create({ items, lat: pin.lat, lng: pin.lng, address, date, slot, phone: phone || undefined });
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
      <div className="row">
        <label>
          {t("day")}
          <select value={day} onChange={(e) => setDay(Number(e.target.value) as 0 | 1)}>
            <option value={0}>{t("today")}</option>
            <option value={1}>{t("tomorrow")}</option>
          </select>
        </label>
        <label>
          &nbsp;
          <select aria-label={t("slot")} value={slot} onChange={(e) => setSlot(e.target.value as "morning" | "evening")}>
            <option value="morning">{t("morning")}</option>
            <option value="evening">{t("evening")}</option>
          </select>
        </label>
      </div>
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

