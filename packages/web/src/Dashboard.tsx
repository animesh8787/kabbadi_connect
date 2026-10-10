import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, factors, ewaste, type Category } from "@kc/shared";
import { api, type Req } from "./api";
import { EMOJI, NewPickup } from "./Household";
import { useT, type Key } from "./i18n";

const LIVE: Req["status"][] = ["OPEN", "ASSIGNED", "EN_ROUTE"];
const STEP: Record<string, number> = { OPEN: 0, ASSIGNED: 1, EN_ROUTE: 2, PICKED: 3 };
const kgOf = (r: Req) => (r.actual ?? []).reduce((s, a) => s + a.kg, 0);

type Tab = "home" | "book" | "history" | "rates";

/** Household area: next-pickup tracker, personal impact, booking, history with receipts, rates and sorting guide. */
export function Household() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("home");
  const [list, setList] = useState<Req[] | null>(null);
  const [receipt, setReceipt] = useState<Req | null>(null);
  const load = useCallback(() => api.mine().then((r) => setList(r.requests)).catch(() => setList((l) => l ?? [])), []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const tabs: [Tab, Key][] = [
    ["home", "d_home"],
    ["book", "d_book"],
    ["history", "d_hist"],
    ["rates", "d_rates"],
  ];

  if (receipt) return <Receipt r={receipt} onClose={() => setReceipt(null)} />;
  return (
    <>
      <nav className="subtabs no-print" aria-label="household">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} aria-current={tab === k} onClick={() => setTab(k)}>
            {t(label)}
          </button>
        ))}
      </nav>
      {tab === "home" && <Home list={list} go={setTab} />}
      {tab === "book" && (
        <NewPickup
          onCreated={() => {
            load();
            setTab("home");
          }}
        />
      )}
      {tab === "history" && <History list={list} reload={load} onReceipt={setReceipt} />}
      {tab === "rates" && <Rates />}
    </>
  );
}

function Home({ list, go }: { list: Req[] | null; go: (t: Tab) => void }) {
  const t = useT();
  if (list === null) return <p>{t("loading")}</p>;
  // soonest unfinished pickup; if none, the most recent finished one
  const next = [...list].filter((r) => LIVE.includes(r.status)).sort((a, b) => a.date.localeCompare(b.date))[0];
  const last = list.find((r) => r.status === "PICKED");
  const shown = next ?? last;
  const picked = list.filter((r) => r.status === "PICKED");
  const kg = +picked.reduce((s, r) => s + kgOf(r), 0).toFixed(1);
  const rated = picked.filter((r) => r.segregation);
  const score = rated.length ? `${Math.round((rated.filter((r) => r.segregation === "good").length / rated.length) * 100)}%` : "–";
  const labels = [t("st_wait"), t("st_assigned"), t("st_onway"), t("st_picked")];

  return (
    <>
      <section className="card tracker">
        <span className="eyebrow">{t("d_next")}</span>
        {shown ? (
          <>
            <h2>
              {shown.items.map((i) => EMOJI[i.cat]).join(" ")} {shown.address}
            </h2>
            <div className="muted">
              {shown.date} · {t(shown.slot as "morning" | "evening")}
            </div>
            <div className="steps" role="list">
              {labels.map((l, i) => (
                <div key={l} role="listitem" className={i <= (STEP[shown.status] ?? 0) ? "done" : ""}>
                  {l}
                </div>
              ))}
            </div>
            {!next && <span className="badge PICKED">{t("d_done")}</span>}
          </>
        ) : (
          <h2>{t("d_none")}</h2>
        )}
        <button className="primary" onClick={() => go("book")}>
          {t("l_book")}
        </button>
      </section>

      <section className="card">
        <h2>{t("d_impact")}</h2>
        <div className="bigstat">
          <div>
            <strong>{kg}</strong>
            <span>{t("d_kg")}</span>
          </div>
          <div>
            <strong>₹{picked.reduce((s, r) => s + (r.payout ?? 0), 0)}</strong>
            <span>{t("d_earn")}</span>
          </div>
          <div>
            <strong>{+picked.reduce((s, r) => s + (r.co2Kg ?? 0), 0).toFixed(1)}</strong>
            <span>{t("d_co2")}</span>
          </div>
          <div>
            <strong>{score}</strong>
            <span>{t("d_score")}</span>
          </div>
        </div>
        <p className="muted">
          {t("factorsNote")} <a href="/methodology">{t("methodology")}</a>
        </p>
      </section>
    </>
  );
}

function History({ list, reload, onReceipt }: { list: Req[] | null; reload: () => void; onReceipt: (r: Req) => void }) {
  const t = useT();
  return (
    <section className="card">
      <h2>{t("myPickups")}</h2>
      {list === null ? <p>{t("loading")}</p> : list.length === 0 ? <p className="muted">{t("none")}</p> : null}
      <ul className="list">
        {list?.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.items.map((i) => EMOJI[i.cat]).join(" ")}</strong> {r.address}
              <div className="muted">
                {r.date} · {t(r.slot as "morning" | "evening")}
              </div>
              <span className={"badge " + r.status}>{t(r.status)}</span>
              {r.status === "PICKED" && r.actual && (
                <div>
                  {r.actual.map((a) => `${EMOJI[a.cat]} ${a.kg} ${t("kg")}`).join(" · ")} — <strong>₹{r.payout}</strong>
                  {r.segregation && <span> · {r.segregation === "good" ? `👍 ${t("seg_good")}` : `👎 ${t("seg_mixed")}`}</span>}
                </div>
              )}
            </div>
            <div className="stack">
              {(r.status === "OPEN" || r.status === "ASSIGNED") && <button onClick={() => api.cancel(r.id).then(reload)}>{t("cancel")}</button>}
              {r.status === "PICKED" && (
                <>
                  {r.householdAck ? <span className="muted">✓ {t("acked")}</span> : <button onClick={() => api.ack(r.id).then(reload)}>{t("ack")}</button>}
                  <button onClick={() => onReceipt(r)}>🧾 {t("d_receipt")}</button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Printable receipt: no collector or household contact details, only what was picked up. */
function Receipt({ r, onClose }: { r: Req; onClose: () => void }) {
  const t = useT();
  return (
    <section className="card print-area">
      <h2>🧾 {t("d_receipt")}</h2>
      <p>
        {r.address}
        <br />
        {r.date}
      </p>
      <table className="rates">
        <tbody>
          {(r.actual ?? []).map((a) => (
            <tr key={a.cat}>
              <td>
                {EMOJI[a.cat]} {t(a.cat)}
              </td>
              <td>
                {a.kg} {t("kg")}
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>₹</strong>
            </td>
            <td>
              <strong>{r.payout}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        {r.householdAck ? `✓ ${t("acked")}` : ""} · {t("statementNote")}
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

function Rates() {
  const t = useT();
  return (
    <>
      <section className="card">
        <h2>{t("d_rates_t")}</h2>
        <table className="rates">
          <tbody>
            {CATEGORIES.map((c: Category) => (
              <tr key={c}>
                <td>
                  {EMOJI[c]} {t(c)}
                </td>
                <td>₹{factors.ratePerKg[c]}</td>
                <td className="muted">{t(`g_${c}` as Key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">{t("d_rates_n")}</p>
      </section>
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
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
