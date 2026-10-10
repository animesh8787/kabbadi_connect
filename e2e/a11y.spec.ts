import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { batch, mockApi, signInAs } from "./helpers";

// Fail on serious or critical WCAG A/AA problems on the screens a user actually sees.
async function check(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
}

test("login page is accessible", async ({ page }) => {
  await mockApi(page, {});
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kabadi Connect" })).toBeVisible();
  await check(page);
});

test("methodology page is accessible", async ({ page }) => {
  await page.goto("/methodology");
  await expect(page.getByRole("heading", { name: "How we count impact" })).toBeVisible();
  await check(page);
});

test("household screen is accessible", async ({ page }) => {
  await signInAs(page, ["household"]);
  await mockApi(page, { "GET /requests": { requests: [] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "New pickup" })).toBeVisible();
  await check(page);
});

test("collector screen is accessible", async ({ page }) => {
  await signInAs(page, ["collector"]);
  await mockApi(page, { "GET /collector/batches/today": { batches: [batch()] } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "आज की पिकअप" })).toBeVisible();
  await check(page);
});

test("judge page is accessible", async ({ page }) => {
  await mockApi(page, {});
  await page.goto("/judges");
  await expect(page.getByRole("heading", { name: "Try Kabadi Connect" })).toBeVisible();
  await check(page);
});
