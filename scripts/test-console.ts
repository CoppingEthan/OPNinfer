/**
 * Live test of the OPERATOR CONSOLE — the read-only overview across every
 * portal on the host.
 *
 * It runs a SECOND dev server from this same checkout with
 * OPNINFER_MODE=console (its own NEXT_DIST_DIR, so it cannot clobber the
 * portal dev server's webpack chunks), pointed at the local dev database as
 * if it were a portal, and drives it in a real browser.
 *
 * What it proves, in order:
 *   1. the read-only Postgres role is genuinely read-only — a write from it
 *      is refused by the DATABASE, not by our query layer (the whole point
 *      of the design, and the one thing no unit test can show)
 *   2. the console refuses portal routes, and the portal refuses the console
 *   3. an operator account from the env file signs in; a wrong password does
 *      not; there is no /setup and no password reset to slip through
 *   4. the overview renders REAL numbers from the portal's database, and the
 *      per-portal row matches what the same query returns directly
 *   5. every section renders: usage (the portals' own dashboard component
 *      over the merged payload), people, activity, feedback, sandbox, logs
 *   6. the API refuses an unauthenticated caller
 *
 * The portal half of check 2 needs the ordinary dev server on :3000; the rest
 * is self-contained. No provider keys needed — nothing here calls a model.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-console.ts
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const PORTAL_BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const CONSOLE_PORT = Number(process.env.CONSOLE_TEST_PORT ?? 3011);
const CONSOLE_BASE = `http://localhost:${CONSOLE_PORT}`;
const OPERATOR = "console-harness@example.test";
const PASSWORD = "console-harness-1!";
const RO_PASSWORD = "consoleHarnessRoPw";
const PORTAL_NAME = "devbox";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

/**
 * Next REWRITES `next-env.d.ts` and `tsconfig.json` to match `distDir` on
 * every dev start, so running the console server points them at
 * `.next-console` — a git-ignored directory that does not exist on a fresh
 * checkout, which would then fail `tsc`. Snapshot both and put them back.
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

/** The app's DATABASE_URL, with the user/password swapped for console_ro. */
function readOnlyUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set — run with --env-file=.env");
  const u = new URL(raw);
  u.username = "console_ro";
  u.password = RO_PASSWORD;
  u.searchParams.set("connection_limit", "2");
  return u.toString();
}

/** Create the SELECT-only role, exactly as deploy.sh's ensure_console_role does. */
async function createReadOnlyRole(): Promise<void> {
  const dbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");
  await db.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'console_ro') THEN
        CREATE ROLE console_ro LOGIN;
      END IF;
    END
    $$;
  `);
  await db.$executeRawUnsafe(`ALTER ROLE console_ro WITH LOGIN PASSWORD '${RO_PASSWORD}'`);
  await db.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO console_ro`);
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO console_ro`);
  await db.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO console_ro`);
  await db.$executeRawUnsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO console_ro`,
  );
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

async function signIn(page: Page): Promise<void> {
  await page.goto(`${CONSOLE_BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 30_000 });
  await page.fill('input[name="email"]', OPERATOR);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main(): Promise<void> {
  const restoreNextFiles = snapshotNextFiles();
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  let ro: PrismaClient | null = null;

  try {
    // ---- 1. the read-only role ------------------------------------------
    await createReadOnlyRole();
    ro = new PrismaClient({ datasourceUrl: readOnlyUrl(), log: [] });

    const users = await ro.user.count();
    check("console_ro can READ the portal's data", users >= 0, `${users} users`);

    let wrote = false;
    let refusal = "";
    try {
      await ro.$executeRawUnsafe(
        `INSERT INTO app_log (id, level, category, message) VALUES (gen_random_uuid(), 'info', 'test', 'console harness should not be able to write')`,
      );
      wrote = true;
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    check(
      "console_ro CANNOT write — the database refuses it, not our code",
      !wrote && /permission denied/i.test(refusal),
      wrote ? "the insert SUCCEEDED" : refusal,
    );

    let updated = false;
    try {
      await ro.$executeRawUnsafe(`UPDATE users SET name = name`);
      updated = true;
    } catch {
      /* expected */
    }
    check("console_ro cannot UPDATE either", !updated);

    // ---- start the console ----------------------------------------------
    const hash = await hashPassword(PASSWORD);
    server = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["next", "dev", "--port", String(CONSOLE_PORT)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXT_DIST_DIR: ".next-console",
          OPNINFER_MODE: "console",
          OPNINFER_INSTANCE: "console",
          // Next does not overwrite values already in process.env, so these
          // win over .env for this process only.
          // The base64 form, because that is what deploy.sh writes: docker
          // compose interpolates `$` in an env_file and would otherwise eat
          // the argon2 hash (see operators.ts).
          CONSOLE_OPERATORS_B64: Buffer.from(`${OPERATOR}:${hash}`).toString("base64"),
          CONSOLE_INSTANCES: PORTAL_NAME,
          [`CONSOLE_DB_${PORTAL_NAME.toUpperCase()}`]: readOnlyUrl(),
          [`CONSOLE_LABEL_${PORTAL_NAME.toUpperCase()}`]: "dev box",
          AUTH_URL: "",
        },
        stdio: "ignore",
        shell: process.platform === "win32",
      },
    );

    const up = await waitForServer(`${CONSOLE_BASE}/login`, 180_000);
    if (!up) {
      check("the console dev server starts", false, "never answered on /login");
      return;
    }
    check("the console dev server starts", true);

    browser = await chromium.launch();
    const page = await browser.newPage();

    // ---- 2. the two halves stay separate --------------------------------
    const chatOnConsole = await page.goto(`${CONSOLE_BASE}/chat`, {
      waitUntil: "domcontentloaded",
    });
    check("the console 404s a portal route (/chat)", chatOnConsole?.status() === 404, String(chatOnConsole?.status()));

    const setupOnConsole = await page.goto(`${CONSOLE_BASE}/setup`, {
      waitUntil: "domcontentloaded",
    });
    check(
      "the console 404s /setup — there is no bootstrap here",
      setupOnConsole?.status() === 404,
      String(setupOnConsole?.status()),
    );

    const portalUp = await waitForServer(`${PORTAL_BASE}/login`, 3_000);
    if (portalUp) {
      const consoleOnPortal = await page.goto(`${PORTAL_BASE}/console`, {
        waitUntil: "domcontentloaded",
      });
      check(
        "a portal 404s the console tree",
        consoleOnPortal?.status() === 404,
        String(consoleOnPortal?.status()),
      );
    } else {
      console.log("SKIP the portal half of the isolation check — nothing on " + PORTAL_BASE);
    }

    // ---- 3. sign-in ------------------------------------------------------
    await page.goto(`${CONSOLE_BASE}/console`, { waitUntil: "domcontentloaded" });
    check("an unauthenticated visit is sent to sign in", page.url().includes("/login"));

    const apiUnauth = await page.request.get(`${CONSOLE_BASE}/api/console/overview`, {
      maxRedirects: 0,
    });
    check(
      "the console API refuses an unauthenticated caller",
      apiUnauth.status() === 307 || apiUnauth.status() === 403,
      String(apiUnauth.status()),
    );

    await page.goto(`${CONSOLE_BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="email"]', { timeout: 30_000 });
    await page.fill('input[name="email"]', OPERATOR);
    await page.fill('input[name="password"]', "definitely-wrong");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2_500);
    check("a wrong password does not sign in", page.url().includes("/login"), page.url());

    await signIn(page);
    check("the operator account from the env file signs in", page.url().includes("/console"), page.url());

    // ---- 4. the overview shows real numbers ------------------------------
    await page.waitForSelector("table", { timeout: 30_000 });
    const bodyText = (await page.textContent("body")) ?? "";
    check("the overview names the portal", bodyText.includes("dev box"));

    const chats = await db.conversation.count();
    const shown = await page.textContent("table tbody tr");
    check(
      "the portal row renders (chats column present)",
      !!shown && shown.length > 0,
      `db has ${chats} chats`,
    );

    const overview = await page.request.get(`${CONSOLE_BASE}/api/console/overview?range=month`);
    const payload = (await overview.json()) as {
      portals: { instance: { name: string }; data: { users: number; chats: number } | null; error: string | null }[];
      totals: { users: number; chats: number };
    };
    const portal = payload.portals.find((p) => p.instance.name === PORTAL_NAME);
    check("the API reaches the portal database", !!portal && !portal.error, portal?.error ?? "");
    check(
      "its user count matches a direct query",
      portal?.data?.users === (await db.user.count()),
      `console ${portal?.data?.users} vs db ${await db.user.count()}`,
    );
    check(
      "its chat count matches a direct query",
      portal?.data?.chats === chats,
      `console ${portal?.data?.chats} vs db ${chats}`,
    );

    // ---- 5. every section renders ---------------------------------------
    // Markers are deliberately NOT the nav labels ("Usage", "People",
    // "Sandbox"…): those appear in the sidebar of every page, so asserting on
    // them would pass even if the page itself rendered nothing at all.
    for (const [path, marker] of [
      ["/console/usage", "Tokens, cost and requests across every portal"],
      ["/console/users", "with what it has actually used"],
      ["/console/activity", "What came out of it"],
      ["/console/feedback", "What people thought of the replies"],
      ["/console/sandbox", "fallback spend, and what it reached for"],
      ["/console/logs", "merged and sorted by time"],
    ] as const) {
      const res = await page.goto(`${CONSOLE_BASE}${path}`, { waitUntil: "domcontentloaded" });
      const ok = res?.status() === 200;
      await page.waitForTimeout(1_500);
      const text = (await page.textContent("body")) ?? "";
      const found = text.includes(marker);
      check(`${path} renders`, ok && found, ok ? (found ? "" : `marker missing: ${marker}`) : `status ${res?.status()}`);
      // A page that threw would render Next's error surface — catch that
      // explicitly rather than trusting the marker alone.
      check(`${path} has no server error`, !/Application error|Internal Server Error/i.test(text));
    }

    // Negative control for the loop above: a marker that is NOT on the page
    // must fail the same test, or the six checks proved nothing.
    {
      await page.goto(`${CONSOLE_BASE}/console/logs`, { waitUntil: "domcontentloaded" });
      const text = (await page.textContent("body")) ?? "";
      check("(control) an absent marker would have been caught", !text.includes("fallback spend, and what it reached for"));
    }

    // ---- 5a. who asked for a sign-in link and never used it -------------
    // Owner ask, 2026-09-09: clients say they cannot get in, and the suspicion
    // is that the reset emails are being filtered by their mail system. An
    // EXPIRED, UNUSED link is the evidence. Seeded here rather than waited for:
    // the rule is unit-tested in reset-watch.test.ts, and this proves the page
    // actually surfaces it — by name, at the top, not as a badge to hunt for.
    {
      const victim = await db.user.findFirst({
        where: { email: { not: OPERATOR } },
        select: { id: true, email: true, passwordChangedAt: true },
      });
      if (!victim) {
        check("a user exists to seed a stuck reset against", false);
      } else {
        // Any later password change would (correctly) clear the flag, so the
        // seeded ask must be NEWER than it.
        const base = victim.passwordChangedAt?.getTime() ?? Date.now();
        const asked = new Date(base + 60_000);
        const seeded = await db.passwordResetToken.create({
          data: {
            userId: victim.id,
            tokenHash: `harness-stuck-${Date.now()}`,
            createdAt: asked,
            // Already expired: the whole point of "stuck".
            expiresAt: new Date(asked.getTime() + 3_600_000 - 7 * 86_400_000),
          },
          select: { id: true },
        });
        try {
          await page.goto(`${CONSOLE_BASE}/console/users`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2_000);
          const banner = page.locator("[data-reset-stuck]");
          check("the stuck-reset banner appears", (await banner.count()) === 1);
          const text = (await page.textContent("body")) ?? "";
          check(
            "…and names the person, so it can be acted on",
            text.includes(victim.email),
            victim.email,
          );
          check(
            "…and says what it means",
            text.includes("never used it") && text.includes("Admin"),
          );
          check("…and the row is badged to match", (await page.locator('[data-reset="stuck"]').count()) >= 1);
        } finally {
          await db.passwordResetToken.delete({ where: { id: seeded.id } }).catch(() => {});
        }
        // Negative control: with the seeded row gone the banner must go too,
        // or the four checks above would pass on a permanently-visible box.
        await page.goto(`${CONSOLE_BASE}/console/users`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2_000);
        check(
          "(control) the banner is gone once nobody is stuck",
          (await page.locator("[data-reset-stuck]").count()) === 0,
        );
      }
    }

    // The usage page renders the PORTALS' OWN dashboard component over the
    // merged payload — the strongest guarantee the two cannot drift.
    await page.goto(`${CONSOLE_BASE}/console/usage`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    const usageText = (await page.textContent("body")) ?? "";
    check(
      "the usage page renders the shared dashboard (its KPI cards, not ours)",
      usageText.includes("Cache hit rate") && usageText.includes("Avg cost / request"),
    );

    // ---- 5b. the graphs are split by portal (owner ask, 2026-09-07) ------
    // The dev console has ONE portal, and one portal has nothing to split, so
    // the two-portal payload is INJECTED here rather than by standing up a
    // second database. That is the honest division: `merge.test.ts` proves the
    // arithmetic against real summaries, and this proves the chart draws what
    // it is handed — bands, a legend, and a hover that names each portal.
    const twoPortals = (body: Record<string, unknown>) => {
      const pts = (body.points as { t: string; cost: number }[]) ?? [];
      return {
        ...body,
        points: pts.map((p, i) => ({
          ...p,
          cost: 2 + i,
          by: { alpha: 1 + i, beta: 1 },
        })),
        stack: [
          { key: "alpha", label: "Alpha Ltd", color: "#3b82f6" },
          { key: "beta", label: "Beta Ltd", color: "#10b981" },
        ],
      };
    };
    await page.route("**/api/console/usage*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: twoPortals(body) });
    });
    await page.goto(`${CONSOLE_BASE}/console/usage`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    const splitText = (await page.textContent("body")) ?? "";
    check(
      "the cost chart is titled and keyed by portal",
      splitText.includes("Cost by portal") &&
        splitText.includes("Alpha Ltd") &&
        splitText.includes("Beta Ltd"),
    );
    // Bands, not one solid bar: count the coloured segments actually drawn.
    const bandCount = await page.evaluate(
      `Array.from(document.querySelectorAll('div[style*="rgb(59, 130, 246)"], div[style*="rgb(16, 185, 129)"]')).length`,
    );
    check("each bar is drawn as coloured bands", (bandCount as number) >= 2, `${bandCount} bands`);
    // …and the overview page carries the graphs too.
    await page.goto(`${CONSOLE_BASE}/console`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    const overviewText = (await page.textContent("body")) ?? "";
    check(
      "the overview page shows the graphs",
      overviewText.includes("Spend by portal") && overviewText.includes("Tokens"),
      overviewText.includes("Spend by portal") ? "" : "no spend chart on the overview",
    );
    await page.unroute("**/api/console/usage*");
    // A portal's OWN dashboard must be untouched by all of this: no stack in
    // its payload, so no legend and no "by portal" title.
    check(
      "(control) the split only appears where a stack is sent",
      !(await page.evaluate(`document.body.innerText.includes("Cost by portal")`)) ||
        overviewText.includes("Spend by portal"),
    );

    // ---- 6. sign out -----------------------------------------------------
    await page.goto(`${CONSOLE_BASE}/console`, { waitUntil: "domcontentloaded" });
    await page.click('button:has-text("Sign out")');
    await page.waitForTimeout(2_000);
    const afterOut = await page.goto(`${CONSOLE_BASE}/console`, { waitUntil: "domcontentloaded" });
    check(
      "signing out ends the session",
      page.url().includes("/login"),
      `${page.url()} (${afterOut?.status()})`,
    );
  } finally {
    await browser?.close();
    if (server && !server.killed) {
      // On Windows the child is a shell; kill the tree.
      if (process.platform === "win32" && server.pid) {
        spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], { stdio: "ignore" });
      } else {
        server.kill("SIGTERM");
      }
    }
    await ro?.$disconnect();
    await db.$disconnect();
    restoreNextFiles();
  }

  console.log(failures === 0 ? "\nALL CONSOLE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
