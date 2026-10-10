import { useRef, useState } from "react";
import { api, ApiError, type Action, type Batch } from "./api";
import { useT } from "./i18n";
import { play, startRecording, yesNo, type Recording } from "./voice";

const phrases = new Map<string, { audio: string; mime: string }>();

/** Speak a fixed phrase; the audio is cached on the phone so repeats cost nothing. */
async function say(text: string) {
  let hit = phrases.get(text);
  if (!hit) {
    const r = await api.speak(text);
    hit = { audio: r.audio, mime: r.audioMime };
    phrases.set(text, hit);
  }
  await play(hit.audio, hit.mime);
}

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

/** Hold-to-talk Hindi assistant. It proposes; changes only happen after a spoken or tapped yes. */
export function Bolo({ batches, focusId, onFocus, reload }: { batches: Batch[]; focusId?: string; onFocus: (id: string) => void; reload: () => void }) {
  const t = useT();
  const rec = useRef<Recording | null>(null);
  const [state, setState] = useState<"idle" | "listening" | "thinking">("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState<{ action: Action; say: string } | null>(null);
  const [err, setErr] = useState("");

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
        window.open(mapsUrl(a.lat, a.lng), "_blank", "noreferrer");
        return;
    }
    reload();
    await say(t("done_saved")).catch(() => {});
  }

  async function answer(yes: boolean) {
    const p = pending;
    setPending(null);
    if (!p) return;
    try {
      if (yes) await run(p.action);
      else await say("ठीक है, रद्द किया।").catch(() => {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
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
    try {
      const wav = await r.stop();
      if (!wav) return;
      if (pending) {
        const { heard: h } = await api.assistant({ audio: wav, transcribeOnly: true });
        setHeard(h);
        const a = yesNo(h);
        if (a) await answer(a === "yes");
        else await say(t("say_yes_no")).catch(() => {});
        return;
      }
      const turn = await api.assistant({ audio: wav, focusStopId: focusId });
      setHeard(turn.heard);
      setReply(turn.say ?? "");
      if (turn.audio) void play(turn.audio, turn.audioMime ?? "audio/mpeg");
      if (turn.action && turn.needsConfirm) setPending({ action: turn.action, say: turn.say ?? "" });
      else if (turn.action) await run(turn.action);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
    } finally {
      setState("idle");
    }
  }

  const summary = async () => {
    try {
      const turn = await api.assistant({ text: "aaj ke pickup ka hisaab batao" });
      setReply(turn.say ?? "");
      if (turn.audio) void play(turn.audio, turn.audioMime ?? "audio/mpeg");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("error"));
    }
  };

  void batches;
  return (
    <div className="bolo" aria-live="polite">
      {(reply || heard || err) && (
        <div className="bolo-text">
          {heard && <div className="muted">🗣 {heard}</div>}
          {reply && <div>🔊 {reply}</div>}
          {err && <div className="error">{err}</div>}
        </div>
      )}
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
        <button
          className={"mic" + (state === "listening" ? " live" : "")}
          onPointerDown={down}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
          disabled={state === "thinking"}
          aria-label={t("bolo_hold")}
        >
          🎤 {state === "listening" ? t("bolo_listening") : state === "thinking" ? t("bolo_thinking") : t("bolo_hold")}
        </button>
      </div>
    </div>
  );
}
