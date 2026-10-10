import { useEffect, useState } from "react";
import { current, finishGoogle, loadConfig, signInWithCard, signOut, type Session } from "./auth";
import { Admin } from "./Admin";
import { Collector } from "./Collector";
import { Collectors } from "./Collectors";
import { Household } from "./Dashboard";
import { Judges } from "./Judges";
import { Landing } from "./Landing";
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
        <a href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <strong>♻ {t("app")}</strong>
        </a>
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
let cardFailed = false;

export function App() {
  if (location.pathname === "/methodology") return <Methodology />;
  return location.pathname === "/judges" ? <Judges /> : <Main />;
}

function Main() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cardError, setCardError] = useState(false);
  const [path, setPath] = useState(location.pathname);
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
  const go = (to: string) => {
    history.pushState(null, "", to);
    setPath(to);
  };

  useEffect(() => {
    (async () => {
      await loadConfig();
      // One attempt per page load (React may run effects twice); the code is single use.
      cardAttempt ??= cardSignIn().catch(() => ((cardFailed = true), null));
      const s = await cardAttempt;
      if (s) {
        setLang("hi");
        setSession(s);
        history.replaceState(null, "", "/app");
        setPath("/app");
      } else if (cardFailed) {
        setCardError(true);
        go("/login");
      } else if (location.pathname === "/auth/callback") {
        try {
          setSession(await finishGoogle());
          go("/app");
        } catch {
          setCardError(true);
          go("/login");
        }
      }
      setReady(true);
    })().catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const back = () => setPath(location.pathname);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  // Signed-out visitors to the app go to the login; signed-in visitors skip it.
  const route = path === "/app" && !session ? "/login" : path === "/login" && session ? "/app" : path;

  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      {failed ? (
        <p className="error">Cannot load app configuration.</p>
      ) : !ready ? null : route === "/app" && session ? (
        <Home session={session} lang={lang} setLang={setLang} onOut={() => (signOut(), setSession(null), go("/"))} />
      ) : route === "/login" ? (
        <>
          {cardError && <CardError />}
          <Login
            onDone={(s) => {
              setSession(s);
              go("/app");
            }}
          />
        </>
      ) : (
        <Landing session={session} />
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
