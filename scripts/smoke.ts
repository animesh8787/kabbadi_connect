// End-to-end check against the deployed stack: request -> dispatch -> route -> start -> confirm -> ack -> impact.
// Uses the logins from `npm run seed`. Exits non-zero on the first failed expectation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { call, cardSignIn, outputs, passwordSignIn, readCreds, region, signIn } from "./lib";

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
const collector0 = await login(creds.find((c) => c.role === "collector")!);

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


// ---------------- v4: requests reach collectors by radius, scheduling, assistants, directions ----------------
console.log("\n-- v4 --");
// Jaipur: far from every seeded collector and from real requests, so only the collector made here can serve it.
const JAIPUR = { lat: 26.9124, lng: 75.7873 };
const jphone = `7${String(Date.now()).slice(-9)}`;
const jc = await call(base, "POST", "/admin/collectors", admin, { name: "Smoke Collector", phone: jphone, areas: ["zzzzz"], lat: JAIPUR.lat, lng: JAIPUR.lng, password: "Smoke-Passw0rd-1" });
ok(jc.status === 200, "admin created a collector with a password");
const jToken = await cardSignIn(collectorClientId, jc.data.username, jc.data.code);
ok(Boolean(jToken), "collector signs in with the card");
const jPass = await passwordSignIn(collectorClientId, jc.data.username, "Smoke-Passw0rd-1");
ok(Boolean(jPass), "the same collector signs in with phone-number password");
ok((await call(base, "POST", "/admin/collectors", admin, { name: "Weak", phone: "7000000000", areas: ["zzzzz"], lat: 1, lng: 1, password: "weak" })).status === 400, "weak password is rejected");
ok((await call(base, "POST", "/collector/password", jToken, { password: "Another-Passw0rd-2" })).status === 200, "collector can change their own password");
ok((await call(base, "PUT", "/collector/settings", jToken, { travelMode: "scooter", serviceRadiusKm: 10 })).status === 200, "collector settings saved");

const tom = new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10);
const in3 = new Date(Date.now() + 5.5 * 3600000 + 3 * 86400000).toISOString().slice(0, 10);
for (const r of (await call(base, "GET", "/requests", household)).data.requests ?? []) {
  if (r.status === "OPEN" || r.status === "ASSIGNED") await call(base, "POST", `/requests/${r.id}/cancel`, household);
}

// heavy pickup tomorrow: dispatched by radius although the collector lists no matching map cell
const a = await call(base, "POST", "/requests", household, { items: [{ cat: "paper", bucket: "10+" }], ...JAIPUR, address: "Smoke Jaipur 1", date: tom, slot: "s1416", notes: "ring twice" });
ok(a.status === 200 && a.data.collectorsNearby === 1 && a.data.notes === "ring twice", `two-hour slot + note accepted; ${a.data.collectorsNearby} collector can reach this address`);
execFileSync("aws", ["lambda", "invoke", "--function-name", fn, "--region", region, "--cli-binary-format", "raw-in-base64-out", "--payload", "{}", "NUL"], { stdio: "ignore" });
const aNow = (await call(base, "GET", `/requests/${a.data.id}`, household)).data;
ok(aNow.status === "ASSIGNED", "the request reached the collector by radius (no matching map cell needed)");

// light pickup 3 days out: not dispatched yet, but visible on the collector's nearby board and claimable
const b = await call(base, "POST", "/requests", household, { items: [{ cat: "glass", bucket: "<2" }], lat: JAIPUR.lat + 0.01, lng: JAIPUR.lng, address: "Smoke Jaipur 2", date: in3, slot: "s1012" });
ok(b.status === 200, "second request created for 3 days ahead");
const board = (await call(base, "GET", `/collector/nearby?lat=${JAIPUR.lat}&lng=${JAIPUR.lng}`, jToken)).data.requests;
ok(board.some((r: any) => r.id === b.data.id) && !JSON.stringify(board).includes("Smoke Jaipur"), "it shows on the nearby board without the address");
const farBoard = (await call(base, "GET", "/collector/nearby?lat=19.07&lng=72.87", jToken)).data.requests;
ok(farBoard.length === 0, "nothing nearby when the collector is far away");
const c1 = await call(base, "POST", `/collector/nearby/${b.data.id}/claim`, jToken);
ok(c1.status === 200, "collector claimed it");
ok((await call(base, "POST", `/collector/nearby/${b.data.id}/claim`, jToken)).status === 409, "second claim is a clean 409");

// reschedule: assigned -> open in the new slot
const rs = await call(base, "POST", `/requests/${b.data.id}/reschedule`, household, { date: in3, slot: "s1618" });
ok(rs.status === 200 && (await call(base, "GET", `/requests/${b.data.id}`, household)).data.status === "OPEN", "reschedule re-opens an assigned pickup");
ok((await call(base, "POST", `/requests/${b.data.id}/reschedule`, household, { date: "2020-01-01", slot: "s1012" })).status === 400, "reschedule into the past is rejected");
ok((await call(base, "POST", `/requests/${a.data.id}/reschedule`, collector0, { date: tom, slot: "s1012" })).status === 403, "a collector cannot reschedule household pickups");

// profile
ok((await call(base, "PUT", "/me/profile", household, { address: "Smoke Jaipur 1", ...JAIPUR, phone: "9800000009" })).status === 200, "profile saved");
ok((await call(base, "GET", "/me/profile", household)).data.profile.address === "Smoke Jaipur 1", "profile read back");

// household assistant (model if reachable, else keyword rules): proposes, never books
const hs = (await call(base, "POST", "/household/assistant", household, { text: "kal shaam paanch kilo raddi aur do kilo plastic" })).data;
ok(hs.action?.type === "book" && hs.needsConfirm === true && hs.action.booking.date === tom, `assistant proposed a booking (via ${hs.via}): ${JSON.stringify(hs.action?.booking)}`);
const openCount = (await call(base, "GET", "/requests", household)).data.requests.filter((r: any) => r.status === "OPEN" || r.status === "ASSIGNED").length;
ok(openCount === 2 && (await call(base, "POST", "/household/assistant", household, { text: "meri rates kya hain" })).status === 200, "asking a question books nothing");
ok((await call(base, "POST", "/household/assistant", jToken, { text: "hi" })).status === 403, "collectors cannot use the household assistant");

// collector assistant with history and location
const as1 = (await call(base, "POST", "/assistant", jToken, { text: "is mahine kitna kamaya", history: [{ role: "user", text: "namaste" }], location: JAIPUR })).data;
ok(typeof as1.say === "string" && as1.say.length > 0, `collector assistant answered (via ${as1.via}): ${as1.say}`);

// directions: start the batch, route to the stop, share position, household sees the ETA
const jb = (await call(base, "GET", "/collector/batches/today", jToken)).data.batches.find((x: any) => x.stops.some((s: any) => s.id === a.data.id));
ok(Boolean(jb) && (await call(base, "POST", `/batches/${jb.id}/accept`, jToken)).status === 200, "collector started the batch");
const rt = await call(base, "GET", `/collector/route?stopId=${a.data.id}&lat=${JAIPUR.lat - 0.004}&lng=${JAIPUR.lng - 0.003}`, jToken);
ok(rt.status === 200 && rt.data.line.length > 2 && rt.data.maneuvers.some((m: any) => m.kind === "arrive"), `route has ${rt.data.line?.length} points and ${rt.data.maneuvers?.length} maneuvers (${rt.data.maneuvers?.map((m: any) => m.kind + ":" + m.turn).join(", ")})`);
ok((await call(base, "GET", `/collector/route?stopId=${a.data.id}&lat=26.9&lng=75.7`, collector0)).status === 404, "cannot route to another collector's stop");
ok((await call(base, "POST", "/collector/position", jToken, { lat: JAIPUR.lat - 0.004, lng: JAIPUR.lng - 0.003, stopId: a.data.id })).status === 200, "position shared");
const eta = (await call(base, "GET", `/requests/${a.data.id}/eta`, household)).data.eta;
ok(eta && eta.distanceKm > 0 && eta.minutes > 0, `household sees the ETA: ${eta?.distanceKm} km, ${eta?.minutes} min`);

// admin: unassigned list and manual assign on a fresh open request
const d = await call(base, "POST", "/requests", household, { items: [{ cat: "metal", bucket: "<2" }], lat: JAIPUR.lat + 0.005, lng: JAIPUR.lng, address: "Smoke Jaipur 3", date: in3, slot: "s1214" });
ok((await call(base, "GET", "/admin/unassigned", admin)).status === 200, "admin unassigned list works");
ok((await call(base, "POST", `/admin/unassigned/${d.data.id}/assign`, admin, { collectorId: jc.data.id })).status === 200, "admin assigned an open request by hand");
ok((await call(base, "GET", "/admin/unassigned", jToken)).status === 403, "collectors cannot use the admin list");

// join requests: public, validated, admin reviews
ok((await fetch(`${base}/public/join`, { method: "POST", body: JSON.stringify({ name: "Smoke Join", phone: "9811111111", area: "Smoke Area" }) })).status === 200, "anyone can send a join request");
ok((await fetch(`${base}/public/join`, { method: "POST", body: JSON.stringify({ name: "x", phone: "1", area: "y" }) })).status === 400, "bad join request is rejected");
const joins = (await call(base, "GET", "/admin/joins", admin)).data.joins;
const mineJoin = joins.find((j: any) => j.name === "Smoke Join");
ok(Boolean(mineJoin) && (await call(base, "DELETE", `/admin/joins/${mineJoin.id}`, admin)).status === 200, "admin sees and removes the join request");

// the demo collector must never take real requests, and the real impact total is unchanged by all of this
for (const id of [a.data.id, b.data.id, d.data.id]) await call(base, "POST", `/requests/${id}/cancel`, household);
const jlist = (await call(base, "GET", "/admin/collectors", admin)).data.collectors.find((c: any) => c.id === jc.data.id);
ok((await retire(jlist)).status === 200, "Jaipur smoke collector retired");

console.log("\nSMOKE PASSED");
