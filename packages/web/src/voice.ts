/** Mic capture to a 16 kHz mono WAV (what both Bhashini and Transcribe take) and audio playback. */

const TARGET_RATE = 16000;

export interface Recording {
  /** Stop recording and return the WAV as base64, or null if nothing usable was captured. */
  stop: () => Promise<string | null>;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          try {
            const blob = new Blob(parts, { type: rec.mimeType });
            resolve(blob.size < 1500 ? null : await toWav16k(await blob.arrayBuffer()));
          } catch {
            resolve(null);
          }
        };
        rec.stop();
      }),
  };
}

/** Decode whatever the browser recorded (webm/opus, mp4/aac), resample to 16 kHz mono, wrap as WAV. */
async function toWav16k(buf: ArrayBuffer): Promise<string> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);
  void ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  return bytesToBase64(encodeWav(pcm));
}

function encodeWav(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, TARGET_RATE, true);
  out.setUint32(28, TARGET_RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

let current: HTMLAudioElement | undefined;

/** Play base64 audio and resolve when it ends (or immediately if the browser blocks autoplay). */
export function play(b64: string, mime: string): Promise<void> {
  current?.pause();
  const a = new Audio(`data:${mime};base64,${b64}`);
  current = a;
  return new Promise((resolve) => {
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

const YES = /(^|\s)(हाँ|हां|हा|जी|ठीक|सही|ओके|yes|haan|han|ji|theek|sahi|ok|okay)(\s|$|[.!,।])/i;
const NO = /(^|\s)(नहीं|नही|ना|गलत|रुको|नो|no|nahi|nahin|na|galat)(\s|$|[.!,।])/i;

/** Yes/no from a Hindi or Hinglish transcript. "no" wins when both appear, so a wrong "haan" never saves. */
export function yesNo(heard: string): "yes" | "no" | null {
  const t = heard.trim();
  if (NO.test(t)) return "no";
  return YES.test(t) ? "yes" : null;
}

/**
 * Record one utterance hands-free: wait for speech, stop after ~1.2 s of quiet (or 15 s), give up after 8 s of silence.
 * Returns the 16 kHz WAV (base64) or null when nothing was said.
 */
export async function recordUntilSilence(shouldContinue: () => boolean = () => true): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const rec = new MediaRecorder(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start();
  const started = Date.now();
  let heardAt = 0;
  let lastLoud = 0;
  await new Promise<void>((resolve) => {
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const now = Date.now();
      if (peak > 14) {
        heardAt ||= now;
        lastLoud = now;
      }
      const quietFor = now - lastLoud;
      if (!shouldContinue() || (heardAt && quietFor > 1200) || now - started > 15_000 || (!heardAt && now - started > 8000)) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  void ctx.close();
  if (!heardAt) return null;
  try {
    return await toWav16k(await new Blob(parts, { type: rec.mimeType }).arrayBuffer());
  } catch {
    return null;
  }
}
