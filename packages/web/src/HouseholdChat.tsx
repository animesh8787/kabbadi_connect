import { useRef, useState } from "react";
import { slotLabel } from "@kc/shared";
import { api, ApiError, type HAction } from "./api";
import { useT } from "./i18n";
import { play, startRecording, type Recording } from "./voice";

export interface Booking {
  items: { cat: string; bucket: string }[];
  date: string;
  slot: string;
  notes?: string;
}
interface Msg {
  role: "user" | "assistant";
  text: string;
}

/**
 * Chat for booking: type or speak "kal shaam 5 kilo raddi". The assistant proposes; nothing is booked until Confirm.
 * Without a saved address the booking opens in the normal form, pre-filled, so the pin can be placed.
 */
export function HouseholdChat({ onChanged, onOpenForm }: { onChanged: () => void; onOpenForm: (b: Booking) => void }) {
  const t = useT();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<HAction | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recording | null>(null);

  const add = (m: Msg) => setMsgs((x) => [...x, m]);
  const history = () => msgs.slice(-6);

  async function turn(b: { text?: string; audio?: string }) {
    setBusy(true);
    setPending(null);
    try {
      const r = await api.householdAssistant({ ...b, speak: !!b.audio, history: history() });
      if (r.heard) add({ role: "user", text: r.heard });
      add({ role: "assistant", text: r.say });
      if (r.audio) void play(r.audio, r.audioMime ?? "audio/mpeg");
      if (r.action && r.needsConfirm) setPending(r.action);
    } catch (e) {
      add({ role: "assistant", text: e instanceof ApiError ? e.message : t("error") });
    } finally {
      setBusy(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    add({ role: "user", text });
    await turn({ text });
  }

  async function confirm() {
    const a = pending;
    if (!a) return;
    setPending(null);
    try {
      if (a.type === "book" && a.booking) {
        const { profile } = await api.profile();
        if (!profile) {
          add({ role: "assistant", text: t("ha_need_addr") });
          return onOpenForm(a.booking);
        }
        await api.create({
          items: a.booking.items as never,
          date: a.booking.date,
          slot: a.booking.slot as never,
          notes: a.booking.notes,
          address: profile.address,
          lat: profile.lat,
          lng: profile.lng,
          phone: profile.phone,
        });
        add({ role: "assistant", text: `✓ ${t("ha_booked")}: ${a.booking.date} ${slotLabel(a.booking.slot)}` });
      } else if (a.type === "reschedule" && a.id && a.date && a.slot) {
        await api.reschedule(a.id, { date: a.date, slot: a.slot });
        add({ role: "assistant", text: `✓ ${t("ha_moved")}: ${a.date} ${slotLabel(a.slot)}` });
      } else if (a.type === "cancel" && a.id) {
        await api.cancel(a.id);
        add({ role: "assistant", text: `✓ ${t("ha_cancelled")}` });
      }
      onChanged();
    } catch (e) {
      add({ role: "assistant", text: e instanceof ApiError ? e.message : t("error") });
    }
  }

  async function micDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    try {
      rec.current = await startRecording();
      setListening(true);
    } catch {
      add({ role: "assistant", text: t("mic_denied") });
    }
  }
  async function micUp() {
    const r = rec.current;
    rec.current = null;
    setListening(false);
    if (!r) return;
    const wav = await r.stop();
    if (wav) await turn({ audio: wav });
  }

  return (
    <section className="card chat" aria-label={t("ha_title")}>
      <h2>💬 {t("ha_title")}</h2>
      <div className="chat-log" aria-live="polite">
        {msgs.length === 0 && <p className="muted">{t("ha_hello")}</p>}
        {msgs.map((m, i) => (
          <p key={i} className={"bubble " + m.role}>
            {m.text}
          </p>
        ))}
      </div>
      {pending && (
        <div className="actions">
          <button className="primary" onClick={confirm}>
            ✅ {t("confirm")}
          </button>
          <button onClick={() => setPending(null)}>{t("ha_not_now")}</button>
        </div>
      )}
      <form className="chat-input" onSubmit={send}>
        <input aria-label={t("ha_ph")} placeholder={t("ha_ph")} value={input} maxLength={400} onChange={(e) => setInput(e.target.value)} disabled={busy} />
        <button className="primary" disabled={busy || !input.trim()}>
          {t("ha_send")}
        </button>
        <button type="button" className={listening ? "live" : ""} onPointerDown={micDown} onPointerUp={micUp} onPointerCancel={micUp} onContextMenu={(e) => e.preventDefault()} disabled={busy} aria-label={t("ha_speak")}>
          🎤
        </button>
      </form>
    </section>
  );
}
