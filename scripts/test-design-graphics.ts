/**
 * Live harness — design work is BUILT, not generated (owner ask, 2026-09-02).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-design-graphics.ts
 *
 * Recreates the owner's exact chat ("Build me 4 Facebook advert PNGs for a
 * coffee shop, make it up.") against a real model with the image tools
 * AVAILABLE, and proves:
 *   1. the assistant ASKS (built vs quick concept) instead of reaching for
 *      image generation
 *   2. choosing "build" hands the job to the Sandbox, which uses the
 *      design-graphics skill's renderer (html2png) — the skill reached the agent
 *   3. four PNGs come back inline, each at a size from the skill's table,
 *      with their HTML sources kept in the workspace
 *   4. NO image-generation call was made
 *   5. installs/downloads the agent runs are tallied and show on Admin → Tools
 *      marked against the image's manifest
 * Runs on the Sandbox's configured credential (subscription = $0) with the
 * stored Anthropic key as fallback; the second turn is a tiny job.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolDir, deleteChatPool } from "../src/lib/storage";
import { destroyAgentContainer } from "../src/lib/agent/spawn";

try {
  process.loadEnvFile(".env");
} catch {
  /* env already present */
}

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "design-graphics-1!";
const SETTING_KEY = "capability_sandbox_agent";
const PROMPT = "Build me 4 Facebook advert PNGs for a coffee shop, make it up.";
// Sizes the skill's table allows for Facebook work (w×h).
const ALLOWED = new Set(["1080x1080", "1080x1350", "1200x628", "1080x1920", "1640x624", "820x312", "2160x2160", "2160x2700", "2400x1256"]);

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
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
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

const TURN_DONE = `(() => {
  const bubbles = document.querySelectorAll("[data-role='assistant']");
  if (bubbles.length < __N__) return false;
  const last = bubbles[bubbles.length - 1];
  const live = document.querySelector('[data-run-phase="code"], [data-run-phase="exec"]');
  return !live && !!last.querySelector("[aria-label='Retry']");
})()`;

async function waitTurn(page: Page, n: number, timeout: number) {
  await page.waitForFunction(TURN_DONE.replace("__N__", String(n)), undefined, { timeout });
}

async function main() {
  const anthropic = await db.providerCredential.findFirst({ where: { provider: "anthropic_api" }, orderBy: { createdAt: "asc" } });
  if (!anthropic) {
    console.error("No stored Anthropic credential.");
    process.exit(1);
  }
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  const priorCfg = ((prior?.value as { config?: Record<string, unknown> } | null)?.config ?? {}) as Record<string, unknown>;
  await db.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value: {} }, update: {} });
  await db.setting.update({
    where: { key: SETTING_KEY },
    data: {
      value: {
        enabled: true,
        config: {
          credential: priorCfg.credential ?? "subscription",
          credentialId: anthropic.id,
          model: "claude-sonnet-5",
          effort: "medium",
          maxTurns: 60,
          maxMinutes: 12,
          maxBudgetUsd: 3,
          steering: "",
        },
      },
    },
  });
  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `design-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });
  const admin = await db.user.create({
    data: { email: `design-admin-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date(), lastSeenVersion: "9.9.9" },
  });

  const browser = await chromium.launch();
  let convId: string | null = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addCookies(await signIn(user.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    // --- 1. the question ------------------------------------------------------
    const t0 = Date.now();
    await page.locator("textarea").fill(PROMPT);
    await page.locator("textarea").press("Enter");
    let asked = true;
    try {
      await page.locator("[data-ask-card]").waitFor({ state: "visible", timeout: 150_000 });
    } catch {
      asked = false;
    }
    check("the assistant ASKS built-vs-quick instead of generating", asked, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (asked) {
      const card = page.locator("[data-ask-card]").first();
      const options = await card.locator("[data-ask-option]").allInnerTexts();
      const build = options.findIndex((o) => /build|proper|editable|html/i.test(o));
      const quick = options.findIndex((o) => /quick|concept|generat|fast/i.test(o));
      check("both routes are offered", build >= 0 && quick >= 0, options.join(" | "));
      check("the build route is marked recommended", /recommend/i.test(options[build] ?? ""), options[build] ?? "");
      await card.locator("[data-ask-option]").nth(Math.max(build, 0)).click();
    }

    // --- 2/3. the build -------------------------------------------------------
    await waitTurn(page, 1, 14 * 60_000);
    console.log(`  (turn took ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    const convo = await db.conversation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    convId = convo?.id ?? null;
    const reply = convId ? await db.message.findFirst({ where: { conversationId: convId, role: "assistant" }, orderBy: { createdAt: "desc" } }) : null;
    const meta = (reply?.meta ?? {}) as { activity?: { label?: string }[]; toolRuns?: { command?: string; code?: string; name?: string }[]; images?: { operation?: string }[] };
    const labels = (meta.activity ?? []).map((a) => a.label ?? "").filter(Boolean);
    check("the job went to the Sandbox", labels.some((l) => /Working in the Sandbox/i.test(l)), labels.slice(0, 4).join(" | "));
    const runs = meta.toolRuns ?? [];
    const usedRenderer = runs.some((r) => /html2png|html2pdf/.test(`${r.command ?? ""} ${r.code ?? ""}`));
    const loadedSkill = labels.some((l) => /skill/i.test(l) && /design/i.test(l));
    check("the agent used the skill's renderer (html2png) — the skill reached it", usedRenderer || loadedSkill, `renderer=${usedRenderer} skillLine=${loadedSkill}`);

    const pool = convId ? chatPoolDir(convId) : "";
    const files = pool && existsSync(pool) ? readdirSync(pool) : [];
    const htmls = files.filter((f) => /\.html?$/i.test(f));
    const pngs = files.filter((f) => /\.png$/i.test(f));
    check("HTML sources kept in the workspace (editable)", htmls.length >= 4, htmls.join(", "));
    check("at least four PNGs produced", pngs.length >= 4, pngs.join(", "));
    const sizes: string[] = [];
    for (const f of pngs.slice(0, 8)) {
      const m = await sharp(join(pool, f)).metadata();
      sizes.push(`${f}=${m.width}x${m.height}`);
    }
    const allAllowed = pngs.length > 0 && sizes.every((s) => ALLOWED.has(s.split("=")[1]));
    check("every PNG is an exact size from the skill's table", allAllowed, sizes.join(" "));

    const presented = (meta.images ?? []).filter((i) => i.operation === "present").length;
    const inline = await page.locator("[data-role='assistant'] img").count();
    check("four+ PNGs presented inline", presented >= 4 && inline >= 4, `presented=${presented} inline=${inline}`);

    // --- 4. no image generation -------------------------------------------------
    const imageRows = await db.usageRecord.count({ where: { userId: user.id, role: "image" } });
    const generated = (meta.images ?? []).filter((i) => i.operation === "generate").length;
    check("NO image-generation call was made", imageRows === 0 && generated === 0, `imageUsageRows=${imageRows} generated=${generated}`);

    // --- 5. tally + admin panel ---------------------------------------------------
    const t1 = Date.now();
    await page.locator("textarea").fill("Separate small job for the Sandbox: install the Python package cowsay with pip and use it to print the word hello; then download https://example.com with curl into example.html and tell me the page title. Show me both outputs.");
    await page.locator("textarea").press("Enter");
    await waitTurn(page, 2, 6 * 60_000);
    console.log(`  (tally turn took ${((Date.now() - t1) / 1000).toFixed(0)}s)`);
    const uses = convId ? await db.agentPackageUse.findMany({ where: { conversationId: convId } }) : [];
    const tags = uses.map((u) => `${u.kind}:${u.name}`);
    if (!tags.includes("pip:cowsay")) {
      const last = convId ? await db.message.findFirst({ where: { conversationId: convId, role: "assistant" }, orderBy: { createdAt: "desc" } }) : null;
      console.log("  (tally turn reply: " + (last?.content ?? "").slice(0, 400).replace(/\s+/g, " ") + ")");
    }
    check("pip install tallied", tags.includes("pip:cowsay"), tags.join(" | "));
    check("external download tallied by host", tags.includes("download:example.com"), tags.join(" | "));

    const actx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    await actx.addCookies(await signIn(admin.email));
    const apage = await actx.newPage();
    await apage.goto(`${BASE}/admin/tools`, { waitUntil: "domcontentloaded" });
    const row = apage.locator('[data-package-row="pip:cowsay"]');
    await row.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    const rowText = (await row.count()) ? await row.innerText() : "";
    check("Admin → Tools lists the package", /cowsay/.test(rowText), rowText);
    check("…marked against the image manifest (cowsay is not baked in)", /not in image/i.test(rowText), rowText);
    const manifestLine = await apage.locator("text=/ships \\d+ Python and \\d+ Node/").count();
    check("the image manifest was read through the broker", manifestLine > 0);
    await actx.close();
  } finally {
    await browser.close();
    if (prior) await db.setting.update({ where: { key: SETTING_KEY }, data: { value: prior.value as object } });
    else await db.setting.deleteMany({ where: { key: SETTING_KEY } });
    if (convId) {
      destroyAgentContainer(convId);
      await deleteChatPool(convId).catch(() => {});
      await db.agentPackageUse.deleteMany({ where: { conversationId: convId } }).catch(() => {});
    }
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: admin.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
