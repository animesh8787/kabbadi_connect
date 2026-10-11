// Render the video's slides and scene backgrounds to 1920x1080 PNGs (Edge, already installed).
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const css = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,300&family=IBM+Plex+Mono:wght@500&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap');
*{box-sizing:border-box} body{margin:0;width:1920px;height:1080px;background:#0e0b08;color:#f0e7d6;font:400 30px/1.45 'Plus Jakarta Sans',sans-serif;position:relative;overflow:hidden}
body::before{content:"";position:absolute;inset:0;background:radial-gradient(900px 500px at 15% 10%,rgba(62,207,142,.10),transparent),radial-gradient(800px 500px at 90% 90%,rgba(232,121,61,.10),transparent)}
.wrap{position:relative;padding:90px 110px;height:100%;display:flex;flex-direction:column;justify-content:center}
h1{font:300 150px/1.0 'Fraunces',serif;margin:0 0 30px;letter-spacing:-2px} h1 em{color:#3ecf8e;font-style:italic}
h2{font:300 78px/1.1 'Fraunces',serif;margin:0 0 30px} h2 em{color:#3ecf8e;font-style:italic}
.eyebrow{font:500 24px 'IBM Plex Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:#a39a88;margin-bottom:26px}
.pill{display:inline-block;border:1px solid #3a3226;border-radius:999px;padding:10px 24px;margin:8px 10px 8px 0;font:500 26px 'IBM Plex Mono',monospace;color:#d8cfbd;background:#17120d}
.pill b{color:#3ecf8e;font-weight:500}
.box{border:1.5px solid #3a3226;border-radius:12px;background:#17120d;padding:22px 26px;font-size:28px}
.box small{display:block;color:#a39a88;font-size:21px;margin-top:4px}
.g{border-color:#2c8a5f;background:#10201a} .o{border-color:#a8501f;background:#241710}
.arrow{color:#a39a88;font-size:44px;text-align:center}
.cap{position:absolute;left:110px;top:150px;width:900px}
.cap p{color:#cfc5b2;font-size:36px}
ul{list-style:none;padding:0;margin:20px 0} li{padding:12px 0 12px 46px;position:relative;font-size:36px;color:#e6dcc8} li::before{content:"✓";position:absolute;left:0;color:#3ecf8e}
.foot{position:absolute;left:110px;bottom:60px;color:#a39a88;font:500 24px 'IBM Plex Mono',monospace;letter-spacing:.1em}
`;

const slides = {
  title: `<div class="wrap"><div class="eyebrow">WeMakeDevs × AWS · Environmental Hacks · Waste &amp; Energy</div>
    <h1>Kabadi Connect</h1><h2 style="max-width:1500px">Every pickup, <em>reaching</em> the kabadiwala who needs it.</h2>
    <div style="margin-top:50px"><span class="pill"><b>1.5–4 million</b> informal recyclers</span><span class="pill"><b>no</b> digital tools</span><span class="pill"><b>many</b> read little</span></div>
    <div class="foot">d7oz11dsxwlh1.cloudfront.net/judges</div></div>`,

  arch: `<div class="wrap"><div class="eyebrow">Architecture · one SAM template</div><h2>How it fits <em>together</em></h2>
    <div style="display:grid;grid-template-columns:1fr 60px 1fr 60px 1fr 60px 1fr;gap:10px;align-items:center;margin-top:30px">
      <div class="box g">React PWA<small>households · collectors · admin</small></div><div class="arrow">→</div>
      <div class="box">CloudFront + S3<small>hosting, HTTPS</small></div><div class="arrow">→</div>
      <div class="box">API Gateway<small>Cognito authorizer · QR-card custom auth</small></div><div class="arrow">→</div>
      <div class="box g">Lambda<small>Node 22 · arm64</small></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:26px;margin-top:70px">
      <div class="box o">DynamoDB<small>single table · conditional transactions · TTL · PITR</small></div>
      <div class="box o">SQS + EventBridge<small>instant dispatch + 5-minute safety sweep</small></div>
      <div class="box o">Amazon Location<small>OptimizeWaypoints · CalculateRoutes · map tiles</small></div>
    </div>
    <div style="margin-top:60px;font-size:30px;color:#cfc5b2">A request is assigned with a <b style="color:#3ecf8e">conditional write</b>: if two things try at once, one wins and the other gets a clean 409.</div></div>`,

  services: `<div class="wrap"><div class="eyebrow">AWS services, each doing a job</div><h2>Voice, photos and <em>safe fallbacks</em></h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:20px">
      <div class="box g">Amazon Transcribe<small>Hindi speech to text</small></div>
      <div class="box g">Amazon Polly (Kajal)<small>Hindi spoken replies, cached</small></div>
      <div class="box g">Amazon Rekognition<small>photo labels pre-fill a booking</small></div>
      <div class="box g">Amazon Bedrock<small>intent + vision, behind one function</small></div>
      <div class="box">Cognito<small>email, Google, QR-card login</small></div>
      <div class="box">Systems Manager<small>secrets in Parameter Store</small></div>
      <div class="box">CloudWatch<small>logs, alarms, dashboard</small></div>
      <div class="box">CloudFormation + SAM<small>reviewed change sets</small></div>
      <div class="box">IAM<small>least privilege per function</small></div>
    </div>
    <div style="margin-top:44px"><span class="pill">AWS SAM CLI</span><span class="pill">AWS SDK for JavaScript v3</span><span class="pill">AWS CLI v2</span></div>
    <div style="margin-top:20px;font-size:28px;color:#cfc5b2">Model order: Bedrock → free Groq model → keyword rules. The app never stops working.</div></div>`,

  tests: `<div class="wrap"><div class="eyebrow">Quality</div><h2>Tested <em>three ways</em></h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:26px;margin-top:30px">
      <div class="box g" style="padding:40px"><div style="font:300 120px 'Fraunces',serif;color:#3ecf8e;line-height:1">90</div>unit tests<small>batching, routing, handlers with mocked AWS, card login, voice, scheduling, directions</small></div>
      <div class="box g" style="padding:40px"><div style="font:300 120px 'Fraunces',serif;color:#3ecf8e;line-height:1">33</div>browser tests<small>phone-size screens, assistants, navigation, WCAG A/AA accessibility</small></div>
      <div class="box g" style="padding:40px"><div style="font:300 120px 'Fraunces',serif;color:#3ecf8e;line-height:1">100+</div>live checks<small>smoke test on the deployed stack: request → dispatch → pickup → impact</small></div>
    </div></div>`,

  lessons: `<div class="wrap"><div class="eyebrow">Learning &amp; growth</div><h2>What <em>fought back</em></h2>
    <div style="display:grid;gap:22px;margin-top:20px">
      <div class="box o"><b>Matching by map cell</b> left a new town with no collector → <b style="color:#3ecf8e">service radius + a nearby board</b></div>
      <div class="box o"><b>Map key referer</b> blocked MapLibre's blob web worker (403) → <b style="color:#3ecf8e">same-origin worker</b></div>
      <div class="box o"><b>Bedrock "being verified"</b> for a day → <b style="color:#3ecf8e">Rekognition, Groq and keyword fallbacks</b> behind one function</div>
      <div class="box o"><b>"5 kilo raddi" cancelled pickups</b> ("radd" in "raddi") → <b style="color:#3ecf8e">a test caught it</b></div>
    </div></div>`,

  close: `<div class="wrap"><div class="eyebrow">What's next</div><h2>A one-neighbourhood <em>pilot</em></h2>
    <ul><li>5 kabadiwalas · one resident association · 4 weeks</li><li>Android wrapper for background location</li><li>More languages through Bhashini</li><li>A phone line for basic phones</li></ul>
    <h1 style="font-size:110px;margin-top:40px">Kabadi <em>Connect</em></h1>
    <div class="foot">github.com/animesh8787/kabbadi_connect · d7oz11dsxwlh1.cloudfront.net</div></div>`,

  // scene backgrounds: caption on the left, the phone recording goes on the right
  bg_household: `<div class="cap"><div class="eyebrow">Households</div><h2>Book in <em>seconds</em></h2><p>Any of the next 7 days, six two-hour slots, or just say it.</p><ul><li>"kal shaam paanch kilo raddi"</li><li>Assistant proposes, you confirm</li><li>Saved address, notes for the kabadiwala</li></ul></div>`,
  bg_card: `<div class="cap"><div class="eyebrow">Kabadiwalas</div><h2>One scan. <em>No password.</em></h2><p>An admin prints a QR card. It works once; a lost phone can be blocked.</p><ul><li>Cognito custom auth</li><li>Code hash stored, used once</li><li>Hindi-first, big icons</li></ul></div>`,
  bg_voice: `<div class="cap"><div class="eyebrow">Hindi voice assistant</div><h2>Ask <em>anything</em></h2><p>Hold the mic and speak. Transcribe → model → Polly. Nothing saves until "haan".</p><ul><li>Real run, live on AWS</li><li>Hands-free mode, conversation memory</li></ul></div>`,
  bg_nav: `<div class="cap"><div class="eyebrow">Spoken directions</div><h2>Turn by turn, <em>in Hindi</em></h2><p>Amazon Location routes; turns measured from the route line.</p><ul><li>Re-routes if you leave the path</li><li>Household sees live distance</li><li>OptimizeWaypoints orders the stops</li></ul></div>`,
};

mkdirSync("video/slides", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [name, body] of Object.entries(slides)) {
  await page.setContent(`<html><head><style>${css}</style></head><body>${body}</body></html>`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `video/slides/${name}.png` });
  console.log("slide", name);
}
await browser.close();
writeFileSync("video/slides/.done", "ok");
