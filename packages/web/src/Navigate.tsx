import { useContext, useEffect, useRef, useState } from "react";
import { instruction, nextManeuver } from "@kc/shared";
import { api, type RouteInfo, type Stop } from "./api";
import { LangCtx, useT } from "./i18n";
import { MapView } from "./MapView";
import { navState, say } from "./speak";

type Pos = { lat: number; lng: number };

/** Walking directions to one stop, spoken in Hindi as you go, like a map app: "150 मीटर बाद बाएँ मुड़ें". */
export function Navigate({ stop, index, onClose, onArrive }: { stop: Stop; index: number; onClose: () => void; onArrive: () => void }) {
  const t = useT();
  const { lang } = useContext(LangCtx);
  const [pos, setPos] = useState<Pos | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [text, setText] = useState("");
  const [meters, setMeters] = useState<number | null>(null);
  const [status, setStatus] = useState<"locating" | "ok" | "off" | "denied" | "fail" | "arrived">("locating");
  const spoken = useRef(new Set<string>());
  const off = useRef(0);
  const lastFetch = useRef(0);
  const lastPost = useRef(0);
  const routeRef = useRef<RouteInfo | null>(null);
  const label = `${lang === "hi" ? "स्टॉप" : "stop"} ${index + 1}`;

  const speak = (s: string, key: string) => {
    if (spoken.current.has(key)) return;
    spoken.current.add(key);
    say(s).catch(() => {});
  };

  async function fetchRoute(p: Pos) {
    lastFetch.current = Date.now();
    try {
      const r = await api.route(stop.id, p);
      routeRef.current = r;
      setRoute(r);
      spoken.current = new Set();
      off.current = 0;
      setStatus("ok");
      apply(p);
    } catch {
      setStatus("fail");
    }
  }

  /** Update the spoken/visible instruction for a position along the current route. */
  function apply(p: Pos) {
    const r = routeRef.current;
    if (!r) return;
    const n = nextManeuver(r.line, r.maneuvers, p);
    // Two readings in a row more than 40 m from the line means we left the route; ask for a new one (at most every 20 s).
    off.current = n.offRouteM > 40 ? off.current + 1 : 0;
    if (off.current >= 2 && Date.now() - lastFetch.current > 20_000) {
      setStatus("off");
      void fetchRoute(p);
      return;
    }
    if (!n.maneuver) return;
    const arrive = n.maneuver.kind === "arrive";
    const line = instruction(n.maneuver, n.distanceM, lang, arrive ? label : undefined);
    setText(line);
    setMeters(n.distanceM);
    navState.text = line;
    const key = `${n.maneuver.idx}`;
    if (arrive && n.distanceM <= 30) {
      speak(line, `${key}:arrived`);
      setStatus("arrived");
    } else if (n.distanceM <= 50) speak(line, `${key}:50`);
    else if (n.distanceM <= 200) speak(line, `${key}:200`);
  }

  useEffect(() => {
    if (!navigator.geolocation) return setStatus("denied");
    let lock: { release: () => Promise<void> } | undefined;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    const id = navigator.geolocation.watchPosition(
      (g) => {
        const p = { lat: g.coords.latitude, lng: g.coords.longitude };
        setPos(p);
        // The household sees "on the way" from this; shared only while this screen is open.
        if (Date.now() - lastPost.current > 30_000) {
          lastPost.current = Date.now();
          api.position({ ...p, stopId: stop.id }).catch(() => {});
        }
        const r = routeRef.current;
        if (!r) {
          if (Date.now() - lastFetch.current > 20_000) void fetchRoute(p);
          return;
        }
        apply(p);
      },
      // Only a refusal means location is off; a missed reading (timeout, no signal) just waits for the next one.
      (err) => err.code === err.PERMISSION_DENIED && setStatus("denied"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15_000 },
    );
    return () => {
      navigator.geolocation.clearWatch(id);
      void lock?.release();
      navState.text = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop.id, lang]);

  const banner =
    status === "locating" ? t("nav_locating") : status === "denied" ? t("nav_denied") : status === "fail" ? t("nav_fail") : status === "off" ? t("nav_off") : status === "arrived" ? t("nav_arrived") : text || t("nav_locating");

  return (
    <section className="card nav" aria-live="polite">
      <div className="nav-banner" data-testid="nav-banner">
        <strong>{banner}</strong>
        {meters !== null && status === "ok" && <span className="muted"> · {meters} m</span>}
      </div>
      <MapView markers={[{ lat: stop.lat, lng: stop.lng, label: String(index + 1) }]} pin={pos} line={route?.line} follow height={280} />
      <p className="muted">
        {stop.address}
        {route ? ` · ${Math.round(route.distanceM || 0)} m` : ""}
      </p>
      <div className="actions">
        {status === "arrived" && (
          <button className="primary big" onClick={onArrive}>
            ✅ {t("nav_arrived")}
          </button>
        )}
        <a className="btn" href={`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&travelmode=walking`} target="_blank" rel="noreferrer">
          🧭 Google Maps
        </a>
        <button onClick={onClose}>{t("nav_end")}</button>
      </div>
    </section>
  );
}
