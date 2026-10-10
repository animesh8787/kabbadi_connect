// Print a one-time QR-card login link for a seeded collector (demo/testing). Usage: npm run card -- collector1@kabadi.example.com
// Issuing a card replaces any earlier card for that collector.
import { call, outputs, readCreds, signIn } from "./lib";

const email = process.argv[2] ?? "collector1@kabadi.example.com";
const out = outputs();
const creds = readCreds();
const admin = creds.find((c) => c.role === "admin");
const col = creds.find((c) => c.email === email && c.role === "collector");
if (!admin || !col) throw new Error("run `npm run seed` first, and pass a seeded collector email");

const token = await signIn(out.UserPoolClientId!, admin.email, admin.password);
const r = await call(out.ApiUrl!, "POST", `/admin/collectors/${col.sub}/enroll`, token);
if (r.status !== 200) throw new Error(`enroll failed: ${r.status} ${JSON.stringify(r.data)}`);
const site = out.SiteUrl!;
console.log(`${site}/?enroll=${encodeURIComponent(r.data.code)}&u=${encodeURIComponent(r.data.username)}`);
