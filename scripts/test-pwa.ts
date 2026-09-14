/**
 * Live harness — the portal is installable to a phone's home screen, and
 * behaves when the signal drops.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-pwa.ts
 *
 * Starts its OWN dev server (its own port and NEXT_DIST_DIR, so it cannot
 * clobber the ordinary dev server's webpack chunks, and so it is never fooled
 * by whatever else happens to be on :3000) and drives it in a real browser.
 * No provider keys needed — nothing here calls a model.
 *
 * What it proves, in order:
 *   1. the manifest is served to a SIGNED-OUT, cookie-less fetch as JSON —
 *      the way a browser really asks for it. Behind the auth middleware it
 *      would answer with the login page's HTML and the browser would simply
 *      never offer to install, with nothing logged anywhere
 *   2. it carries THIS instance's assistant name, not the product name: the
 *      harness renames the assistant and watches the manifest follow
 *   3. every icon the manifest advertises actually renders, at the size it
 *      claims, opaque where the platform requires it, and a size that is not
 *      on the allowlist is refused
 *   4. the head carries what iOS needs (it never reads the manifest for its
 *      home-screen icon) and viewport-fit=cover for the home indicator
 *   5. the service worker is served publicly and really registers, activates
 *      and takes control in a browser
 *   6. offline, a navigation shows OUR page — and, as a negative control, the
 *      same navigation with the worker removed does not
 *   7. the worker does not get in the app's way: signed in and controlled, the
 *      chat still renders and its API calls still answer
 *   8. on a phone-sized viewport nothing overflows sideways and the composer
 *      keeps its safe-area padding
 *
 * Restores the assistant's name, removes its throwaway user, and puts
 * next-env.d.ts / tsconfig.json back (Next rewrites them for the dist dir).
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { SETTING_KEYS } from "../src/lib/settings";

const PORT = Number(process.env.PWA_TEST_PORT ?? 3013);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "pwa-harness-1!";
const TEST_NAME = "Harness AI Assistant";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

/**
 * Next REWRITES next-env.d.ts and tsconfig.json to match distDir on every dev
 * start, so running a server with our own dist dir would leave both pointing
 * at a git-ignored directory that does not exist on a fresh checkout — and
 * `tsc` then fails in CI for a reason nothing in the diff explains.
 */
function snapshotNextFiles(): () => void {
  const files = ["next-env.d.ts", "tsconfig.json"];
  const before = files.map((f) => [f, readFileSync(f, "utf8")] as const);
  return () => {
    for (const [f, text] of before) {
      try {
        if (readFileSync(f, "utf8") !== text) writeFileSync(f, text);
      } catch {
        /* nothing worth failing the run over */
      }
    }
  };
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 60_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main(): Promise<void> {
  const restoreNextFiles = snapshotNextFiles();
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const email = `pwa-harness-${Date.now()}@example.test`;

  // Snapshot the assistant config: check 2 renames it and must put it back.
  const priorAssistant = await db.setting.findUnique({
    where: { key: SETTING_KEYS.assistant },
  });

  try {
    server = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["next", "dev", "--port", String(PORT)],
      {
        cwd: process.cwd(),
        env: { ...process.env, NEXT_DIST_DIR: ".next-pwa", AUTH_URL: "" },
        stdio: "ignore",
        shell: process.platform === "win32",
      },
    );
    if (!(await waitForServer(`${BASE}/login`, 180_000))) {
      check("the harness server started", false);
      return;
    }

    // ---- 1. the manifest, fetched the way a browser fetches it -----------
    // No cookies, no credentials. This is the exact request that silently
    // returns the login page when the middleware matcher forgets it.
    const manifestRes = await fetch(`${BASE}/manifest.webmanifest`, { redirect: "manual" });
    check("the manifest answers a signed-out request", manifestRes.status === 200, `status ${manifestRes.status}`);
    const ctype = manifestRes.headers.get("content-type") ?? "";
    check("…as a manifest, not HTML", ctype.includes("application/manifest+json"), ctype);

    const bodyText = await manifestRes.text();
    let manifest: Record<string, unknown> = {};
    let parsed = true;
    try {
      manifest = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = false;
    }
    check("…and it parses as JSON", parsed, bodyText.slice(0, 120));
    check(
      "the manifest asks to be installed as an app",
      manifest.display === "standalone" && manifest.scope === "/" && manifest.start_url === "/chat",
      `display=${String(manifest.display)} scope=${String(manifest.scope)} start=${String(manifest.start_url)}`,
    );

    const icons = (manifest.icons ?? []) as Array<{ src: string; sizes: string; purpose?: string }>;
    const sizes = icons.map((i) => `${i.sizes}${i.purpose === "maskable" ? " maskable" : ""}`);
    check(
      "it advertises the sizes Chrome needs plus a maskable one",
      sizes.includes("192x192") && sizes.includes("512x512") && sizes.includes("512x512 maskable"),
      sizes.join(", "),
    );

    // ---- 2. it is THIS instance's app, not "OPNinfer" --------------------
    const before = (priorAssistant?.value ?? {}) as Record<string, unknown>;
    await db.setting.upsert({
      where: { key: SETTING_KEYS.assistant },
      create: { key: SETTING_KEYS.assistant, value: { name: TEST_NAME, roles: {} } },
      update: { value: { ...before, name: TEST_NAME } },
    });
    const branded = (await (await fetch(`${BASE}/manifest.webmanifest`)).json()) as Record<string, unknown>;
    check("the manifest carries the assistant's own name", branded.name === TEST_NAME, String(branded.name));
    check(
      "…shortened for the space under a home-screen icon",
      branded.short_name === "Harness AI",
      String(branded.short_name),
    );
    check(
      "…and never the product name, which would be another client's brand",
      !JSON.stringify(branded).includes("OPNinfer"),
    );

    // ---- 3. the icons actually render ------------------------------------
    for (const icon of icons) {
      const res = await fetch(`${BASE}${icon.src}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata().catch(() => null);
      const want = Number(icon.sizes.split("x")[0]);
      const label = `${icon.sizes}${icon.purpose === "maskable" ? " maskable" : ""}`;
      check(
        `icon ${label} renders at the size it claims`,
        res.status === 200 &&
          (res.headers.get("content-type") ?? "").includes("image/png") &&
          meta?.width === want &&
          meta?.height === want,
        `status ${res.status} ${meta?.width}x${meta?.height}`,
      );
      if (icon.purpose === "maskable") {
        // A launcher masks this to its own shape; transparency there shows as
        // a black or white wedge behind the mark.
        const stats = await sharp(buf).stats();
        check(
          "…and the maskable icon is fully opaque, as the spec requires",
          stats.isOpaque === true,
          `isOpaque=${String(stats.isOpaque)}`,
        );
      }
    }

    const apple = await fetch(`${BASE}/api/pwa/icon?size=180`);
    const appleMeta = await sharp(Buffer.from(await apple.arrayBuffer())).metadata().catch(() => null);
    check(
      "the apple-touch-icon renders at 180",
      apple.status === 200 && appleMeta?.width === 180,
      `status ${apple.status} ${appleMeta?.width}`,
    );

    const silly = await fetch(`${BASE}/api/pwa/icon?size=4096`);
    check("a size off the allowlist is refused", silly.status === 400, `status ${silly.status}`);

    // ---- 4. what iOS reads out of the head -------------------------------
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? null,
      appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ?? null,
      appleCapable:
        document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute("content") ?? null,
      webAppCapable:
        document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute("content") ?? null,
      // Next emits the modern name itself for appleWebApp.capable, so writing
      // it by hand as well silently produces the tag twice.
      capableTags:
        document.querySelectorAll('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]')
          .length,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
    }));
    check("the head links the manifest", head.manifest === "/manifest.webmanifest", String(head.manifest));
    check(
      "…and an apple-touch-icon, which iOS takes instead of the manifest's",
      (head.appleIcon ?? "").startsWith("/api/pwa/icon?size=180"),
      String(head.appleIcon),
    );
    check(
      "…and says it can run as an app on both platforms, once each",
      head.appleCapable === "yes" && head.webAppCapable === "yes" && head.capableTags === 2,
      `apple=${head.appleCapable} modern=${head.webAppCapable} tags=${head.capableTags}`,
    );
    check(
      "…and asks for the whole screen, so the layout is not letterboxed",
      (head.viewport ?? "").includes("viewport-fit=cover"),
      String(head.viewport),
    );
    check("…and still sets a theme colour", !!head.themeColor, String(head.themeColor));

    // ---- 5. the worker is public, registers, and takes control -----------
    const swRes = await fetch(`${BASE}/sw.js`, { redirect: "manual" });
    const swType = swRes.headers.get("content-type") ?? "";
    check(
      "the service worker is served to a signed-out request as JavaScript",
      swRes.status === 200 && /javascript|ecmascript/i.test(swType),
      `status ${swRes.status} ${swType}`,
    );

    const activated = await page
      .evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return !!reg.active;
      })
      .catch(() => false);
    check("it registers and activates in a real browser", activated);

    await page.reload({ waitUntil: "domcontentloaded" });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check("…and controls the page on the next load", controlled);

    // ---- 6. offline, with a negative control -----------------------------
    await ctx.setOffline(true);
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const offlineText = await page.textContent("body").catch(() => "");
    check(
      "offline, a navigation shows our own page",
      /You're offline/i.test(offlineText ?? ""),
      (offlineText ?? "").slice(0, 80),
    );
    const hasRetry = await page.locator("button", { hasText: "Try again" }).count();
    check("…with a way to retry", hasRetry === 1);

    // The control: without the worker there is nothing of ours to show, so
    // this check cannot be passing for some other reason.
    await ctx.setOffline(false);
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    });
    await ctx.setOffline(true);
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const controlText = await page.textContent("body").catch(() => "");
    check(
      "NEGATIVE CONTROL: with the worker removed, offline shows the browser's error instead",
      !/You're offline/i.test(controlText ?? ""),
      (controlText ?? "").slice(0, 80),
    );
    await ctx.setOffline(false);

    // ---- 7. the worker stays out of the app's way ------------------------
    const user = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
        // The What's new overlay is a modal dialog Playwright will not click
        // through — every harness in this repo learned that the hard way.
        lastSeenVersion: "9.9.9",
      },
    });

    // A chat with messages in it, so the checks below meet the REAL composer —
    // the bottom-anchored one that carries the safe-area padding. An empty
    // chat centres a different layout. Seeded directly (no model call), with
    // strictly increasing stamps: a tie here would order the reply above its
    // own question (see the tie gotcha in CLAUDE.md).
    const now = Date.now();
    const convo = await db.conversation.create({
      data: {
        userId: user.id,
        title: "🧪 PWA harness chat",
        messages: {
          create: [
            { role: "user", content: "Hello from the harness.", userId: user.id, createdAt: new Date(now) },
            { role: "assistant", content: "Hello back.", createdAt: new Date(now + 1) },
          ],
        },
      },
    });

    const app = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const appPage = await app.newPage();
    const appErrors: string[] = [];
    appPage.on("pageerror", (e) => appErrors.push(String(e)));
    await signIn(appPage, user.email);
    await appPage.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await appPage.waitForSelector("textarea", { timeout: 60_000 });
    await appPage.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await appPage.reload({ waitUntil: "domcontentloaded" });
    await appPage.waitForSelector("textarea", { timeout: 60_000 });

    const underWorker = await appPage.evaluate(() => !!navigator.serviceWorker.controller);
    check("signed in, the chat loads with the worker in control", underWorker);

    // The API must pass straight through: it carries the chat's SSE stream,
    // uploads and signed downloads, and a worker answering any of it would
    // break a live reply.
    const apiOk = await appPage.evaluate(async () => {
      const res = await fetch("/api/files/status?ids=", { credentials: "same-origin" });
      return { status: res.status, type: res.headers.get("content-type") ?? "" };
    });
    check(
      "…and an API call still answers from the server, not the worker",
      apiOk.status < 400 && apiOk.type.includes("json"),
      `status ${apiOk.status} ${apiOk.type}`,
    );
    check("no page errors in the app", appErrors.length === 0, appErrors.join(" | "));

    // ---- 8. a phone-sized viewport ---------------------------------------
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      storageState: await app.storageState(),
    });
    const phonePage = await phone.newPage();
    await phonePage.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await phonePage.waitForSelector("textarea", { timeout: 60_000 });

    const overflow = await phonePage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("nothing overflows sideways on a phone", overflow <= 0, `${overflow}px`);

    const composerVisible = await phonePage.locator("textarea").isVisible();
    check("the composer is reachable on a phone", composerVisible);

    // The safe-area rule resolves to the old 1rem when the inset is 0, which is
    // every browser that is not a notched phone — including this one. That the
    // rule APPLIES is what can be checked here; the home indicator itself is
    // the owner's device to look at.
    const pad = await phonePage.evaluate(() => {
      const el = document.querySelector(".oi-safe-b");
      return el ? getComputedStyle(el).paddingBottom : null;
    });
    check("the composer carries the safe-area padding rule", pad === "16px", String(pad));

    await phone.close();
    await app.close();
    check("no page errors on the public pages", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser?.close();
    if (server?.pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], { stdio: "ignore" });
      } else {
        server.kill("SIGTERM");
      }
    }
    if (priorAssistant) {
      await db.setting.update({
        where: { key: SETTING_KEYS.assistant },
        data: { value: priorAssistant.value as object },
      });
    } else {
      await db.setting.deleteMany({ where: { key: SETTING_KEYS.assistant } });
    }
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
    restoreNextFiles();
  }

  console.log(failures === 0 ? "\nALL PWA CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
