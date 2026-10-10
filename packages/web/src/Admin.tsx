import { useEffect, useState } from "react";
import { CATEGORIES } from "@kc/shared";
import { api, type Impact } from "./api";
import { useT } from "./i18n";

function Tile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="tile">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Admin() {
  const t = useT();
  const [d, setD] = useState<Impact | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const load = () => api.impact().then(setD).catch(() => setErr(true));
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (err && !d) return <p className="error">{t("error")}</p>;
  if (!d) return <p>{t("loading")}</p>;
  const max = Math.max(1, ...CATEGORIES.map((c) => d.byCategory[c] ?? 0));
  return (
    <>
      <h1>{t("admin")}</h1>
      <div className="tiles">
        <Tile value={d.kg} label={t("kgDiverted")} />
        <Tile value={d.co2Kg} label={t("co2")} />
        <Tile value={d.pickups} label={t("pickups")} />
        <Tile value={d.payout} label={t("paidOut")} />
        <Tile value={d.ackKg} label={t("confirmedKg")} />
        {d.segTotal > 0 && <Tile value={`${Math.round((d.segGood / d.segTotal) * 100)}%`} label={t("segRate")} />}
        <Tile value={`${d.kmSavedPct}%`} label={`${t("routeSaved")} (${d.routeKm} km vs ${d.naiveKm} km, ${t("routeNote")})`} />
      </div>
      <section className="card">
        <h2>{t("byCategory")}</h2>
        {CATEGORIES.map((c) => (
          <div key={c} className="bar">
            <span>{t(c)}</span>
            <div style={{ width: `${((d.byCategory[c] ?? 0) / max) * 100}%` }} />
            <em>{d.byCategory[c] ?? 0} {t("kg")}</em>
          </div>
        ))}
        <p className="muted">
          {t("factorsNote")} <a href="/methodology">{t("methodology")}</a>
        </p>
      </section>
    </>
  );
}
