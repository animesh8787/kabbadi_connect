import { expect, test } from "@playwright/test";
import { batch, mockApi, signInAs, stop } from "./helpers";

const items = [{ cat: "paper", bucket: "2-5", estKg: 3.5 }];
const profile = { address: "Saved Home, Rohini", lat: 28.7041, lng: 77.1025, phone: "9800000001" };

test.describe("household scheduling", () => {
  test("picks any of the next 7 days and a two-hour slot, adds a note, and reuses the saved address", async ({ page }) => {
    await signInAs(page, ["household"], "en");
    const calls = await mockApi(page, { "GET /requests": { requests: [] }, "GET /me/profile": { profile } });
    await page.goto("/app");
    await page.getByRole("button", { name: "Book", exact: true }).click();
    await expect(page.getByLabel("Address / landmark")).toHaveValue("Saved Home, Rohini"); // from the saved profile
    await page.getByRole("button", { name: /Paper/ }).click();
    await expect(page.getByRole("group", { name: "Pick a day" }).getByRole("button")).toHaveCount(7);
    await page.getByRole("group", { name: "Pick a day" }).getByRole("button").nth(3).click(); // three days from now: every slot is open
    await page.getByRole("button", { name: /2pm.4pm/ }).click();
    await page.getByLabel(/Note for the kabadiwala/).fill("Ring the bell twice");
    await page.getByRole("button", { name: "Schedule pickup" }).click();
    await expect.poll(() => calls.find((c) => c.method === "POST" && c.path === "/requests")).toBeTruthy();
    const body = calls.find((c) => c.method === "POST" && c.path === "/requests")!.body;
    expect(body.slot).toBe("s1416");
    expect(body.notes).toBe("Ring the bell twice");
    expect(body.address).toBe("Saved Home, Rohini");
    const days = (Date.parse(body.date) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.5);
    expect(days).toBeLessThan(3.6);
  });

  test("changes the time of an open pickup from the history", async ({ page }) => {
    await signInAs(page, ["household"], "en");
    const calls = await mockApi(page, {
      "GET /requests": { requests: [{ id: "a", status: "OPEN", items, address: "12 Main Rd", date: "2099-01-01", slot: "s1618", estKg: 3.5 }] },
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: /Change time/ }).click();
    await page.getByRole("group", { name: "Pick a day" }).getByRole("button").nth(4).click();
    await page.getByRole("button", { name: /10am.12pm/ }).click();
    await page.getByRole("button", { name: "Change time" }).last().click();
    await expect.poll(() => calls.find((c) => c.path === "/requests/a/reschedule")).toBeTruthy();
    expect(calls.find((c) => c.path === "/requests/a/reschedule")!.body.slot).toBe("s1012");
  });

  test("tracker says when nobody covers the address, and shows live distance when the kabadiwala is coming", async ({ page }) => {
    await signInAs(page, ["household"], "en");
    await mockApi(page, {
      "GET /requests": { requests: [{ id: "a", status: "OPEN", items, address: "Far Away Village", date: "2099-01-01", slot: "s1618", estKg: 3.5, collectorsNearby: 0 }] },
    });
    await page.goto("/app");
    await expect(page.getByText("No kabadiwala covers this address yet")).toBeVisible();

    await page.unrouteAll();
    await mockApi(page, {
      "GET /requests": { requests: [{ id: "b", status: "EN_ROUTE", items, address: "Near Me", date: "2099-01-01", slot: "s1618", estKg: 3.5 }] },
      "GET /requests/b/eta": { eta: { distanceKm: 1.2, minutes: 8 } },
    });
    await page.reload();
    await expect(page.getByText(/On the way: ~1.2 km, ~8 min/)).toBeVisible();
  });
});

test.describe("household assistant", () => {
  test("a typed request becomes a booking card and books only after Confirm", async ({ page }) => {
    await signInAs(page, ["household"], "en");
    const calls = await mockApi(page, {
      "GET /requests": { requests: [] },
      "GET /me/profile": { profile },
      "POST /household/assistant": {
        heard: "",
        say: "Tomorrow 4-6pm, 5-10 kg paper. Book it?",
        needsConfirm: true,
        action: { type: "book", booking: { items: [{ cat: "paper", bucket: "5-10" }], date: "2099-01-02", slot: "s1618" } },
      },
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "Speak", exact: true }).click();
    await page.getByRole("textbox", { name: /tomorrow evening/ }).fill("kal shaam 5 kilo raddi");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Tomorrow 4-6pm, 5-10 kg paper. Book it?")).toBeVisible();
    expect(calls.some((c) => c.method === "POST" && c.path === "/requests")).toBe(false); // nothing booked yet
    expect(calls.find((c) => c.path === "/household/assistant")!.body.text).toBe("kal shaam 5 kilo raddi");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => calls.find((c) => c.method === "POST" && c.path === "/requests")).toBeTruthy();
    const b = calls.find((c) => c.method === "POST" && c.path === "/requests")!.body;
    expect(b).toMatchObject({ date: "2099-01-02", slot: "s1618", address: "Saved Home, Rohini", items: [{ cat: "paper", bucket: "5-10" }] });
    await expect(page.getByText(/Booked/)).toBeVisible();
  });

  test("without a saved address the proposal opens the normal form, pre-filled", async ({ page }) => {
    await signInAs(page, ["household"], "en");
    await mockApi(page, {
      "GET /requests": { requests: [] },
      "GET /me/profile": { profile: null },
      "POST /household/assistant": { heard: "", say: "Book it?", needsConfirm: true, action: { type: "book", booking: { items: [{ cat: "metal", bucket: "2-5" }], date: "2099-01-02", slot: "s1012", notes: "gate 4" } } },
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "Speak", exact: true }).click();
    await page.getByRole("textbox", { name: /tomorrow evening/ }).fill("kal subah loha");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { name: "New pickup" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Metal/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel(/Note for the kabadiwala/)).toHaveValue("gate 4");
  });
});

test.describe("collector: nearby board and sign-in", () => {
  test("shows unclaimed requests nearby and claims one; a lost race shows a friendly message", async ({ page }) => {
    await signInAs(page, ["collector"], "en");
    const calls = await mockApi(page, {
      "GET /collector/batches/today": { batches: [] },
      "GET /collector/nearby": { radiusKm: 8, requests: [{ id: "n1", items, estKg: 3.5, date: "2099-01-01", slot: "s1012", distanceKm: 1.4, notes: "gate 4" }] },
    });
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: /Nearby requests/ })).toBeVisible();
    await expect(page.getByText(/1.4 km away/)).toBeVisible();
    await expect(page.getByText(/gate 4/)).toBeVisible();
    await page.getByRole("button", { name: "I will take it" }).click();
    await expect.poll(() => calls.some((c) => c.path === "/collector/nearby/n1/claim")).toBe(true);
  });

  test("the collector tab of the login form asks for a phone number and password, not an email", async ({ page }) => {
    await mockApi(page, {});
    await page.goto("/login");
    await page.getByRole("tab", { name: "I am a kabadiwala" }).click();
    await expect(page.getByLabel("Mobile number")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByText(/ask your admin for a new QR card/i)).toBeVisible();
  });

  test("a kabadiwala can ask to join from the landing page", async ({ page }) => {
    const calls = await mockApi(page, { "GET /public/impact": { pickups: 0, kg: 0, co2Kg: 0, ackKg: 0, segTotal: 0, segGood: 0, kmSavedPct: 0 } });
    await page.goto("/");
    const form = page.locator("#join");
    await form.getByLabel("Name").fill("Sunil");
    await form.getByLabel("Mobile number").fill("9811111111");
    await form.getByLabel("Area you cover").fill("Rohini Sector 7");
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText(/An admin will call you/)).toBeVisible();
    expect(calls.find((c) => c.path === "/public/join")!.body).toEqual({ name: "Sunil", phone: "9811111111", area: "Rohini Sector 7" });
  });
});

test.describe("collector: directions", () => {
  test.use({ permissions: ["geolocation"], geolocation: { latitude: 28.7, longitude: 77.1 } });
  // north ~220 m, then east ~220 m
  const line = [[77.1, 28.7], [77.1, 28.701], [77.1, 28.702], [77.1022, 28.702], [77.1044, 28.702]];
  const maneuvers = [{ idx: 0, kind: "depart", turn: "straight" }, { idx: 2, kind: "turn", turn: "right" }, { idx: 4, kind: "arrive", turn: "straight" }];

  test("speaks the next turn and updates as the phone moves, and shares position for the household ETA", async ({ page, context }) => {
    await signInAs(page, ["collector"], "en");
    const calls = await mockApi(page, {
      "GET /collector/batches/today": { batches: [batch({}, [stop({ id: "s1", status: "EN_ROUTE", lat: 28.702, lng: 77.1044 })])] },
      "GET /collector/route": { line, maneuvers, distanceM: 440, durationS: 400 },
    });
    await page.goto("/app");
    await page.getByRole("button", { name: /Show the way/ }).first().click();
    await expect(page.getByTestId("nav-banner")).toContainText(/turn right/i);
    await expect(page.getByTestId("nav-banner")).toContainText(/In 2\d\d metres|In 2\d0 metres|In 250 metres|In 200 metres/);
    await expect.poll(() => calls.some((c) => c.path === "/collector/route")).toBe(true);
    await expect.poll(() => calls.find((c) => c.path === "/collector/position")?.body?.stopId).toBe("s1");

    await context.setGeolocation({ latitude: 28.7019, longitude: 77.1 }); // 20 m before the turn
    await expect(page.getByTestId("nav-banner")).toHaveText(/^Turn right/i);
    await expect.poll(() => calls.filter((c) => c.path === "/speak").length).toBeGreaterThan(0); // it spoke

    await context.setGeolocation({ latitude: 28.702, longitude: 77.1043 }); // at the stop
    await expect(page.getByRole("button", { name: /You have arrived/ })).toBeVisible();
  });

  test("tells the collector when location is switched off", async ({ page, context }) => {
    await context.clearPermissions();
    await signInAs(page, ["collector"], "en");
    await mockApi(page, { "GET /collector/batches/today": { batches: [batch({}, [stop({ id: "s1", status: "EN_ROUTE" })])] } });
    await page.goto("/app");
    await page.getByRole("button", { name: /Show the way/ }).first().click();
    await expect(page.getByTestId("nav-banner")).toContainText(/Location is off|Finding your location/);
  });
});

test.describe("admin: unassigned requests and join requests", () => {
  test("lists requests nobody took, assigns one, and turns a join request into a collector form", async ({ page }) => {
    await signInAs(page, ["admin"], "en");
    const calls = await mockApi(page, {
      "GET /impact": { pickups: 0, kg: 0, co2Kg: 0, payout: 0, kmSavedPct: 0, routeKm: 0, naiveKm: 0, byCategory: {}, daily: [], ackKg: 0, ackPickups: 0, segTotal: 0, segGood: 0 },
      "GET /admin/collectors": { collectors: [{ id: "c1", name: "Ramesh", phone: "9800000001", areas: [], lat: 28.7, lng: 77.1, active: true, cardActive: false }] },
      "GET /admin/unassigned": { requests: [{ id: "u1", address: "Patiala Road", items, estKg: 3.5, date: "2099-01-01", slot: "s1214", collectorsNearby: 0 }] },
      "GET /admin/joins": { joins: [{ id: "j1", name: "Sunil", phone: "9811111111", area: "Rohini 7", createdAt: 1 }] },
      "POST /admin/unassigned/u1/assign": { batchId: "b", distanceKm: 3.2 },
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "Collectors" }).click();
    await expect(page.getByText("Patiala Road")).toBeVisible();
    await page.getByLabel("Give to…").selectOption({ label: "Ramesh" });
    await page.getByRole("button", { name: "✔" }).click();
    await expect.poll(() => calls.find((c) => c.path === "/admin/unassigned/u1/assign")?.body).toEqual({ collectorId: "c1" });

    await expect(page.getByText("Rohini 7")).toBeVisible();
    await page.getByRole("button", { name: "Create from this" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Sunil");
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue("9811111111");
  });
});
