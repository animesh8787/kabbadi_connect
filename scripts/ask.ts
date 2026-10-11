// Ask the live collector assistant questions as a throwaway demo collector. Usage: npm run ask -- "is mahine kitna kamaya" "e-waste kahan dun"
import { call, cardSignIn, outputs, readCreds, signIn } from "./lib";

const out = outputs();
const base = out.ApiUrl!;
// AS=household asks the household booking assistant (as a seeded test household) instead.
const household = process.env.AS === "household";
const h = readCreds().find((c) => c.email === "household1@kabadi.example.com");
const demo = household ? null : await (await fetch(`${base}/demo/start`, { method: "POST" })).json();
const token = household ? await signIn(out.UserPoolClientId!, h!.email, h!.password) : await cardSignIn(out.CollectorClientId!, demo.username, demo.code);
const questions = process.argv.slice(2);
const history: { role: "user" | "assistant"; text: string }[] = [];
for (const q of questions.length ? questions : ["aaj ka hisaab batao"]) {
  const t0 = Date.now();
  const r = (await call(base, "POST", household ? "/household/assistant" : "/assistant", token, { text: q, history })).data as any;
  console.log(`> ${q}\n  [${r.via}, ${Date.now() - t0} ms] ${r.say}${r.action ? `  (action: ${r.action.type}${r.needsConfirm ? ", needs yes" : ""} ${JSON.stringify(r.action.booking ?? "")})` : ""}`);
  history.push({ role: "user", text: q }, { role: "assistant", text: r.say ?? "" });
}
