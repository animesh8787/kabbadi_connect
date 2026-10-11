import QRCode from "qrcode";
import { useState } from "react";
import { apiUrl, loadConfig } from "./auth";

/** Public page for reviewers: start a ready-made collector demo without any login. English only. */
export function Judges() {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function start() {
    setBusy(true);
    setErr("");
    try {
      await loadConfig();
      const res = await fetch(`${apiUrl()}/demo/start`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not start the demo");
      const url = `${location.origin}/?enroll=${encodeURIComponent(d.code)}&u=${encodeURIComponent(d.username)}`;
      setLink(url);
      setQr(await QRCode.toDataURL(url, { width: 280, margin: 1, errorCorrectionLevel: "M" }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="prose">
      <p>
        <a href="/">← Kabadi Connect</a>
      </p>
      <h1>Try Kabadi Connect</h1>
      <p>
        Kabadiwalas (informal scrap collectors) do much of India's recycling. This app lets households book pickups and gives collectors a routed list, a Hindi voice assistant, and a monthly
        statement. A collector signs in by scanning a printed QR card, with no email or password.
      </p>

      <h2>1. Get a demo collector card</h2>
      <p>This creates a throwaway collector with three ready pickups. It is separate from real data and expires after 3 days.</p>
      {!link && (
        <button className="primary big" onClick={start} disabled={busy}>
          {busy ? "Creating…" : "Start collector demo"}
        </button>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {link && (
        <section className="card card-print">
          <p>
            <strong>Scan with your phone camera</strong> to open the collector app, already signed in.
          </p>
          <img src={qr} alt="QR code for the demo collector card" width={240} height={240} />
          <p className="muted">The code works once. Or open it on this device:</p>
          <a className="btn primary" href={link}>
            Open the collector app here
          </a>
        </section>
      )}

      <h2>2. Things to try (hold the 🎤 button while speaking)</h2>
      <ul>
        <li>
          <em>"agla ghar kahan hai"</em>: the app reads the next address.
        </li>
        <li>
          <em>"shuru karo"</em>, then say <em>"haan"</em>: starts the route.
        </li>
        <li>
          <em>"paanch kilo kagaz, do kilo loha, achha alag tha"</em>, then <em>"haan"</em>: records weights and a segregation rating.
        </li>
        <li>
          <em>"ghar par koi nahi"</em>: marks nobody home.
        </li>
        <li>Ask it anything about the day, for example <em>"is hafte kitna kamaya"</em> or <em>"e-waste kahan dun"</em>. Tap 🎧 for hands-free, and 🧭 on a stop for spoken Hindi turn-by-turn directions (needs location permission).</li>
        <li>Under the map, switch between the optimised route and the order the requests came in to see the km saved.</li>
        <li>Nothing is saved until the collector says or taps yes. You can type the weights instead: every voice action has a button.</li>
        <li>Open the e-waste stop to see the government-listed authorised recyclers; open the Statement tab for the monthly statement.</li>
      </ul>

      <h2>3. Household side</h2>
      <p>
        <a href="/login">Sign up with an email</a> to book a pickup as a household (the app asks for the verification code Cognito emails you). Pick any of the next 7 days and a two-hour slot, or tap <em>Speak</em> and type or say <em>"kal shaam 5 kilo raddi"</em>: the assistant proposes a booking and you confirm it.
      </p>

      <h2>What is live, and what is not</h2>
      <ul>
        <li>Hindi speech uses Amazon Transcribe and Polly. Bhashini is integrated but its API approval is pending, so it is not in use yet.</li>
        <li>Understanding of what is said uses Amazon Bedrock when available, then Groq (a free model) for open questions, then keyword matching for the phrases above. Photo fill uses Bedrock or, failing that, Amazon Rekognition labels.</li>
        <li>
          Impact numbers and their limits are explained in <a href="/methodology">How we count impact</a>. CO₂ factors are indicative.
        </li>
      </ul>
    </main>
  );
}
