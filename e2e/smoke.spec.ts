import { test, expect } from "@playwright/test";

/**
 * Core journey, no provider keys required (so it runs in CI without secrets):
 * first-run admin setup → login → chat shell → admin sections → auth gate.
 * Runs serially against a freshly-truncated DB (see global-setup).
 */
const ADMIN_EMAIL = "admin@e2e.local";
const ADMIN_PASSWORD = "password123";

test.describe.configure({ mode: "serial" });

test("first run redirects to setup and creates the admin", async ({ page }) => {
  await page.goto("/");
  // Zero users → middleware/login gate funnels to the setup screen.
  await expect(page).toHaveURL(/\/setup/);

  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.locator("#confirm").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create admin account" }).click();

  await expect(page).toHaveURL(/\/login/);
});

test("admin can log in and reach the chat workspace", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByRole("link", { name: "New chat" })).toBeVisible();
  // Empty chat workspace: a suggestion chip is a stable marker (the greeting
  // heading is a randomised welcome, so we don't assert its exact text).
  await expect(page.getByRole("button", { name: "Brainstorm" })).toBeVisible();
});

test("admin API page shows the credential form", async ({ page }) => {
  await login(page);
  await page.goto("/admin/api");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("Add a provider key")).toBeVisible();
  // Assistant not configured yet → chat nudges to set it up.
  await page.goto("/chat");
  await expect(page.getByText(/An admin needs to configure the assistant/)).toBeVisible();
});

test("admin area redirects to Users and exposes all sections", async ({ page }) => {
  await login(page);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  // The seeded admin appears in the user table.
  await expect(page.getByText(ADMIN_EMAIL).first()).toBeVisible();
  // The section nav exposes every admin page.
  for (const label of ["API", "Models", "Users", "Usage", "SMTP", "Customise", "Logs"]) {
    await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
});

test("unauthenticated access is redirected to login", async ({ page }) => {
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
});

/** Helper: sign in via the credentials form. */
async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/chat/);
}
