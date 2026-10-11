import { useCallback, useEffect, useMemo, useState } from "react";
import { CATEGORIES, ewaste, type Category } from "@kc/shared";
import { api, ApiError, type Batch, type Stop } from "./api";
import { Bolo } from "./Bolo";
import { CollectorSettings, NearbyBoard } from "./CollectorExtras";
import { Navigate } from "./Navigate";
import { MapView } from "./MapView";
import { useT } from "./i18n";
import { play } from "./voice";

const EMOJI: Record<Category, string> = { paper: "📰", plastic: "🧴", metal: "🥫", ewaste: "🔌", glass: "🍾" };
const QUEUE = "kc.queue";

type Queued = { id: string; items: { cat: Category; actualKg: number }[]; segregation?: "good" | "mixed" };
const readQueue = (): Queued[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) ?? "[]");
  } catch {
    return [];
  }
};

/** Retry confirmations saved while offline. Drops entries the server definitively rejects (4xx). */
async function flush() {
  let q = readQueue();
  for (const item of [...q]) {
    try {
      await api.confirm(item.id, { items: item.items, segregation: item.segregation });
    } catch (e) {
      if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) break;
    }
    q = q.filter((x) => x.id !== item.id);
    localStorage.setItem(QUEUE, JSON.stringify(q));
  }
}

function StopCard({ stop, index, active, focused, reload, onNavigate }: { stop: Stop; index: number; active: boolean; focused: boolean; reload: () => void; onNavigate: () => void }) {
  const t = useT();
  const [kg, setKg] = useState<Partial<Record<Category, string>>>({});
  const [seg, setSeg] = useState<"good" | "mixed" | undefined>();
  const [msg, setMsg] = useState("");
  const cats = stop.items.map((i) => i.cat);

  async function done() {
    const items = CATEGORIES.filter((c) => cats.includes(c)).map((cat) => ({ cat, actualKg: Number(kg[cat] ?? 0) }));
    try {
      await api.confirm(stop.id, { items, segregation: seg });
      reload();
    } catch (e) {
      if (e instanceof ApiError) return setMsg(e.message);
      localStorage.setItem(QUEUE, JSON.stringify([...readQueue().filter((q) => q.id !== stop.id), { id: stop.id, items, segregation: seg }]));
      setMsg(t("offlineQueued"));
    }
  }

  async function listen() {
    try {
      const r = await api.speak(`${stop.address}. ${stop.items.map((i) => t(i.cat)).join(", ")}. ${Math.round(stop.estKg)} ${t("kg")}`);
      await play(r.audio, r.audioMime);
    } catch {
      setMsg(t("error"));
    }
  }

  return (
    <li id={`stop-${stop.id}`} className={"stop " + stop.status + (focused ? " focused" : "")}>
      <div className="stop-head">
        <span className="num">{index + 1}</span>
        <div>
          <strong>{stop.address}</strong>
          <div>
            {stop.items.map((i) => `${EMOJI[i.cat]} ${t(i.cat)}`).join("  ")} · ~{stop.estKg} {t("kg")}
          </div>
        </div>
      </div>
      {stop.notes && (
        <p className="muted">
          📝 {t("note_label")}: {stop.notes}
        </p>
      )}
      <div className="actions">
        <button onClick={onNavigate}>🧭 {t("nav_start")}</button>
        <a className="btn" href={`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&travelmode=walking`} target="_blank" rel="noreferrer" aria-label={t("navigate")}>
          🗺
        </a>
        {stop.phone && (
          <a className="btn" href={`tel:${stop.phone}`} aria-label="call">
            📞
          </a>
        )}
        <button onClick={listen}>🔊 {t("sunao")}</button>
      </div>
      {active && stop.status === "EN_ROUTE" && (
        <>
          <p className="muted">{t("enterWeights")}</p>
          <div className="kgs">
            {cats.map((c) => (
              <label key={c}>
                {EMOJI[c]} {t(c)}
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  placeholder={t("kg")}
                  value={kg[c] ?? ""}
                  onChange={(e) => setKg({ ...kg, [c]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <fieldset>
            <legend>{t("segregation")}</legend>
            <div className="actions">
              <button type="button" className={seg === "good" ? "chip on" : "chip"} aria-pressed={seg === "good"} onClick={() => setSeg(seg === "good" ? undefined : "good")}>
                👍 {t("seg_good")}
              </button>
              <button type="button" className={seg === "mixed" ? "chip on" : "chip"} aria-pressed={seg === "mixed"} onClick={() => setSeg(seg === "mixed" ? undefined : "mixed")}>
                👎 {t("seg_mixed")}
              </button>
            </div>
          </fieldset>
          <div className="actions">
            <button className="primary" onClick={done}>
              ✅ {t("picked")}
            </button>
            <button onClick={() => api.missed(stop.id).then(reload).catch((e) => setMsg(e.message))}>🚪 {t("notHome")}</button>
          </div>
        </>
      )}
      {stop.status === "PICKED" && (
        <p>
          ✅ {stop.actual?.map((a) => `${EMOJI[a.cat]} ${a.kg}`).join(" ")} {t("kg")} — <strong>₹{stop.payout}</strong>
        </p>
      )}
      {stop.status === "MISSED" && <p className="muted">🚪 {t("notHome")}</p>}
      {msg && <p className="error">{msg}</p>}
    </li>
  );
}

function EwasteCard() {
  const t = useT();
  return (
    <section className="card">
      <h2>🔌 {t("ewaste_title")}</h2>
      <p className="muted">{t("ewaste_note")}</p>
      <ul className="list">
        {ewaste.recyclers.map((r) => (
          <li key={r.name}>
            <div>
              <strong>{r.name}</strong>
              <div className="muted">{r.address}</div>
            </div>
            <a className="btn" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.address}`)}`}>
              🧭 {t("open_map")}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BatchCard({ batch, focusId, reload, onNavigate }: { batch: Batch; focusId?: string; reload: () => void; onNavigate: (s: Stop, i: number) => void }) {
  const t = useT();
  const live = batch.stops.filter((s) => s.status !== "CANCELLED");
  const [naive, setNaive] = useState(false);
  const canCompare = !!batch.naiveOrder && batch.naiveKm > batch.km && batch.km > 0;
  const shown = naive && canCompare ? batch.naiveOrder!.map((id) => live.find((s) => s.id === id)).filter((s): s is Stop => !!s) : live;
  const markers = useMemo(() => shown.map((s, i) => ({ lat: s.lat, lng: s.lng, label: String(i + 1) })), [batch, naive]); // eslint-disable-line react-hooks/exhaustive-deps
  const savedPct = canCompare ? Math.round(((batch.naiveKm - batch.km) / batch.naiveKm) * 100) : 0;
  const kg = live.reduce((s, x) => s + x.estKg, 0);
  return (
    <section className="card">
      <h2>
        {live.length} {t("stops")} · ~{Math.round(kg)} {t("kg")}
      </h2>
      <p className="muted">
        {batch.window.replace("#", " · ")} · {batch.km} km
      </p>
      {canCompare && (
        <>
          <div className="actions">
            <button type="button" className={!naive ? "chip on" : "chip"} aria-pressed={!naive} onClick={() => setNaive(false)}>
              {t("routeOpt")}
            </button>
            <button type="button" className={naive ? "chip on" : "chip"} aria-pressed={naive} onClick={() => setNaive(true)}>
              {t("routeReq")}
            </button>
          </div>
          <p className="muted" data-testid="route-badge">
            {batch.km} {t("routeBadge")} {batch.naiveKm} km (−{savedPct}%)
          </p>
        </>
      )}
      <MapView markers={markers} height={200} />
      {batch.status === "ASSIGNED" && (
        <button className="primary big" onClick={() => api.accept(batch.id).then(reload)}>
          ▶ {t("start")}
        </button>
      )}
      <ol className="stops">
        {live.map((s, i) => (
          <StopCard key={s.id} stop={s} index={i} active={batch.status === "ACTIVE"} focused={s.id === focusId} reload={reload} onNavigate={() => onNavigate(s, i)} />
        ))}
      </ol>
    </section>
  );
}

export function Collector() {
  const t = useT();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [focusId, setFocusId] = useState<string | undefined>();
  const [navTo, setNavTo] = useState<{ stop: Stop; index: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const load = useCallback(async () => {
    await flush();
    api.batches().then((r) => setBatches(r.batches)).catch(() => setBatches((b) => b ?? []));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    window.addEventListener("online", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", load);
    };
  }, [load]);

  const focus = (id: string) => {
    setFocusId(id);
    document.getElementById(`stop-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const hasEwaste = batches?.some((b) => b.stops.some((s) => s.status !== "PICKED" && s.items.some((i) => i.cat === "ewaste")));

  const openNav = (id: string) => {
    const all = batches?.flatMap((b) => b.stops.filter((s) => s.status !== "CANCELLED")) ?? [];
    const i = all.findIndex((s) => s.id === id);
    if (i >= 0) setNavTo({ stop: all[i]!, index: i });
  };

  if (navTo) {
    return (
      <Navigate
        stop={navTo.stop}
        index={navTo.index}
        onClose={() => setNavTo(null)}
        onArrive={() => {
          setFocusId(navTo.stop.id);
          setNavTo(null);
          setTimeout(() => document.getElementById(`stop-${navTo.stop.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
        }}
      />
    );
  }
  return (
    <>
      <h1>
        {t("today_batches")}{" "}
        <button className="link" onClick={() => setSettingsOpen(!settingsOpen)} aria-label={t("set_title")}>
          ⚙
        </button>
      </h1>
      {settingsOpen && <CollectorSettings onClose={() => setSettingsOpen(false)} />}
      {batches === null && <p>{t("loading")}</p>}
      {batches?.length === 0 && <p className="card muted">{t("noBatches")}</p>}
      {batches?.map((b) => (
        <BatchCard key={b.id} batch={b} focusId={focusId} reload={load} onNavigate={(s, i) => setNavTo({ stop: s, index: i })} />
      ))}
      <NearbyBoard onTaken={load} />
      {hasEwaste && <EwasteCard />}
      <div className="bolo-space" />
      <Bolo focusId={focusId} onFocus={focus} reload={load} onNavigate={openNav} />
    </>
  );
}
