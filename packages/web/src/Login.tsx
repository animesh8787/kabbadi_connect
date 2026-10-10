import { useState } from "react";
import { confirmSignUp, signIn, signUp, type Session } from "./auth";
import { useT } from "./i18n";

export function Login({ onDone }: { onDone: (s: Session) => void }) {
  const t = useT();
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
      if (mode === "up") {
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
    <form className="card narrow" onSubmit={submit}>
      <h1>{t("app")}</h1>
      <p className="muted">{t("tagline")}</p>
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
      <a className="muted" href="/methodology">
        {t("methodology")}
      </a>
    </form>
  );
}
