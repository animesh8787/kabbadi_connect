// Ask the live collector assistant questions as a throwaway demo collector. Usage: npm run ask -- "is mahine kitna kamaya" "e-waste kahan dun"
import { call, cardSignIn, outputs } from "./lib";

const out = outputs();
const base = out.ApiUrl!;
const demo = await (await fetch(`${base}/demo/start`, { method: "POST" })).json();
const token = await cardSignIn(out.CollectorClientId!, demo.username, demo.code);
const questions = process.argv.slice(2);
const history: { role: "user" | "assistant"; text: string }[] = [];
for (const q of questions.length ? questions : ["aaj ka hisaab batao"]) {
  const t0 = Date.now();
  const r = (await call(base, "POST", "/assistant", token, { text: q, history })).data as any;
  console.log(`> ${q}\n  [${r.via}, ${Date.now() - t0} ms] ${r.say}${r.action ? `  (action: ${r.action.type}${r.needsConfirm ? ", needs yes" : ""})` : ""}`);
  history.push({ role: "user", text: q }, { role: "assistant", text: r.say ?? "" });
}
