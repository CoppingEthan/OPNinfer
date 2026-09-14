import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config (spec §14). The app under test is started by Playwright on port
 * 3100 and talks to whatever DATABASE_URL is in the environment. The global
 * setup resets that database to a clean slate, so the first-run admin setup
 * flow is deterministic — see e2e/global-setup.ts (it refuses to wipe a DB
 * whose name doesn't contain "e2e" unless running in CI).
 */
const PORT = 3100;
// Connect over IPv4 explicitly — Chromium may resolve "localhost" to ::1 while
// Next listens on 127.0.0.1, surfacing as ERR_CONNECTION_REFUSED. Overridable
// via E2E_HOST for environments where Chromium can't reach loopback.
const HOST = process.env.E2E_HOST ?? "127.0.0.1";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false, // shared DB state — run serially
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The first requests to a cold production server (+ multi-hop auth redirects
  // and CPU-bound argon2) can be slow on a CI runner — give assertions headroom.
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "on-first-retry",
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: process.env.CI
      ? `pnpm start -H ${HOST} -p ${PORT}`
      : `pnpm dev -H ${HOST} -p ${PORT}`,
    url: `http://${HOST}:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Surface the app server's own logs in the CI output — otherwise a
    // server-side error (e.g. a thrown Server Action) is invisible in the run.
    stdout: "pipe",
    stderr: "pipe",
  },
});
