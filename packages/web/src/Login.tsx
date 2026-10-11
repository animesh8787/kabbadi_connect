import { useState } from "react";
import { confirmSignUp, googleEnabled, signIn, signInCollector, signUp, startGoogle, type Session } from "./auth";
import { useT } from "./i18n";

export function Login({ onDone }: { onDone: (s: Session) => void }) {
  const t = useT();
  const [who, setWho] = useState<"house" | "kab">("house");
  const [phone, setPhone] = useState("");
  const [mode, setMode] = useState<"in" | "up" | "code">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (who === "kab") {
        onDone(await signInCollector(phone, password));
      } else if (mode === "up") {
        await signUp(email, password);
        setMode("code");
      } else if (mode === "code") {
        await confirmSignUp(email, code);
        onDone(await signIn(email, password));
      } else {
        onDone(await signIn(email, password));
      }
    } catch (x) {
      setErr((x as Error).message || t("error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <a className="muted" href="/">
          ← {t("app")}
        </a>
        <h1>{t("login_title")}</h1>
        <div className="subtabs" role="tablist">
          {(["house", "kab"] as const).map((w) => (
            <button type="button" role="tab" aria-selected={who === w} key={w} className={who === w ? "on" : ""} onClick={() => (setWho(w), setErr(""))}>
              {t(w === "house" ? "login_tab_house" : "login_tab_kab")}
            </button>
          ))}
        </div>
        {who === "kab" && (
          <>
            <label>
              {t("phoneNo")}
              <input type="tel" inputMode="tel" autoComplete="tel" required pattern="\+?\d{10,13}" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label>
              {t("password")}
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <p className="muted">{t("kab_hint")}</p>
            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {t("signIn")}
            </button>
          </>
        )}
        {who === "house" && googleEnabled() && mode !== "code" && (
          <>
            <button type="button" className="google" onClick={() => startGoogle()}>
              {t("login_google")}
            </button>
            <p className="muted" style={{ textAlign: "center" }}>
              {t("login_or")}
            </p>
          </>
        )}
        {who === "house" && (
        <>
        <label>
          {t("email")}
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={mode === "code"} />
        </label>
        {mode !== "code" ? (
          <label>
            {t("password")}
            <input
              type="password"
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              required
              minLength={mode === "up" ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "up" && <small className="muted">{t("passwordHint")}</small>}
          </label>
        ) : (
          <label>
            {t("code")}
            <input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {mode === "in" ? t("signIn") : mode === "up" ? t("signUp") : t("confirm")}
        </button>
        {mode !== "code" && (
          <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
            {mode === "in" ? t("noAccount") : t("haveAccount")}
          </button>
        )}
        </>
        )}
      </form>
    </div>
  );
}
