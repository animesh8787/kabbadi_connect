import { useCallback, useEffect, useState } from "react";
import { slotLabel } from "@kc/shared";
import { api, ApiError, type Nearby } from "./api";
import { EMOJI } from "./Household";
import { useT } from "./i18n";

/** Requests nobody has taken near the collector (GPS if allowed, else home). Take one and it joins today's list. */
export function NearbyBoard({ onTaken }: { onTaken: () => void }) {
  const t = useT();
  const [list, setList] = useState<Nearby[] | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    const go = (pos?: { lat: number; lng: number }) => api.nearby(pos).then((r) => setList(r.requests)).catch(() => setList((l) => l ?? []));
    if (!navigator.geolocation) return void go();
    navigator.geolocation.getCurrentPosition((p) => go({ lat: p.coords.latitude, lng: p.coords.longitude }), () => go(), { maximumAge: 60_000, timeout: 3000 });
  }, []);
  useEffect(() => {
    load();
    const i = setInterval(load, 30_000);
    return () => clearInterval(i);
  }, [load]);

  async function take(id: string) {
    setMsg("");
    try {
      await api.claim(id);
      onTaken();
      load();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? t("nb_taken") : t("error"));
      load();
    }
  }

  if (!list || list.length === 0) return list ? <p className="muted">{t("nb_none")}</p> : null;
  return (
    <section className="card">
      <h2>📍 {t("nb_title")}</h2>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <ul className="list">
        {list.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.items.map((i) => `${EMOJI[i.cat]} ${t(i.cat)}`).join("  ")}</strong> · ~{r.estKg} {t("kg")}
              <div className="muted">
                {r.date} · {slotLabel(r.slot)} · {r.distanceKm} {t("nb_away")}
              </div>
              {r.notes && <div className="muted">📝 {r.notes}</div>}
            </div>
            <button className="primary" onClick={() => take(r.id)}>
              {t("nb_take")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Travel mode, how far to go, and an optional password so a collector who reads can sign in with their phone number. */
export function CollectorSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<"walking" | "cart" | "scooter">("walking");
  const [radius, setRadius] = useState(8);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      await api.settings({ travelMode: mode, serviceRadiusKm: radius });
      if (pw) await api.setOwnPassword(pw);
      setPw("");
      setMsg(t("saved"));
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : t("error"));
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>⚙ {t("set_title")}</h2>
      <fieldset>
        <legend>{t("set_mode")}</legend>
        <div className="chips">
          {(["walking", "cart", "scooter"] as const).map((m) => (
            <button type="button" key={m} className={"chip" + (mode === m ? " on" : "")} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {t(`mode_${m}` as "mode_walking")}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        {t("set_radius")}
        <input type="number" min={1} max={30} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
      </label>
      <label>
        {t("set_pw")}
        <input type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} />
        <small className="muted">{t("passwordHint")}</small>
      </label>
      {msg && <p role="status">{msg}</p>}
      <div className="actions">
        <button className="primary">{t("confirm")}</button>
        <button type="button" onClick={onClose}>
          {t("back")}
        </button>
      </div>
    </form>
  );
}
