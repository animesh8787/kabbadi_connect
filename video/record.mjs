// Record the demo scenes against the LIVE site with real data. Sessions are made with the AWS SDK (like the smoke test),
// then handed to the page, so no password is ever typed into the site. The microphone is a fake device fed a Hindi WAV,
// so the voice scene runs the real pipeline: Transcribe -> brain -> Polly.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const FF = "C:/Users/anime/AppData/Local/Programs/Python/Python311/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe";
const region = "ap-south-1";
const aws = (...a) => execFileSync("aws", [...a, "--region", region], { encoding: "utf8" });
const out = Object.fromEntries(JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", "kabadi-connect", "--query", "Stacks[0].Outputs", "--output", "json")).map((o) => [o.OutputKey, o.OutputValue]));
const SITE = out.SiteUrl;
const API = out.ApiUrl;
const creds = JSON.parse(readFileSync(".seed-credentials.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync("video/clips", { recursive: true });
mkdirSync("video/audio", { recursive: true });

// ---- the voice the fake microphone "speaks": a Hindi question made with Polly
aws("polly", "synthesize-speech", "--engine", "neural", "--voice-id", "Kajal", "--language-code", "hi-IN", "--output-format", "mp3", "--text", "अगला घर कहाँ है", "video/audio/mic.mp3");
execFileSync(FF, ["-y", "-i", "video/audio/mic.mp3", "-af", "adelay=300|300,apad=pad_dur=1.5", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "video/audio/mic.wav"], { stdio: "ignore" });

async function login(email, password) {
  const r = await new CognitoIdentityProviderClient({ region }).send(
    new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: out.UserPoolClientId, AuthParameters: { USERNAME: email, PASSWORD: password } }),
  );
  const t = r.AuthenticationResult;
  const p = JSON.parse(Buffer.from(t.IdToken.split(".")[1], "base64url").toString());
  return JSON.stringify({ idToken: t.IdToken, refreshToken: t.RefreshToken, exp: p.exp * 1000, email: p.email, groups: p["cognito:groups"] ?? [], clientId: out.UserPoolClientId });
}
const cred = (email) => creds.find((c) => c.email === email);
const household = await login("household1@kabadi.example.com", cred("household1@kabadi.example.com").password);
const admin = await login("admin@kabadi.example.com", cred("admin@kabadi.example.com").password);

const browser = await chromium.launch({
  channel: "msedge",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${process.cwd()}/video/audio/mic.wav`, "--autoplay-policy=no-user-gesture-required"],
});
const only = process.argv[2];
let manifest = [];
try {
  manifest = JSON.parse(readFileSync("video/clips/manifest.json", "utf8"));
} catch {}

/** One scene = one context with its own video. `t0` is when the first real frame is ready (to trim the blank start). */
async function scene(name, { w, h, session, lang, geo, perms = [] }, fn) {
  if (only && only !== name) return;
  const dir = `video/clips/${name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    recordVideo: { dir, size: { width: w, height: h } },
    serviceWorkers: "block",
    locale: "en-IN",
    geolocation: geo,
    permissions: ["microphone", ...(geo ? ["geolocation"] : []), ...perms],
  });
  if (session || lang) await ctx.addInitScript(([s, l]) => { if (s) localStorage.setItem("kc.session", s); if (l) localStorage.setItem("kc.lang", l); }, [session ?? "", lang ?? ""]);
  const page = await ctx.newPage();
  const created = Date.now();
  const audios = [];
  page.on("response", async (res) => {
    if (res.url().endsWith("/assistant") && res.request().method() === "POST") {
      try {
        const j = await res.json();
        if (j.audio) {
          const f = `video/audio/${name}_reply_${audios.length}.mp3`;
          writeFileSync(f, Buffer.from(j.audio, "base64"));
          audios.push({ file: f, at: (Date.now() - created) / 1000, said: j.say, heard: j.heard, via: j.via });
        }
      } catch {}
    }
  });
  let t0 = 0;
  const mark = () => (t0 = (Date.now() - created) / 1000);
  await fn(page, ctx, mark);
  const length = (Date.now() - created) / 1000;
  await ctx.close();
  const file = (await page.video().path()).replace(/\\/g, "/");
  renameSync(file, `video/clips/${name}.webm`);
  manifest = manifest.filter((m) => m.name !== name);
  manifest.push({ name, file: `video/clips/${name}.webm`, start: t0, length: length - t0, audios: audios.map((a) => ({ ...a, at: a.at - t0 })) });
  console.log("recorded", name, (length - t0).toFixed(1) + "s", audios.map((a) => `${a.via}: ${a.heard} -> ${a.said}`).join(" | "));
}
const scrollBy = async (page, total, ms) => {
  const steps = 20;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await sleep(ms / steps);
  }
};

// ---------- landing (desktop)
await scene("landing", { w: 1280, h: 720 }, async (page, _c, mark) => {
  await page.goto(SITE, { waitUntil: "networkidle" });
  await sleep(1200);
  mark();
  await sleep(2500);
  await scrollBy(page, 700, 3500);
  await sleep(500);
  await scrollBy(page, 900, 3500);
});

// ---------- household: schedule + assistant
await scene("household", { w: 540, h: 1000, session: household, lang: "en" }, async (page, _c, mark) => {
  await page.goto(`${SITE}/app`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Book", exact: true }).click();
  await sleep(800);
  mark();
  await sleep(1200);
  await scrollBy(page, 520, 2600);
  await sleep(900);
  await page.mouse.wheel(0, -2000);
  await page.getByRole("button", { name: "Speak", exact: true }).click();
  await sleep(700);
  await page.getByRole("textbox", { name: /tomorrow evening/ }).pressSequentially("kal shaam paanch kilo raddi", { delay: 90 });
  await sleep(300);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(2500);
});

// ---------- admin: print a QR card
await scene("admin_card", { w: 540, h: 1000, session: admin, lang: "en" }, async (page, _c, mark) => {
  await page.goto(`${SITE}/app`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Collectors" }).click();
  await sleep(1200);
  mark();
  await sleep(1000);
  await page.getByRole("button", { name: /New card/ }).first().click();
  await page.getByAltText("QR").waitFor({ timeout: 15000 });
  await sleep(3500);
});

// ---------- a throwaway demo collector for the next scenes
const demo = await (await fetch(`${API}/demo/start`, { method: "POST" })).json();
const cardUrl = `${SITE}/?enroll=${encodeURIComponent(demo.code)}&u=${encodeURIComponent(demo.username)}`;

// ---------- collector: scan card -> Hindi app; browse; then voice
await scene("voice", { w: 540, h: 1000 }, async (page, _c, mark) => {
  await page.goto(cardUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "आज की पिकअप" }).waitFor({ timeout: 20000 });
  await sleep(1500);
  mark();
  await sleep(1500);
  await scrollBy(page, 700, 4500); // route toggle, stops, e-waste card
  await sleep(800);
  await scrollBy(page, 600, 3000);
  await sleep(600);
  await page.mouse.wheel(0, -3000);
  await sleep(900);
  // hold the mic: the fake device says "agla ghar kahan hai"
  const mic = page.getByRole("button", { name: "दबाकर बोलिए" });
  const box = await mic.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(2600);
  await page.mouse.up();
  await page.getByText("🔊", { exact: false }).nth(1).waitFor({ timeout: 25000 }).catch(() => {});
  await sleep(6000);
});

// ---------- collector: spoken directions along the REAL route
const demoSession = await (async () => {
  // a fresh card for a second context (the first card is single-use)
  const d2 = await (await fetch(`${API}/demo/start`, { method: "POST" })).json();
  return `${SITE}/?enroll=${encodeURIComponent(d2.code)}&u=${encodeURIComponent(d2.username)}`;
})();
const START = { latitude: 28.7002, longitude: 77.1004 };
await scene("nav", { w: 540, h: 1000, geo: START }, async (page, ctx, mark) => {
  await page.goto(demoSession, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "आज की पिकअप" }).waitFor({ timeout: 20000 });
  await sleep(800);
  mark();
  const intercepted = [];
  page.on("response", async (r) => {
    if (r.url().includes("/collector/route")) intercepted.push(await r.json().catch(() => null));
  });
  await page.getByRole("button", { name: /रास्ता दिखाइए/ }).first().click();
  await page.getByTestId("nav-banner").waitFor();
  while (!intercepted[0]) await sleep(300);
  const line = intercepted[0].line;
  await sleep(1500);
  // walk the route: ~35 m per second so the whole walk fits the scene
  const pts = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [x1, y1] = line[i];
    const [x2, y2] = line[i + 1];
    const n = Math.max(1, Math.round((Math.hypot((x2 - x1) * 97000, (y2 - y1) * 111000)) / 35));
    for (let k = 1; k <= n; k++) pts.push({ longitude: x1 + ((x2 - x1) * k) / n, latitude: y1 + ((y2 - y1) * k) / n });
  }
  for (const p of pts.slice(0, 18)) {
    await ctx.setGeolocation(p);
    await sleep(850);
  }
  await sleep(1500);
});

// ---------- methodology (desktop)
await scene("methodology", { w: 1280, h: 720 }, async (page, _c, mark) => {
  await page.goto(`${SITE}/methodology`, { waitUntil: "networkidle" });
  await sleep(800);
  mark();
  await sleep(1500);
  await scrollBy(page, 900, 3500);
  await scrollBy(page, 900, 3500);
});

await browser.close();
writeFileSync("video/clips/manifest.json", JSON.stringify(manifest, null, 2));
console.log("done");
