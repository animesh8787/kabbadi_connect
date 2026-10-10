import { expect, test } from "@playwright/test";
import { batch, mockApi, signInAs, stop } from "./helpers";

test("login page and public methodology page render without a session", async ({ page }) => {
  await mockApi(page, {});
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kabadi Connect" })).toBeVisible();
  await page.goto("/methodology");
  await expect(page.getByRole("heading", { name: "How we count impact" })).toBeVisible();
  await expect(page.getByRole("link", { name: /EPA WARM v16 management practices/ })).toBeVisible();
  await expect(page.getByText("indicative, not yet verified")).toBeVisible();
});

test("household schedules a pickup with the chosen materials and pin", async ({ page }) => {
  await signInAs(page, ["household"]);
  const calls = await mockApi(page, { "GET /requests": { requests: [] } });
  await page.goto("/");
  await page.getByRole("button", { name: /Paper/ }).click();
  await page.getByLabel("Address / landmark").fill("12 Main Road, Rohini");
  await page.locator(".map").click({ position: { x: 150, y: 120 } });
  await expect(page.getByText(/Estimated payout/)).toBeVisible();
  await page.getByRole("button", { name: "Schedule pickup" }).click();
  await expect.poll(() => calls.find((c) => c.method === "POST" && c.path === "/requests")).toBeTruthy();
  const body = calls.find((c) => c.path === "/requests" && c.method === "POST")!.body;
  expect(body.items).toEqual([{ cat: "paper", bucket: "2-5" }]);
  expect(body.address).toBe("12 Main Road, Rohini");
  expect(typeof body.lat).toBe("number");
});

test("household cannot submit without a map pin", async ({ page }) => {
  await signInAs(page, ["household"]);
  const calls = await mockApi(page, { "GET /requests": { requests: [] } });
  await page.goto("/");
  await page.getByRole("button", { name: /Paper/ }).click();
  await page.getByLabel("Address / landmark").fill("12 Main Road");
  await page.getByRole("button", { name: "Schedule pickup" }).click();
  await expect(page.getByRole("alert")).toContainText("Tap the map");
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("collector sees Hindi screen, rates segregation and confirms weights", async ({ page }) => {
  await signInAs(page, ["collector"]);
  const calls = await mockApi(page, { "GET /collector/batches/today": { batches: [batch()] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "आज की पिकअप" })).toBeVisible();
  await expect(page.getByRole("button", { name: "दबाकर बोलिए" })).toBeVisible();
  await page.getByPlaceholder("किलो").fill("5");
  await page.getByRole("button", { name: /अच्छा अलग/ }).click();
  await page.getByRole("button", { name: /उठाया/ }).click();
  await expect.poll(() => calls.find((c) => c.path === "/requests/s1/confirm")).toBeTruthy();
  expect(calls.find((c) => c.path === "/requests/s1/confirm")!.body).toEqual({ items: [{ cat: "paper", actualKg: 5 }], segregation: "good" });
});

test("collector starts a waiting batch", async ({ page }) => {
  await signInAs(page, ["collector"]);
  const calls = await mockApi(page, {
    "GET /collector/batches/today": { batches: [batch({ status: "ASSIGNED" }, [stop({ status: "ASSIGNED" })])] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /शुरू करें/ }).click();
  await expect.poll(() => calls.some((c) => c.path === "/batches/b1/accept")).toBe(true);
});

test("e-waste stop shows the authorised recyclers with map links", async ({ page }) => {
  await signInAs(page, ["collector"], "en");
  await mockApi(page, {
    "GET /collector/batches/today": { batches: [batch({}, [stop({ items: [{ cat: "ewaste", bucket: "<2", estKg: 1 }] })])] },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /E-waste: authorised recyclers/ })).toBeVisible();
  await expect(page.getByText("M/s Muskan Technologies")).toBeVisible();
  const href = await page.getByRole("link", { name: "Open map" }).first().getAttribute("href");
  expect(href).toContain("google.com/maps/search");
});

test("admin dashboard shows impact tiles and the methodology link", async ({ page }) => {
  await signInAs(page, ["admin"], "en");
  await mockApi(page, {
    "GET /impact": { pickups: 7, kg: 84.5, co2Kg: 210, payout: 1300, kmSavedPct: 18, byCategory: { paper: 40, plastic: 20, metal: 10, ewaste: 4.5, glass: 10 }, daily: [], ackKg: 60, ackPickups: 5, segTotal: 4, segGood: 3 },
  });
  await page.goto("/");
  await expect(page.getByText("84.5")).toBeVisible();
  await expect(page.getByText("75%")).toBeVisible(); // 3 of 4 well sorted
  await expect(page.getByRole("link", { name: "How we count impact" })).toBeVisible();
});

test("admin issues a new login card and sees a QR code", async ({ page }) => {
  await signInAs(page, ["admin"], "en");
  const calls = await mockApi(page, {
    "GET /impact": { pickups: 0, kg: 0, co2Kg: 0, payout: 0, kmSavedPct: 0, byCategory: {}, daily: [], ackKg: 0, ackPickups: 0, segTotal: 0, segGood: 0 },
    "GET /admin/collectors": { collectors: [{ id: "c1", name: "Ramesh", phone: "9800000001", areas: ["ttng6"], lat: 28.7, lng: 77.1, active: true, cardActive: false }] },
    "POST /admin/collectors/c1/enroll": { id: "c1", username: "9800000001@collectors.kabadi.invalid", code: "abc123", validUntil: Date.now() + 86_400_000 },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Collectors" }).click();
  await expect(page.getByText("Ramesh")).toBeVisible();
  await page.getByRole("button", { name: /New card/ }).click();
  await expect(page.getByAltText("QR")).toBeVisible();
  await expect(page.getByText("Works once. Keep it private.")).toBeVisible();
  expect(calls.some((c) => c.path === "/admin/collectors/c1/enroll")).toBe(true);
});

test("collector opens a QR card link and a bad code shows the Hindi-friendly error", async ({ page }) => {
  await mockApi(page, {});
  // No Cognito in tests: the failed custom-auth call surfaces as the card error.
  await page.route("https://cognito-idp.ap-south-1.amazonaws.com/**", (r) => r.fulfill({ status: 400, json: { __type: "NotAuthorizedException", message: "x" } }));
  await page.goto("/?enroll=bad&u=x%40y.invalid");
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect(page.url()).not.toContain("enroll="); // single-use code never stays in the address bar
});

test("judge page starts a demo and shows a scannable card, without any login", async ({ page }) => {
  const calls = await mockApi(page, { "POST /demo/start": { username: "8123456789@collectors.kabadi.invalid", code: "democode", validUntil: Date.now() + 86_400_000 } });
  await page.goto("/judges");
  await expect(page.getByRole("heading", { name: "Try Kabadi Connect" })).toBeVisible();
  await page.getByRole("button", { name: "Start collector demo" }).click();
  await expect(page.getByAltText("QR code for the demo collector card")).toBeVisible();
  const href = await page.getByRole("link", { name: "Open the collector app here" }).getAttribute("href");
  expect(href).toContain("enroll=democode");
  expect(calls.some((c) => c.method === "POST" && c.path === "/demo/start")).toBe(true);
});

test("judge page shows a friendly message when the daily demo cap is hit", async ({ page }) => {
  await mockApi(page, {});
  await page.route("**/v1/demo/start", (r) =>
    r.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, json: { error: "The demo is busy today, please try again tomorrow." } }),
  );
  await page.goto("/judges");
  await page.getByRole("button", { name: "Start collector demo" }).click();
  await expect(page.getByRole("alert")).toContainText("busy today");
});
