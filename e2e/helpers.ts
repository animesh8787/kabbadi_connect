import type { Page } from "@playwright/test";

export const API = "http://api.test/v1";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Pretend to be signed in: the app only decodes the id token and checks its expiry. */
export async function signInAs(page: Page, groups: string[], lang?: "en" | "hi") {
  const token = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "test@example.com", exp: Math.floor(Date.now() / 1000) + 3600, "cognito:groups": groups })}.x`;
  const session = { idToken: token, refreshToken: "r", exp: Date.now() + 3_600_000, email: "test@example.com", groups, clientId: "c" };
  await page.addInitScript(
    ([s, l]) => {
      localStorage.setItem("kc.session", s as string);
      if (l) localStorage.setItem("kc.lang", l as string);
    },
    [JSON.stringify(session), lang ?? ""],
  );
}

export interface Call {
  method: string;
  path: string;
  body: any;
}

/** Serve /config.json and a fake API; returns the list of API calls the app made. */
export async function mockApi(page: Page, responses: Record<string, unknown>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/tile.openstreetmap.org/**", (r) => r.abort());
  await page.route("**/maps.geo.*.amazonaws.com/**", (r) => r.abort());
  await page.route("**/config.json", (r) =>
    r.fulfill({ json: { apiUrl: API, region: "ap-south-1", clientId: "c", collectorClientId: "cc" } }),
  );
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace("/v1", "");
    calls.push({ method: req.method(), path, body: req.postData() ? JSON.parse(req.postData()!) : undefined });
    const hit = responses[`${req.method()} ${path}`] ?? { ok: true };
    return route.fulfill({ status: 200, headers: cors, json: hit as object });
  });
  return calls;
}

export const stop = (over: object = {}) => ({
  id: "s1",
  status: "EN_ROUTE",
  address: "House 22, Sector 4, Rohini",
  lat: 28.7,
  lng: 77.1,
  items: [{ cat: "paper", bucket: "2-5", estKg: 3.5 }],
  estKg: 3.5,
  phone: "9800000001",
  ...over,
});

export const batch = (over: object = {}, stops: object[] = [stop()]) => ({
  id: "b1",
  window: "2026-10-11#evening",
  status: "ACTIVE",
  km: 1.2,
  naiveKm: 2,
  routeSource: "location",
  estKg: 3.5,
  stops,
  ...over,
});
