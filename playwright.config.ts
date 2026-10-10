import { defineConfig } from "@playwright/test";

// Uses the Edge/Chrome already on the machine (channel) so no browser download is needed; CI installs chromium instead.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4173",
    channel: process.env.CI ? undefined : "msedge",
    viewport: { width: 375, height: 812 },
    locale: "en-IN",
    serviceWorkers: "block",
  },
  webServer: {
    command: "npm -w packages/web run build && npm -w packages/web exec -- vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
