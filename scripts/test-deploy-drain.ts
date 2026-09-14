/**
 * Live test of the graceful deploy drain (owner ask): before an update
 * replaces the container, the instance stops taking new work and lets the
 * replies already running finish.
 *
 *   1. The drain endpoint refuses an unauthenticated caller.
 *   2. A valid token reports the current state.
 *   3. Draining refuses NEW chat turns with 503 + maintenance (not a 500).
 *   4. Draining refuses uploads the same way.
 *   5. A reply already in flight is NOT killed — it finishes and is saved.
 *   6. `activeTurns` reflects that reply, so deploy.sh knows to wait.
 *   7. Cancelling the drain lets traffic straight back in.
 *   8. In the browser: the composer shows a calm "updating" notice, keeps the
 *      typed message instead of losing it, and leaves no empty reply bubble.
 *
 * Requires OPNINFER_DEPLOY_TOKEN in the server's environment (deploy.sh
 * generates one per instance; add it to .env for local runs). Costs one small
 * model call. Always cancels the drain on the way out.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-deploy-drain.ts
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.OPNINFER_DEPLOY_TOKEN ?? "";
const PASSWORD = "drain-user-1!";
const STAMP = Date.now();
const DRAIN_URL = `${BASE}/api/admin/drain`;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

interface DrainStatus {
  draining: boolean;
  activeTurns: number;
}

const drain = (method: "GET" | "POST" | "DELETE") =>
  fetch(DRAIN_URL, { method, headers: { Authorization: `Bearer ${TOKEN}` } });

async function drainStatus(): Promise<DrainStatus> {
  return (await (await drain("GET")).json()) as DrainStatus;
}

async function main() {
  if (!TOKEN) {
    console.error("OPNINFER_DEPLOY_TOKEN is not set — the drain endpoint is disabled.");
    process.exit(1);
  }

  const user = await db.user.create({
    data: {
      email: `drain-${STAMP}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  const convo = await db.conversation.create({
    data: { userId: user.id, title: "drain fixture" },
  });
  const slowConvo = await db.conversation.create({
    data: { userId: user.id, title: "drain in-flight fixture" },
  });

  try {
    // --- sign in ------------------------------------------------------------
    const jar = new Map<string, string>();
    const store = (cs: string[]) => {
      for (const c of cs) {
        const p = c.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    // --- 1/2: the endpoint --------------------------------------------------
    const noAuth = await fetch(DRAIN_URL, { method: "GET" });
    check("an unauthenticated caller is refused", noAuth.status === 401, `status ${noAuth.status}`);

    const before = await drainStatus();
    check("a valid token reports the state", before.draining === false, JSON.stringify(before));

    // --- 5/6: a reply already in flight survives the drain -------------------
    // Start a turn, drain WHILE it runs, and require it to finish anyway.
    const inFlight = fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: slowConvo.id,
        content: "Count slowly from 1 to 20, one number per line.",
      }),
    });
    // Wait until the turn has actually REGISTERED before draining. A fixed
    // sleep raced the dev server's first-request compile and reported zero
    // in-flight turns — which is precisely the number deploy.sh waits on, so
    // a false zero here would mean live replies get killed by every update.
    let seenActive = 0;
    for (let i = 0; i < 60; i++) {
      seenActive = (await drainStatus()).activeTurns;
      if (seenActive >= 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check(
      "a running reply is visible as an active turn",
      seenActive >= 1,
      `activeTurns ${seenActive}`,
    );

    const started = (await (await drain("POST")).json()) as DrainStatus;
    check("draining starts", started.draining === true);
    check(
      "the in-flight reply is still counted once draining, so a deploy waits",
      started.activeTurns >= 1,
      `activeTurns ${started.activeTurns}`,
    );

    // --- 3/4: new work is refused while draining ----------------------------
    const refused = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id, content: "hello?" }),
    });
    const refusedBody = (await refused.json()) as { error?: string; maintenance?: boolean };
    check(
      "a NEW turn is refused with 503 + maintenance",
      refused.status === 503 && refusedBody.maintenance === true,
      `status ${refused.status} · ${refusedBody.error ?? ""}`,
    );

    const form = new FormData();
    form.append("file", new File(["drain test"], "drain.txt", { type: "text/plain" }));
    const upload = await fetch(`${BASE}/api/files?conversationId=${convo.id}`, {
      method: "POST",
      headers: { cookie: cookie() },
      body: form,
    });
    const uploadBody = (await upload.json()) as { maintenance?: boolean };
    check(
      "an upload is refused the same way",
      upload.status === 503 && uploadBody.maintenance === true,
      `status ${upload.status}`,
    );

    // The turn that was already running must still deliver.
    const res = await inFlight;
    let full = "";
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += dec.decode(value, { stream: true });
      }
    }
    const text = [...full.matchAll(/^data: (.+)$/gm)]
      .map((m) => {
        try {
          return JSON.parse(m[1]) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string)
      .join("");
    check("the reply already in flight finished normally", text.trim().length > 0, text.slice(0, 80));

    const saved = await db.message.count({
      where: { conversationId: slowConvo.id, role: "assistant" },
    });
    check("…and was persisted", saved === 1, `${saved} assistant message(s)`);

    // --- 8: the browser notice ----------------------------------------------
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
      await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
      const box = page.locator("textarea").first();
      await box.waitFor({ state: "visible", timeout: 20_000 });

      const typed = `will this send during a deploy? ${STAMP}`;
      // Re-type until React has hydrated (a pre-hydration fill never reaches
      // component state — the same race the admin forms hit).
      for (let i = 0; i < 20; i++) {
        await box.fill(typed);
        if ((await box.inputValue()) === typed) {
          await page.waitForTimeout(250);
          if ((await box.inputValue()) === typed) break;
        }
        await page.waitForTimeout(250);
      }
      await box.press("Enter");

      const notice = page.locator("[data-maintenance]");
      await notice.waitFor({ state: "visible", timeout: 20_000 });
      const noticeText = (await notice.textContent()) ?? "";
      check(
        "the composer shows a calm 'updating' notice",
        /updating/i.test(noticeText) && !/error|failed/i.test(noticeText),
        noticeText,
      );
      check(
        "the typed message is given back, not lost",
        (await box.inputValue()).includes(String(STAMP)),
        await box.inputValue(),
      );
      const bubbles = await page.locator("[data-role='assistant']").count();
      check("no empty reply bubble is left behind", bubbles === 0, `${bubbles} assistant bubble(s)`);
    } finally {
      await browser.close();
    }

    // --- 7: back to normal ---------------------------------------------------
    const ended = (await (await drain("DELETE")).json()) as DrainStatus;
    check("cancelling the drain clears it", ended.draining === false);

    const after = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convo.id, content: "Reply with just: ok" }),
    });
    check("traffic is accepted again", after.status === 200, `status ${after.status}`);
    await after.body?.cancel();
  } finally {
    // Never leave the instance refusing traffic because a test failed.
    await drain("DELETE").catch(() => {});
    const final = await drainStatus().catch(() => null);
    check("the instance is accepting traffic on the way out", final?.draining === false);
    await db.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL DEPLOY-DRAIN CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await fetch(DRAIN_URL, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
