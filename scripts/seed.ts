// Seed a demo ward (Rohini, Delhi): 1 admin, 3 collectors, 10 households with pickups, 1 smoke-test household.
// Writes generated logins to .seed-credentials.json (gitignored). Safe to re-run: users are reused, passwords reset.
import { randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { geohash } from "@kc/shared";
import { call, outputs, region, signIn, writeCreds, type Cred } from "./lib";

const out = outputs();
const cog = new CognitoIdentityProviderClient({ region });
const pool = out.UserPoolId!;
const base = out.ApiUrl!;
const pw = () => `Kc-${randomBytes(9).toString("base64url")}9a`;

async function user(email: string, role: Cred["role"]): Promise<Cred> {
  const password = pw();
  try {
    await cog.send(
      new AdminCreateUserCommand({
        UserPoolId: pool,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }),
    );
  } catch (e) {
    if ((e as Error).name !== "UsernameExistsException") throw e;
  }
  await cog.send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username: email, Password: password, Permanent: true }));
  await cog.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: email, GroupName: role }));
  const u = await cog.send(new AdminGetUserCommand({ UserPoolId: pool, Username: email }));
  const sub = u.UserAttributes!.find((a) => a.Name === "sub")!.Value!;
  return { email, password, sub, role };
}

// Deterministic pseudo-random so re-runs produce the same ward.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const CENTER = { lat: 28.7041, lng: 77.1025 };
const point = () => ({ lat: CENTER.lat + (rnd() - 0.5) * 0.03, lng: CENTER.lng + (rnd() - 0.5) * 0.03 });

const creds: Cred[] = [];
const admin = await user("admin@kabadi.example.com", "admin");
creds.push(admin);

const households: Cred[] = [];
for (let i = 1; i <= 10; i++) households.push(await user(`household${i}@kabadi.example.com`, "household"));
creds.push(...households, await user("smoke@kabadi.example.com", "household"));

const pts = Array.from({ length: 40 }, point);
const cells = [...new Set(pts.map((p) => geohash(p.lat, p.lng, 5)))];
console.log("cells:", cells.join(","));

const adminToken = await signIn(out.UserPoolClientId!, admin.email, admin.password);
const names = ["Ramesh", "Sunita", "Imran"];
for (let i = 0; i < 3; i++) {
  const c = await user(`collector${i + 1}@kabadi.example.com`, "collector");
  creds.push(c);
  const r = await call(base, "PUT", `/admin/collectors/${c.sub}`, adminToken, {
    name: names[i],
    phone: `98000000${String(i + 1).padStart(2, "0")}`,
    areas: cells,
    lat: CENTER.lat + (i - 1) * 0.008,
    lng: CENTER.lng + (i - 1) * 0.008,
    active: true,
    rates: { paper: 12 + i, plastic: 10, metal: 30 + i * 2, ewaste: 15, glass: 2 },
  });
  if (r.status !== 200) throw new Error(`collector upsert failed: ${r.status} ${JSON.stringify(r.data)}`);
}
writeCreds(creds);

if (process.env.SEED_ONLY === "collectors") {
  console.log(`refreshed ${creds.length} users and collector profiles (no pickups created)`);
  process.exit(0);
}

// Four pickups per household for tomorrow evening.
const tomorrow = new Date(Date.now() + 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
const cats = ["paper", "plastic", "metal", "ewaste", "glass"] as const;
const buckets = ["<2", "2-5", "5-10", "10+"] as const;
let n = 0;
for (const h of households) {
  const token = await signIn(out.UserPoolClientId!, h.email, h.password);
  for (let k = 0; k < 4; k++, n++) {
    const p = pts[n]!;
    const items = [0, 1].map((j) => ({ cat: cats[(n + j * 2) % 5]!, bucket: buckets[(n + j) % 4]! }));
    const r = await call(base, "POST", "/requests", token, {
      items,
      ...p,
      address: `House ${n + 1}, Sector ${(n % 9) + 1}, Rohini, Delhi`,
      date: tomorrow,
      slot: "evening",
    });
    if (r.status !== 200) throw new Error(`request failed: ${r.status} ${JSON.stringify(r.data)}`);
  }
}
console.log(`seeded ${creds.length} users and ${n} pickups for ${tomorrow}; logins in .seed-credentials.json`);
