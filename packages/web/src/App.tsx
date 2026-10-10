import { useEffect, useState } from "react";
import { current, loadConfig, signInWithCard, signOut, type Session } from "./auth";
import { Admin } from "./Admin";
import { Collector } from "./Collector";
import { Collectors } from "./Collectors";
import { Household } from "./Household";
import { LangCtx, useT, type Lang } from "./i18n";
import { Login } from "./Login";
import { Methodology } from "./Methodology";
import { Statement } from "./Statement";

type Tab = "household" | "collector" | "statement" | "admin" | "collectors";

function Home({ session, onOut, lang, setLang }: { session: Session; onOut: () => void; lang: Lang; setLang: (l: Lang) => void }) {
  const t = useT();
  const g = session.groups;
  const isAdmin = g.includes("admin");
  const isCollector = g.includes("collector");
  const tabs = (
    [
      ["household", g.includes("household") || isAdmin, t("tabHousehold")],
      ["collector", isCollector, t("tabCollector")],
      ["statement", isCollector, t("tabStatement")],
      ["admin", isAdmin, t("tabAdmin")],
      ["collectors", isAdmin, t("tabCollectors")],
    ] as const
  ).filter(([, ok]) => ok);
  const [tab, setTab] = useState<Tab>(isCollector ? "collector" : isAdmin ? "admin" : "household");
  return (
    <>
      <header className="bar-top no-print">
        <strong>♻ {t("app")}</strong>
        <span>
          <button className="link" onClick={() => setLang(lang === "en" ? "hi" : "en")}>
            {t("language")}
          </button>
          <button className="link" onClick={onOut}>
            {t("signOut")}
          </button>
        </span>
      </header>
      {tabs.length > 1 && (
        <nav className="tabs no-print">
          {tabs.map(([k, , label]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
      )}
      <main>
        {tab === "collector" ? <Collector /> : tab === "statement" ? <Statement /> : tab === "admin" ? <Admin /> : tab === "collectors" ? <Collectors /> : <Household />}
      </main>
    </>
  );
}

/** A collector opens their QR card link: sign in once with the one-time code, then drop it from the URL. */
async function cardSignIn(): Promise<Session | null> {
  const q = new URLSearchParams(location.search);
  const code = q.get("enroll");
  const user = q.get("u");
  if (!code || !user) return null;
  history.replaceState(null, "", location.pathname);
  return signInWithCard(user, code);
}
let cardAttempt: Promise<Session | null> | undefined;

export function App() {
  return location.pathname === "/methodology" ? <Methodology /> : <Main />;
}

function Main() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cardError, setCardError] = useState(false);
  const [session, setSession] = useState<Session | null>(current());
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return (localStorage.getItem("kc.lang") as Lang) || (current()?.groups.includes("collector") ? "hi" : "en");
    } catch {
      return "en";
    }
  });
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("kc.lang", l);
    } catch {
      /* storage blocked: language just won't persist */
    }
    document.documentElement.lang = l;
  };

  useEffect(() => {
    (async () => {
      await loadConfig();
      // One attempt per page load (React may run effects twice); the code is single use.
      cardAttempt ??= cardSignIn().catch(() => (setCardError(true), null));
      const s = await cardAttempt;
      if (s) {
        setLang("hi");
        setSession(s);
      }
      setReady(true);
    })().catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      {failed ? (
        <p className="error">Cannot load app configuration.</p>
      ) : !ready ? null : session ? (
        <Home session={session} lang={lang} setLang={setLang} onOut={() => (signOut(), setSession(null))} />
      ) : (
        <>
          {cardError && <CardError />}
          <Login onDone={(s) => setSession(s)} />
        </>
      )}
    </LangCtx.Provider>
  );
}

function CardError() {
  const t = useT();
  return (
    <p className="error card narrow" role="alert">
      {t("cardBad")}
    </p>
  );
}
