import { api } from "./api";
import { play } from "./voice";

const phrases = new Map<string, { audio: string; mime: string }>();

/** Speak a short phrase; the audio is cached on the phone so repeated phrases (navigation, prompts) cost nothing. */
export async function say(text: string) {
  let hit = phrases.get(text);
  if (!hit) {
    const r = await api.speak(text);
    hit = { audio: r.audio, mime: r.audioMime };
    phrases.set(text, hit);
  }
  await play(hit.audio, hit.mime);
}

/** What the navigation screen is currently saying, so "ab kidhar mudna hai" can repeat it. */
export const navState = { text: "" };
