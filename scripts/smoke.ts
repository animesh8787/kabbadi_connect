// End-to-end check against the deployed stack: request -> dispatch -> route -> start -> confirm -> ack -> impact.
// Uses the logins from `npm run seed`. Exits non-zero on the first failed expectation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { call, cardSignIn, outputs, readCreds, region, signIn } from "./lib";

const out = outputs();
const base = out.ApiUrl!;
const clientId = out.UserPoolClientId!;
const creds = readCreds();
if (!creds.length) throw new Error("run `npm run seed` first");

const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
};
const login = async (c: (typeof creds)[number]) => signIn(clientId, c.email, c.password);
const find = (email: string) => creds.find((c) => c.email === email)!;

const admin = await login(find("admin@kabadi.example.com"));
const household = await login(find("smoke@kabadi.example.com"));

// Free the household's open-pickup quota from earlier (possibly failed) runs.
for (const r of (await call(base, "GET", "/requests", household)).data.requests ?? []) {
  if (r.status === "OPEN" || r.status === "ASSIGNED") await call(base, "POST", `/requests/${r.id}/cancel`, household);
}

// Collectors this script creates are retired afterwards so they never win dispatch in later runs (also cleans up after a failed run).
const retire = async (c: { id: string; name: string; phone: string; areas: string[]; lat: number; lng: number }) =>
  call(base, "PUT", `/admin/collectors/${c.id}`, admin, { name: c.name, phone: c.phone, areas: c.areas, lat: c.lat, lng: c.lng, active: false });
for (const c of (await call(base, "GET", "/admin/collectors", admin)).data.collectors ?? []) {
  if (c.name === "Smoke Collector" && c.active) await retire(c);
}

// auth boundaries
ok((await call(base, "GET", "/impact", "")).status === 401, "no token -> 401");
ok((await call(base, "GET", "/collector/batches/today", household)).status === 403, "household cannot read collector routes");
ok((await call(base, "PUT", "/admin/collectors/x", household, {})).status === 403, "household cannot manage collectors");

const before = (await call(base, "GET", "/impact?days=30", admin)).data;

// two heavy pickups for tomorrow morning in the seeded ward -> exceeds the 15 kg dispatch threshold
const tomorrow = new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const ids: string[] = [];
for (const [i, cat] of (["paper", "metal"] as const).entries()) {
  const r = await call(base, "POST", "/requests", household, {
    items: [{ cat, bucket: "10+" }],
    lat: 28.705 + i * 0.002,
    lng: 77.102,
    address: `Smoke test ${i + 1}, Rohini`,
    date: tomorrow,
    slot: "morning",
  });
  ok(r.status === 200 && r.data.status === "OPEN", `request ${i + 1} created`);
  ids.push(r.data.id);
}

// don't wait for the 5-minute sweep
const fn = execFileSync(
  "aws",
  ["cloudformation", "describe-stack-resource", "--stack-name", "kabadi-connect", "--logical-resource-id", "DispatchFn", "--region", region, "--query", "StackResourceDetail.PhysicalResourceId", "--output", "text"],
  { encoding: "utf8" },
).trim();
execFileSync("aws", ["lambda", "invoke", "--function-name", fn, "--region", region, "--cli-binary-format", "raw-in-base64-out", "--payload", "{}", "NUL"], { stdio: "ignore" });

const r0 = (await call(base, "GET", `/requests/${ids[0]}`, household)).data;
ok(r0.status === "ASSIGNED" && r0.collectorId, `request assigned to a collector (${r0.status})`);
const col = creds.find((c) => c.sub === r0.collectorId)!;
const collector = await login(col);

const today = (await call(base, "GET", "/collector/batches/today", collector)).data.batches;
const batch = today.find((b: any) => b.stops.some((s: any) => s.id === ids[0]));
ok(batch, "collector sees the batch");
console.log(`     route source: ${batch.routeSource}, ${batch.km} km vs ${batch.naiveKm} km in request order, ${batch.stops.length} stops`);

const otherCollector = await login(creds.find((c) => c.role === "collector" && c.sub !== col.sub)!);
ok((await call(base, "POST", `/batches/${batch.id}/accept`, otherCollector)).status === 404, "another collector cannot start this batch");
ok((await call(base, "POST", `/batches/${batch.id}/accept`, collector)).status === 200, "batch started");
ok((await call(base, "POST", `/batches/${batch.id}/accept`, collector)).data.status === "ACTIVE", "start is idempotent");

const first = (await call(base, "POST", `/requests/${ids[0]}/confirm`, collector, { items: [{ cat: "paper", actualKg: 12.5 }] })).data;
ok(first.status === "PICKED" && first.payout > 0, `pickup confirmed, payout Rs ${first.payout}, ${first.co2Kg} kg CO2e`);
const again = await call(base, "POST", `/requests/${ids[0]}/confirm`, collector, { items: [{ cat: "paper", actualKg: 99 }] });
ok(again.status === 200 && again.data.payout === first.payout, "confirm is idempotent (no double count)");
ok((await call(base, "POST", `/requests/${ids[1]}/missed`, collector)).data.status === "MISSED", "second stop marked not home");

ok((await call(base, "POST", `/requests/${ids[0]}/ack`, household)).data.householdAck === true, "household acknowledged weights");
ok((await call(base, "POST", `/requests/${ids[0]}/cancel`, household)).status === 409, "picked request cannot be cancelled");

const after = (await call(base, "GET", "/impact?days=30", admin)).data;
ok(after.pickups === before.pickups + 1, "impact pickups +1");
ok(Math.abs(after.kg - before.kg - 12.5) < 0.01, "impact kg +12.5");
// ---------------- v2: card login, voice assistant, segregation, ledger, photo ----------------
console.log("\n-- v2 --");
const collectorClientId = out.CollectorClientId!;
ok(Boolean(collectorClientId), "collector app client exists");
const list = (await call(base, "GET", "/admin/collectors", admin)).data.collectors;
ok(list.length >= 3, `admin lists collectors (${list.length})`);
ok((await call(base, "GET", "/admin/collectors", household)).status === 403, "household cannot list collectors");

const phone = `9${String(Date.now()).slice(-9)}`;
const created = await call(base, "POST", "/admin/collectors", admin, {
  name: "Smoke Collector",
  phone,
  areas: ["ttng6", "ttng4"],
  lat: 28.7061,
  lng: 77.103,
});
ok(created.status === 200 && created.data.code, "admin created a collector and got a card code");
const { id: newId, username, code } = created.data;
ok((await call(base, "POST", "/admin/collectors", admin, { name: "Dup", phone, areas: ["ttng6"], lat: 28.7, lng: 77.1 })).status === 409, "duplicate phone rejected");

let bad = false;
try {
  await cardSignIn(collectorClientId, username, "wrong-code");
} catch {
  bad = true;
}
ok(bad, "wrong card code is rejected");
const card = await cardSignIn(collectorClientId, username, code);
ok(Boolean(card), "collector signed in with the QR card code");
let reused = false;
try {
  await cardSignIn(collectorClientId, username, code);
} catch {
  reused = true;
}
ok(reused, "card code works only once");
ok((await call(base, "GET", "/collector/batches/today", card)).status === 200, "card login gives collector access");
ok((await call(base, "GET", "/admin/collectors", card)).status === 403, "collector cannot use admin routes");

const before2 = (await call(base, "GET", "/impact?days=30", admin)).data;

const r2 = await call(base, "POST", "/requests", household, {
  items: [{ cat: "paper", bucket: "10+" }, { cat: "ewaste", bucket: "<2" }],
  lat: 28.7061,
  lng: 77.103,
  address: "Smoke v2, Rohini",
  date: tomorrow,
  slot: "evening",
  phone: "9800000009",
});
ok(r2.status === 200, "v2 request created");
execFileSync("aws", ["lambda", "invoke", "--function-name", fn, "--region", region, "--cli-binary-format", "raw-in-base64-out", "--payload", "{}", "NUL"], { stdio: "ignore" });
const r2s = (await call(base, "GET", `/requests/${r2.data.id}`, household)).data;
ok(r2s.collectorId === newId, "dispatch assigned the nearest (new) collector");

// voice assistant against real Bedrock + Polly (Bhashini keys optional)
const turn = (await call(base, "POST", "/assistant", card, { text: "agla ghar kahan hai", focusStopId: r2.data.id })).data;
ok(turn.say?.includes("Smoke v2") && turn.action?.type === "focus", `assistant understood "agla ghar": ${turn.say}`);
ok(Boolean(turn.audio), `assistant spoke the reply (${turn.audioMime}), intent via ${turn.via}`);
const unsafe = (await call(base, "POST", "/assistant", card, { text: "paanch kilo kagaz hua", focusStopId: r2.data.id })).data;
ok(unsafe.action?.type !== "confirm" || unsafe.needsConfirm === true, "confirm via voice always asks for a yes");
const sp = await call(base, "POST", "/speak", card, { text: "नमस्ते" });
ok(sp.status === 200 && sp.data.audio, "speak returns audio");
ok((await call(base, "POST", "/speak", household, { text: "x" })).status === 403, "household cannot use speak");

ok((await call(base, "POST", `/batches/${(await call(base, "GET", "/collector/batches/today", card)).data.batches[0].id}/accept`, card)).status === 200, "new collector started the batch");
const conf = (await call(base, "POST", `/requests/${r2.data.id}/confirm`, card, { items: [{ cat: "paper", actualKg: 6 }, { cat: "ewaste", actualKg: 1 }], segregation: "good" })).data;
ok(conf.status === "PICKED", `pickup confirmed with segregation, payout Rs ${conf.payout}`);
ok((await call(base, "POST", `/requests/${r2.data.id}/ack`, household)).data.householdAck === true, "household acknowledged");
ok((await call(base, "POST", `/requests/${r2.data.id}/ack`, household)).data.householdAck === true, "second acknowledgement is harmless");

const month = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
const ledger = (await call(base, "GET", `/collector/ledger?month=${month}`, card)).data;
ok(ledger.pickups === 1 && ledger.verifiedPickups === 1 && ledger.kg === 7 && ledger.segregationGoodPct === 100, "ledger totals: 1 pickup, 7 kg, verified, 100% well sorted");
ok(!JSON.stringify(ledger).includes("Smoke v2"), "ledger contains no household address");
const aled = (await call(base, "GET", `/admin/collectors/${newId}/ledger?month=${month}`, admin)).data;
ok(aled.kg === 7, "admin can read a collector's ledger");
ok((await call(base, "GET", `/admin/collectors/${newId}/ledger?month=${month}`, card)).status === 403, "collector cannot read via admin route");

const after2 = (await call(base, "GET", "/impact?days=30", admin)).data;
ok(after2.segTotal === before2.segTotal + 1 && after2.segGood === before2.segGood + 1, "impact segregation counters +1");
ok(Math.abs(after2.ackKg - before2.ackKg - 7) < 0.01, "impact household-confirmed kg +7 (counted once)");

// photo estimate against real Bedrock vision: a valid answer or a clean 422, never a 500
const photo = await call(base, "POST", "/photo-estimate", household, { image: readFileSync("scripts/fixtures/pile.jpg").toString("base64") });
ok([200, 422].includes(photo.status), `photo estimate worked (model or label fallback) (${photo.status}${photo.status === 200 ? ": " + JSON.stringify(photo.data.items) : ""})`);
ok((await call(base, "POST", "/photo-estimate", card, { image: "x" })).status === 403, "collector cannot use photo estimate");

// revoke
ok((await call(base, "POST", `/admin/collectors/${newId}/revoke`, admin)).data.revoked === true, "admin revoked the collector");
let blocked = false;
const reissued = await call(base, "POST", `/admin/collectors/${newId}/enroll`, admin);
ok(reissued.status === 200 && reissued.data.code, "admin issued a replacement card");
try {
  await cardSignIn(collectorClientId, username, code);
} catch {
  blocked = true;
}
ok(blocked, "old card code stays dead after re-issue");
ok(Boolean(await cardSignIn(collectorClientId, username, reissued.data.code)), "replacement card signs in");

// ---------------- public landing counters ----------------
const pub = await fetch(`${base}/public/impact`);
const pubData: any = await pub.json();
ok(pub.status === 200 && typeof pubData.kg === "number" && !("payout" in pubData) && !("daily" in pubData), "public impact endpoint answers without login and exposes totals only");

// ---------------- public judge demo (no login) ----------------
console.log("\n-- judge demo --");
const impactBefore = (await call(base, "GET", "/impact?days=30", admin)).data;
const demo = await call(base, "POST", "/demo/start", "");
ok(demo.status === 200 && demo.data.code, "anyone can start a demo without logging in");
const demoToken = await cardSignIn(collectorClientId, demo.data.username, demo.data.code);
const demoBatch = (await call(base, "GET", "/collector/batches/today", demoToken)).data.batches[0];
ok(demoBatch?.stops.length === 3, "demo collector has a batch with 3 pickups");
ok(demoBatch.km > 0 && demoBatch.naiveKm >= demoBatch.km && demoBatch.naiveOrder?.length === 3, `demo batch has a before/after route: ${demoBatch.km} km vs ${demoBatch.naiveKm} km`);
ok(demoBatch.stops.some((s: any) => s.items.some((i: any) => i.cat === "ewaste")), "one demo pickup is e-waste (shows the recycler card)");
ok((await call(base, "POST", `/batches/${demoBatch.id}/accept`, demoToken)).status === 200, "demo batch started");
const dStop = demoBatch.stops[0];
ok((await call(base, "POST", `/requests/${dStop.id}/confirm`, demoToken, { items: [{ cat: dStop.items[0].cat, actualKg: 4 }], segregation: "good" })).data.status === "PICKED", "demo pickup confirmed");
const dTurn = (await call(base, "POST", "/assistant", demoToken, { text: "agla ghar kahan hai" })).data;
ok(dTurn.action?.type === "focus", `demo voice works: ${dTurn.say}`);
ok((await call(base, "GET", "/admin/collectors", demoToken)).status === 403, "demo collector has no admin access");
ok((await call(base, "GET", "/impact?days=30", admin)).data.kg === impactBefore.kg, "demo pickups do not change real impact totals");

const mine = (await call(base, "GET", "/admin/collectors", admin)).data.collectors.find((c: any) => c.id === newId);
ok((await retire(mine)).status === 200, "smoke collector retired");


console.log("\nSMOKE PASSED");
