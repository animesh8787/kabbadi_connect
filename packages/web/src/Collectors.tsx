import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { geohash } from "@kc/shared";
import { api, ApiError, type Card, type Collector } from "./api";
import { MapView } from "./MapView";
import { Statement } from "./Statement";
import { slotLabel } from "@kc/shared";
import { useT } from "./i18n";

/** The printable login card: scan once, collector is signed in. The code works once and is replaced by the next card. */
function PrintCard({ name, card, onClose }: { name: string; card: Card; onClose: () => void }) {
  const t = useT();
  const [qr, setQr] = useState("");
  useEffect(() => {
    const link = `${location.origin}/?enroll=${encodeURIComponent(card.code)}&u=${encodeURIComponent(card.username)}`;
    QRCode.toDataURL(link, { width: 320, margin: 1, errorCorrectionLevel: "M" }).then(setQr);
  }, [card]);
  return (
    <section className="card print-area card-print">
      <h2>♻ {t("app")}</h2>
      <p className="big-name">{name}</p>
      {qr && <img src={qr} alt="QR" width={240} height={240} />}
      <p>{t("cardSteps")}</p>
      <p className="muted">
        {t("cardValid")}: {new Date(card.validUntil).toLocaleDateString()} · {t("cardOnce")}
      </p>
      <div className="actions no-print">
        <button className="primary" onClick={() => window.print()}>
          🖨 {t("print")}
        </button>
        <button onClick={onClose}>{t("back")}</button>
      </div>
    </section>
  );
}

function AddCollector({ onCard, prefill, onCreated }: { onCard: (name: string, c: Card) => void; prefill?: { name: string; phone: string; joinId: string }; onCreated: () => void }) {
  const t = useT();
  const [name, setName] = useState(prefill?.name ?? "");
  const [phone, setPhone] = useState(prefill?.phone ?? "");
  const [password, setPassword] = useState("");
  const [pts, setPts] = useState<{ lat: number; lng: number }[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const areas = [...new Set(pts.map((p) => geohash(p.lat, p.lng, 5)))];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pts.length) return setErr(t("areasTap"));
    setBusy(true);
    setErr("");
    try {
      const card = await api.createCollector({ name, phone, areas, lat: pts[0]!.lat, lng: pts[0]!.lng, password: password || undefined });
      if (prefill) await api.deleteJoin(prefill.joinId).catch(() => {});
      onCreated();
      onCard(name, card);
      setName("");
      setPhone("");
      setPts([]);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{t("addCollector")}</h2>
      <label>
        {t("name")}
        <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t("phoneCollector")}
        <input required type="tel" inputMode="tel" pattern="\+?\d{10,13}" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label>
        {t("adm_pw")}
        <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        <small className="muted">{t("passwordHint")}</small>
      </label>
      <p className="muted">{t("areasTap")}</p>
      <MapView pin={pts.at(-1) ?? null} onPick={(p) => setPts((a) => [...a, p])} />
      <p className="muted">{areas.join(", ")}</p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {t("createCard")}
      </button>
    </form>
  );
}

/** Open requests nobody has taken for 2+ hours, with a one-tap "give to" for the admin. */
function Unassigned({ collectors, onDone }: { collectors: Collector[]; onDone: () => void }) {
  const t = useT();
  const [list, setList] = useState<Awaited<ReturnType<typeof api.unassigned>>["requests"]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api.unassigned().then((r) => setList(r.requests ?? [])).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!list.length) return null;
  return (
    <section className="card">
      <h2>⏳ {t("adm_unassigned")}</h2>
      {msg && <p role="status">{msg}</p>}
      <ul className="list">
        {list.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.address}</strong>
              <div className="muted">
                {r.date} · {slotLabel(r.slot)} · ~{r.estKg} kg · {r.collectorsNearby} nearby
              </div>
            </div>
            <div className="stack">
              <select aria-label={t("adm_assign")} value={pick[r.id] ?? ""} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                <option value="">{t("adm_assign")}</option>
                {collectors.filter((c) => c.active).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                disabled={!pick[r.id]}
                onClick={() =>
                  api
                    .assign(r.id, pick[r.id]!)
                    .then((a) => (setMsg(`${a.distanceKm} km`), load(), onDone()))
                    .catch((e) => setMsg(e instanceof ApiError ? e.message : t("error")))
                }
              >
                ✔
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Collectors() {
  const t = useT();
  const [joins, setJoins] = useState<Awaited<ReturnType<typeof api.joins>>["joins"]>([]);
  const [prefill, setPrefill] = useState<{ name: string; phone: string; joinId: string } | undefined>();
  const loadJoins = useCallback(() => api.joins().then((r) => setJoins(r.joins ?? [])).catch(() => {}), []);
  useEffect(() => {
    loadJoins();
  }, [loadJoins]);
  const [list, setList] = useState<Collector[] | null>(null);
  const [card, setCard] = useState<{ name: string; card: Card } | null>(null);
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api.collectors().then((r) => setList(r.collectors)).catch(() => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);

  const act = (f: () => Promise<unknown>) => f().then(load).catch((e) => setErr(e instanceof ApiError ? e.message : t("error")));

  if (card) return <PrintCard name={card.name} card={card.card} onClose={() => (setCard(null), load())} />;
  return (
    <>
      <h1>{t("collectors")}</h1>
      {err && <p className="error">{err}</p>}
      <section className="card">
        {list === null ? <p>{t("loading")}</p> : list.length === 0 ? <p className="muted">{t("none")}</p> : null}
        <ul className="list">
          {list?.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.name}</strong> · {c.phone}
                <div className="muted">{c.areas.join(", ")}</div>
                {c.cardActive && <span className="badge OPEN">🎫</span>}
              </div>
              <div className="stack">
                <button onClick={() => api.newCard(c.id).then((card) => setCard({ name: c.name, card })).catch(() => setErr(t("error")))}>🎫 {t("newCard")}</button>
                <button onClick={() => setLedgerFor(ledgerFor === c.id ? null : c.id)}>📄 {t("statement")}</button>
                <button onClick={() => act(() => api.revoke(c.id))}>⛔ {t("revoke")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {ledgerFor && <Statement collectorId={ledgerFor} />}
      <Unassigned collectors={list ?? []} onDone={load} />
      {joins.length > 0 && (
        <section className="card">
          <h2>🙋 {t("adm_joins")}</h2>
          <ul className="list">
            {joins.map((j) => (
              <li key={j.id}>
                <div>
                  <strong>{j.name}</strong> · {j.phone}
                  <div className="muted">{j.area}</div>
                </div>
                <div className="stack">
                  <button onClick={() => setPrefill({ name: j.name, phone: j.phone, joinId: j.id })}>{t("adm_use")}</button>
                  <button onClick={() => api.deleteJoin(j.id).then(loadJoins)}>{t("adm_dismiss")}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AddCollector key={prefill?.joinId ?? "new"} prefill={prefill} onCreated={() => (setPrefill(undefined), loadJoins())} onCard={(name, c) => setCard({ name, card: c })} />
    </>
  );
}
