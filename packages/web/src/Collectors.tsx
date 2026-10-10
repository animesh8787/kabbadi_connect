import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { geohash } from "@kc/shared";
import { api, ApiError, type Card, type Collector } from "./api";
import { MapView } from "./MapView";
import { Statement } from "./Statement";
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

function AddCollector({ onCard }: { onCard: (name: string, c: Card) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
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
      onCard(name, await api.createCollector({ name, phone, areas, lat: pts[0]!.lat, lng: pts[0]!.lng }));
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

export function Collectors() {
  const t = useT();
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
      <AddCollector onCard={(name, c) => setCard({ name, card: c })} />
    </>
  );
}
