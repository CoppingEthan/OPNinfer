/**
 * Live browser test of the What's new panel and chat tab titles.
 *
 * Both features are about what the browser actually does — a panel that
 * interrupts you exactly once, and a tab that renames itself — so neither is
 * provable from unit tests alone. The parsing and the "should this interrupt
 * the user" rules are unit-tested in src/lib/changelog.test.ts; this proves the
 * wiring around them.
 *
 * What it proves, in order:
 *   1. a fresh account is shown the panel, with ONLY the latest release
 *   2. showing it does NOT mark it seen — dismissing it does
 *   3. the stamp is the SERVER's version, and a reload does not show it again
 *   4. the account menu reopens it, showing the full history
 *   5. reopening it by hand does not disturb the stamp
 *   6. opening a chat puts that chat's title in the browser tab
 *   7. another user's chat leaks no title (generateMetadata re-checks the owner)
 *   8. renaming the open chat renames its tab, in the same document
 *
 * Needs no provider keys — every check is app-side.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-whats-new.ts
 */
import { chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { APP_VERSION } from "../src/lib/version";
import { parseChangelog, releasesSince } from "../src/lib/changelog";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "whats-new-1!";
const CAT_TITLE = "Story about a cat";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

async function signIn(email: string) {
  const jar = new Map<string, string>();
  const store = (cs: string[]) => {
    for (const c of cs) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
  store(r1.headers.getSetCookie());
  const { csrfToken } = (await r1.json()) as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

const panel = (page: Page) => page.locator('[role="dialog"][aria-modal="true"]').first();

async function lastSeen(userId: string): Promise<string | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { lastSeenVersion: true },
  });
  return row?.lastSeenVersion ?? null;
}

async function main() {
  const stamp = Date.now();
  const hash = await hashPassword(PASSWORD);
  const user = await db.user.create({
    data: {
      email: `whats-new-${stamp}@example.test`,
      passwordHash: hash,
      role: "user",
      emailVerified: new Date(),
    },
  });
  const other = await db.user.create({
    data: {
      email: `whats-new-other-${stamp}@example.test`,
      passwordHash: hash,
      role: "user",
      emailVerified: new Date(),
    },
  });

  const all = parseChangelog(
    readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8"),
  );
  // What the running instance is allowed to show at all, and the one release a
  // first-time viewer should get.
  const shipped = releasesSince(all, "0", APP_VERSION);
  const latest = shipped[0];

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 950 },
    });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    // ---- 1. a fresh account is interrupted, once, with the latest release --
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await panel(page).waitFor({ state: "visible", timeout: 60_000 });
    check("panel pops itself for a never-seen account", true);

    const text = await panel(page).innerText();
    check(
      "it shows the release the instance is actually running",
      text.includes(`Version ${latest.version}`),
      text.split("\n").slice(0, 4).join(" / "),
    );
    const sectionsAuto = await panel(page).locator("section").count();
    check(
      "a first-time viewer gets ONE release, not the whole history",
      sectionsAuto === 1,
      `${sectionsAuto} sections`,
    );
    const bullets = await panel(page).locator("li").count();
    // Bold leads are the house style for a feature line, but a fix-only
    // release is ONE plain sentence by owner rule ("General security, feature
    // and UX updates.") — demanding bold there failed the harness for a
    // correctly-written 0.6.1. Ask for rendered bold only when the notes
    // actually contain some; what matters either way is that every bullet
    // arrived.
    const wantsBold = latest.items.some((i) => i.includes("**"));
    const boldCount = await panel(page).locator("li strong").count();
    check(
      "bullets render, with their bold leads where there are any",
      bullets === latest.items.length && (!wantsBold || boldCount > 0),
      `${bullets} of ${latest.items.length} bullets, ${boldCount} bold`,
    );

    // ---- 2. seen on dismissal, not on display ------------------------------
    check(
      "showing it does NOT mark it seen",
      (await lastSeen(user.id)) === null,
      String(await lastSeen(user.id)),
    );

    await panel(page).getByRole("button", { name: "Got it" }).click();
    await panel(page).waitFor({ state: "detached", timeout: 15_000 });
    let seen: string | null = null;
    for (let i = 0; i < 30; i++) {
      seen = await lastSeen(user.id);
      if (seen) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check("dismissing stamps the running app version", seen === APP_VERSION, String(seen));

    // ---- 3. it does not come back ------------------------------------------
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    check("no second interruption once it has been seen", (await panel(page).count()) === 0);

    // ---- 4. the account menu reopens it, with the full history -------------
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: /what/i }).click();
    await panel(page).waitFor({ state: "visible", timeout: 20_000 });
    await page
      .waitForFunction(
        'document.querySelectorAll(\'[role="dialog"] section\').length > 1',
        null,
        { timeout: 20_000 },
      )
      .catch(() => {});
    const sections = await panel(page).locator("section").count();
    check(
      "reopening by hand shows every release, not just the unseen ones",
      sections === shipped.length && sections > 1,
      `${sections} of ${shipped.length}`,
    );

    // ---- 5. a manual open leaves the stamp alone ---------------------------
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1000);
    check(
      "closing a hand-opened panel does not re-stamp",
      (await lastSeen(user.id)) === APP_VERSION,
      String(await lastSeen(user.id)),
    );

    // ---- 6. the chat's title is the tab's title ----------------------------
    const mine = await db.conversation.create({
      data: { userId: user.id, title: CAT_TITLE },
    });
    await page.goto(`${BASE}/chat/${mine.id}`, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(`document.title.includes(${JSON.stringify(CAT_TITLE)})`, null, {
        timeout: 20_000,
      })
      .catch(() => {});
    check(
      "opening a chat titles the tab",
      (await page.title()) === `${CAT_TITLE} · OPNinfer`,
      await page.title(),
    );

    // ---- 7. someone else's chat leaks no title -----------------------------
    const theirs = await db.conversation.create({
      data: { userId: other.id, title: "Confidential redundancy plan" },
    });
    await page.goto(`${BASE}/chat/${theirs.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const leaked = await page.title();
    check("another user's chat title never reaches the tab", !/redundancy/i.test(leaked), leaked);

    // ---- 8. renaming the open chat renames its tab -------------------------
    await page.goto(`${BASE}/chat/${mine.id}`, { waitUntil: "domcontentloaded" });
    const row = page.locator(`a[href="/chat/${mine.id}"]`).first();
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500); // let hydration settle before clicking
    await row.hover();
    await page.locator('[aria-label="Chat options"]').first().click();
    await page.getByRole("menuitem", { name: /^Rename$/ }).click();
    // Located by position, not by value: the rename box is a controlled input,
    // so a `[value="…"]` selector stops matching the moment it is typed into.
    const input = page.locator("aside form input").first();
    await input.waitFor({ state: "visible", timeout: 15_000 });
    check("rename box opens with the current title", (await input.inputValue()) === CAT_TITLE, await input.inputValue());
    // Mark the document, so a full page load would be detectable afterwards.
    await page.evaluate("window.__oiSameDocument = true");
    await input.fill("Renamed by hand");
    await input.press("Enter");
    await page.waitForFunction('document.title.startsWith("Renamed by hand")', null, {
      timeout: 20_000,
    });
    check(
      "renaming the open chat renames its tab",
      (await page.title()) === "Renamed by hand · OPNinfer",
      await page.title(),
    );
    check(
      "...in the same document (no page load)",
      (await page.evaluate("window.__oiSameDocument === true")) === true,
    );

    check("no page errors throughout", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await db.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
