import { useEffect, useState } from "react";
import { CATEGORIES } from "@kc/shared";
import { api, type Ledger } from "./api";
import { useT } from "./i18n";

const thisMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);

/** Monthly statement for a collector (their own, or any collector for admins). Print it as income / EPR proof. */
export function Statement({ collectorId }: { collectorId?: string }) {
  const t = useT();
  const [month, setMonth] = useState(thisMonth());
  const [d, setD] = useState<Ledger | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setD(null);
    setErr(false);
    (collectorId ? api.adminLedger(collectorId, month) : api.ledger(month)).then(setD).catch(() => setErr(true));
  }, [collectorId, month]);

  return (
    <section className="card print-area">
      <h2>📄 {t("statement")}</h2>
      <label className="no-print">
        {t("month")}
        <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </label>
      {err && <p className="error">{t("error")}</p>}
      {!d && !err && <p>{t("loading")}</p>}
      {d && (
        <>
          <p>
            <strong>{d.collector.name}</strong> · {d.collector.phone} · {d.month}
          </p>
          <div className="tiles">
            <div className="tile">
              <strong>{d.kg}</strong>
              <span>{t("kg")}</span>
            </div>
            <div className="tile">
              <strong>₹{d.payout}</strong>
              <span>{t("paidOut")}</span>
            </div>
            <div className="tile">
              <strong>
                {d.verifiedPickups}/{d.pickups}
              </strong>
              <span>{t("verifiedPickups")}</span>
            </div>
            {d.segregationGoodPct !== null && (
              <div className="tile">
                <strong>{d.segregationGoodPct}%</strong>
                <span>{t("segRate")}</span>
              </div>
            )}
          </div>
          <p>{CATEGORIES.filter((c) => d.byCategory[c]).map((c) => `${t(c)}: ${d.byCategory[c]} ${t("kg")}`).join(" · ")}</p>
          <table>
            <tbody>
              {d.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.date}</td>
                  <td>
                    {r.kg} {t("kg")}
                  </td>
                  <td>₹{r.payout}</td>
                  <td>{r.verified ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{t("statementNote")}</p>
          <button className="no-print" onClick={() => window.print()}>
            🖨 {t("print")}
          </button>
        </>
      )}
    </section>
  );
}
