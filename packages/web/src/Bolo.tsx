import { useRef, useState } from "react";
import { api, ApiError, type Action, type Batch } from "./api";
import { useT } from "./i18n";
import { navState, say } from "./speak";
import { play, recordUntilSilence, startRecording, yesNo, type Recording } from "./voice";

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
const STOP_WORDS = /(^|\s)(बस|रुको|बंद करो|bas|ruko|stop)(\s|$|[.!,।])/i;

type Msg = { role: "user" | "assistant"; text: string };

/** Hindi assistant: hold to talk, or hands-free. Asks anything about the day's work; changes happen only after a spoken or tapped yes. */
export function Bolo({ focusId, onFocus, reload, onNavigate }: { batches?: Batch[]; focusId?: string; onFocus: (id: string) => void; reload: () => void; onNavigate: (stopId: string) => void }) {
  const t = useT();
  const rec = useRef<Recording | null>(null);
  const handsFree = useRef(false);
  const history = useRef<Msg[]>([]);
  const [state, setState] = useState<"idle" | "listening" | "thinking">("idle");
  const [free, setFree] = useState(false);
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState<{ action: Action; say: string } | null>(null);
  const pendingRef = useRef<typeof pending>(null);
  const [err, setErr] = useState("");

  const setPend = (p: typeof pending) => {
    pendingRef.current = p;
    setPending(p);
  };
  const remember = (role: Msg["role"], text: string) => {
    if (text) history.current = [...history.current, { role, text }].slice(-6);
  };

  /** Where the phone is, best effort, so "anything nearby?" can be answered. */
  const where = () =>
    new Promise<{ lat: number; lng: number } | undefined>((res) => {
      if (!navigator.geolocation) return res(undefined);
      navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(undefined), { maximumAge: 60_000, timeout: 2500 });
    });

  async function run(a: Action) {
    switch (a.type) {
      case "focus":
        return onFocus(a.stopId);
      case "start":
        await api.accept(a.batchId);
        break;
      case "confirm":
        await api.confirm(a.stopId, { items: a.items, segregation: a.segregation });
        break;
      case "missed":
        await api.missed(a.stopId);
        break;
      case "call":
        location.href = `tel:${a.phone}`;
        return;
      case "navigate":
        if (focusId) return onNavigate(focusId);
        window.open(mapsUrl(a.lat, a.lng), "_blank", "noreferrer");
        return;
      case "next_turn":
        await say(navState.text || "रास्ता चालू नहीं है। पहले रास्ता शुरू कीजिए।").catch(() => {});
        return;
    }
    reload();
    await say(t("done_saved")).catch(() => {});
  }

  async function answer(yes: boolean) {
    const p = pendingRef.current;
    setPend(null);
    if (!p) return;
    try {
      if (yes) await run(p.action);
      else await say("ठीक है, रद्द किया।").catch(() => {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
    }
  }

  /** One spoken turn, from either the hold button or hands-free mode. Returns the transcript. */
  async function handle(wav: string): Promise<string> {
    setState("thinking");
    try {
      if (pendingRef.current) {
        const { heard: h } = await api.assistant({ audio: wav, transcribeOnly: true });
        setHeard(h);
        const a = yesNo(h);
        if (a) await answer(a === "yes");
        else await say(t("say_yes_no")).catch(() => {});
        return h;
      }
      const turn = await api.assistant({ audio: wav, focusStopId: focusId, history: history.current, location: await where() });
      setHeard(turn.heard);
      setReply(turn.say ?? "");
      remember("user", turn.heard);
      remember("assistant", turn.say ?? "");
      if (turn.audio) await play(turn.audio, turn.audioMime ?? "audio/mpeg");
      if (turn.action && turn.needsConfirm) setPend({ action: turn.action, say: turn.say ?? "" });
      else if (turn.action) await run(turn.action);
      return turn.heard;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
      return "";
    } finally {
      setState("idle");
    }
  }

  async function down(e: React.PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setErr("");
    try {
      rec.current = await startRecording();
      setState("listening");
    } catch {
      setErr(t("mic_denied"));
    }
  }

  async function up() {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    setState("thinking");
    const wav = await r.stop();
    if (wav) await handle(wav);
    else setState("idle");
  }

  /** Hands-free: keep listening turn after turn until "bas", three silent rounds, or the button is pressed again. */
  async function toggleFree() {
    if (handsFree.current) {
      handsFree.current = false;
      setFree(false);
      return;
    }
    handsFree.current = true;
    setFree(true);
    setErr("");
    let quiet = 0;
    try {
      while (handsFree.current && quiet < 3) {
        setState("listening");
        const wav = await recordUntilSilence(() => handsFree.current);
        if (!handsFree.current) break;
        if (!wav) {
          quiet++;
          continue;
        }
        quiet = 0;
        const said = await handle(wav);
        if (STOP_WORDS.test(said)) break;
      }
    } catch {
      setErr(t("mic_denied"));
    } finally {
      handsFree.current = false;
      setFree(false);
      setState("idle");
    }
  }

  const summary = async () => {
    try {
      const turn = await api.assistant({ text: "aaj ke pickup ka hisaab batao", history: history.current });
      setReply(turn.say ?? "");
      if (turn.audio) void play(turn.audio, turn.audioMime ?? "audio/mpeg");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
    }
  };

  return (
    <div className="bolo" aria-live="polite">
      {(reply || heard || err) && (
        <div className="bolo-text">
          {heard && <div className="muted">🗣 {heard}</div>}
          {reply && <div>🔊 {reply}</div>}
          {err && <div className="error">{err}</div>}
        </div>
      )}
      {free && <div className="muted">🎧 {t("bolo_hands_on")}</div>}
      {pending && (
        <div className="actions">
          <button className="primary big" onClick={() => answer(true)}>
            ✅ {t("yes_btn")}
          </button>
          <button className="big" onClick={() => answer(false)}>
            ❌ {t("no_btn")}
          </button>
        </div>
      )}
      <div className="bolo-row">
        <button className="big" onClick={summary} aria-label={t("sunao")}>
          🔊
        </button>
        <button className={"big" + (free ? " on" : "")} onClick={toggleFree} aria-pressed={free} aria-label={t("bolo_hands")}>
          🎧
        </button>
        <button
          className={"mic" + (state === "listening" ? " live" : "")}
          onPointerDown={down}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
          disabled={state === "thinking" || free}
          aria-label={t("bolo_hold")}
        >
          🎤 {state === "listening" ? t("bolo_listening") : state === "thinking" ? t("bolo_thinking") : t("bolo_hold")}
        </button>
      </div>
    </div>
  );
}
