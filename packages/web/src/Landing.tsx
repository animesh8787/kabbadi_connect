import { useContext, useEffect, useState } from "react";
import { ApiError, submitJoin } from "./api";
import { apiUrl, loadConfig, type Session } from "./auth";
import { LangCtx, useT } from "./i18n";

interface PublicImpact {
  pickups: number;
  kg: number;
  co2Kg: number;
  ackKg: number;
  segTotal: number;
  segGood: number;
}

const SERVICES = ["Lambda", "API Gateway", "DynamoDB", "SQS", "EventBridge", "Location Service", "Cognito", "S3 + CloudFront", "Polly", "Transcribe", "Rekognition", "Bedrock"];

function JoinForm() {
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [area, setArea] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    try {
      await loadConfig();
      await submitJoin({ name, phone, area });
      setState("sent");
    } catch (x) {
      setMsg(x instanceof ApiError ? x.message : t("error"));
      setState("error");
    }
  }
  if (state === "sent") return <p role="status">{t("join_sent")}</p>;
  return (
    <form className="card" onSubmit={send}>
      <label>
        {t("name")}
        <input required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t("phoneNo")}
        <input required type="tel" inputMode="tel" pattern="\+?\d{10,13}" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label>
        {t("join_area")}
        <input required minLength={2} maxLength={80} value={area} onChange={(e) => setArea(e.target.value)} />
      </label>
      {state === "error" && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <button className="primary" disabled={state === "busy"}>
        {t("join_send")}
      </button>
    </form>
  );
}

/** Public landing page: what it is, live honest counters, how it works. */
export function Landing({ session }: { session: Session | null }) {
  const t = useT();
  const { lang, setLang } = useContext(LangCtx);
  const [impact, setImpact] = useState<PublicImpact | null>(null);

  useEffect(() => {
    loadConfig()
      .then(() => fetch(`${apiUrl()}/public/impact`))
      .then((r) => (r.ok ? r.json() : null))
      .then(setImpact)
      .catch(() => setImpact(null));
  }, []);

  const cta = session ? (
    <a className="btn primary" href="/app">
      {t("l_dash")}
    </a>
  ) : (
    <a className="btn primary" href="/login">
      {t("signIn")}
    </a>
  );

  return (
    <div className="site">
      <header className="nav">
        <a className="brand" href="/">
          ♻ {t("app")}
        </a>
        <nav className="links">
          <a href="#how">{t("l_nav_how")}</a>
          <a href="#kabadiwalas">{t("l_nav_kab")}</a>
          <a href="/methodology">{t("methodology")}</a>
          <button className="link" onClick={() => setLang(lang === "en" ? "hi" : "en")}>
            {t("language")}
          </button>
          {cta}
        </nav>
      </header>

      <div className="wrap">
        <section className="hero">
          <div>
            <span className="pill">{t("l_eyebrow")}</span>
            <h1>
              {t("l_h1a")} <em>{t("l_h1b")}</em>
            </h1>
            <p className="lead">{t("l_lead")}</p>
            <div className="cta">
              <a className="btn primary" href={session ? "/app" : "/login"}>
                {session ? t("l_dash") : t("l_book")}
              </a>
              <a className="btn" href="/judges">
                {t("l_judge")}
              </a>
            </div>
          </div>
          <div className="mock" aria-hidden="true">
            <span className="eyebrow">Today · 8 pickups · ~42 kg</span>
            {["Sector 4, Rohini", "Sector 7, Rohini", "Sector 9, Rohini"].map((a, i) => (
              <div className="row2" key={a}>
                <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span className="num">{i + 1}</span> {a}
                </span>
                <span className="muted">{["📰 🧴", "🥫 🔌", "🍾 📰"][i]}</span>
              </div>
            ))}
            <button className="primary big" tabIndex={-1}>
              🎤 दबाकर बोलिए
            </button>
          </div>
        </section>

        <div className="strip" aria-label="live impact">
          <div>
            <strong>{impact ? impact.kg : "–"}</strong>
            <span className="muted">{t("l_s_kg")}</span>
          </div>
          <div>
            <strong>{impact ? impact.co2Kg : "–"}</strong>
            <span className="muted">{t("l_s_co2")}</span>
          </div>
          <div>
            <strong>{impact ? impact.pickups : "–"}</strong>
            <span className="muted">{t("l_s_pick")}</span>
          </div>
          <div>
            <strong>{impact && impact.segTotal ? `${Math.round((impact.segGood / impact.segTotal) * 100)}%` : "–"}</strong>
            <span className="muted">{t("l_s_seg")}</span>
          </div>
        </div>

        <section className="section" id="how">
          <span className="eyebrow">01</span>
          <h2>{t("l_how")}</h2>
          <div className="grid3">
            {[
              ["l_s1t", "l_s1d"],
              ["l_s2t", "l_s2d"],
              ["l_s3t", "l_s3d"],
            ].map(([h, d], i) => (
              <div key={h}>
                <span className="step">0{i + 1}</span>
                <h3>{t(h as "l_s1t")}</h3>
                <p className="muted">{t(d as "l_s1d")}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" id="kabadiwalas">
          <span className="eyebrow">02</span>
          <h2>{t("l_kab")}</h2>
          <div className="grid3">
            {(["l_k1", "l_k2", "l_k3", "l_k4"] as const).map((k) => (
              <div key={k}>
                <p style={{ margin: 0 }}>{t(k)}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <span className="eyebrow">03</span>
          <h2>{t("l_honest")}</h2>
          <p className="muted" style={{ maxWidth: "40rem" }}>
            {t("l_honestd")}
          </p>
          <a className="btn" href="/methodology">
            {t("methodology")}
          </a>
        </section>

        <section className="section" id="join">
          <span className="eyebrow">04</span>
          <h2>{t("join_title")}</h2>
          <JoinForm />
        </section>

        <section className="section">
          <span className="eyebrow">05</span>
          <h2>{t("l_aws")}</h2>
          <div className="chips-row">
            {SERVICES.map((s) => (
              <span className="pill" key={s}>
                {s}
              </span>
            ))}
          </div>
        </section>

        <footer className="footer">
          <span>{t("l_foot")}</span>
          <span>
            <a href="https://github.com/animesh8787/kabbadi_connect">GitHub</a> · <a href="/judges">{t("l_judge")}</a>
          </span>
        </footer>
      </div>
    </div>
  );
}
