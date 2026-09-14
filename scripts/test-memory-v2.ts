/**
 * Memory v2 (0.5.1 — docs/V051_MEMORY.md), live, against a real model:
 *
 *   A. A chat where the person states their job, how they like replies, a
 *      dated decision — and a health remark, with no "remember" anywhere.
 *      The idle-chat pass (run directly, as the scheduler would after 30
 *      quiet minutes) fills the right notes and keeps the health remark out;
 *      running it again finds nothing new; the pass's usage is recorded.
 *   B. A NEW chat recalls the job and the preference unprompted.
 *   C. "I've moved to sales — remember that" rewrites the note: sales in,
 *      marketing out (a contradiction REPLACES, never accumulates).
 *   D. "Forget my job" clears it.
 *   E. "When did we decide…" is answered from the EARLIER chat through the
 *      search-my-chats tool, citing it.
 *   F. Incognito and shared chats are never read by the pass.
 *   G. Pause: the remember tool is withheld and the pass skips the person.
 *   H. Settings: the notes are shown, editable, and "Forget everything" works
 *      — in a real browser.
 *   I. Admin: chat search off → the tool is not offered.
 *
 *   TEST_BASE_URL=http://localhost:3000 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-memory-v2.ts
 */
import { chromium, type Page } from "@playwright/test";
import { statSync, readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { runMemoryPassForConversation } from "../src/lib/memory-pass";
import { loadTopics } from "../src/lib/tools/memory";
import { getSetting, setSetting } from "../src/lib/settings";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "memory-v2-1!";
const STAMP = Date.now();
const DEV_LOG = "logs/dev.log";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

async function signIn(browser: Awaited<ReturnType<typeof chromium.launch>>, email: string) {
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
  return ctx;
}

async function sendAndWait(page: Page, text: string, needle: RegExp, timeout = 120_000): Promise<string> {
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
  const t0 = Date.now();
  let seen = "";
  let stableFor = 0;
  for (;;) {
    const texts = await page.locator("[data-role=assistant]").allInnerTexts();
    const last = texts[texts.length - 1] ?? "";
    const shimmer = await page.locator("[data-role=assistant] .oi-shimmer").count();
    // The paced reveal keeps adding words after the stream has ended, so a
    // match is only trusted once the text has stopped growing for a second.
    if (needle.test(last) && !shimmer) {
      stableFor = last === seen ? stableFor + 400 : 0;
      if (stableFor >= 1000) return last;
    }
    seen = last;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${needle} — last: ${last.slice(0, 200)}`);
    await page.waitForTimeout(400);
  }
}

async function newChat(page: Page): Promise<void> {
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 30_000 });
}

async function convIdFromUrl(page: Page): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const m = /\/chat\/([0-9a-f-]{36})$/.exec(page.url());
    if (m) return m[1];
    await page.waitForTimeout(200);
  }
  throw new Error("no conversation id in the URL");
}

/** The tool list the model was offered on the LAST llm call since `offset`. */
function lastOfferedTools(offset: number): string[] {
  const buf = readFileSync(DEV_LOG);
  const tail = buf.subarray(offset).toString("utf8");
  // The conversation-role call is the one with a tool list; the title call
  // that follows it logs `"tools":[]` and must not be mistaken for it.
  const lines = tail.split("\n").filter((l) => l.includes("[llm] →") && l.includes('"tools":["'));
  const last = lines[lines.length - 1] ?? "";
  const m = /"tools":\[([^\]]*)\]/.exec(last);
  return m ? m[1].split(",").map((s) => s.replace(/"/g, "").trim()).filter(Boolean) : [];
}

/** Finished replies fold their working steps away; open them so status lines
 *  can be read (the harness gotcha from the folded-steps change). */
async function expandFoldedSteps(page: Page): Promise<void> {
  const folds = page.locator("[data-activity-collapsed]");
  const n = await folds.count();
  for (let i = 0; i < n; i++) await folds.nth(i).click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
}

async function topicsOf(userId: string) {
  const t = await loadTopics(userId);
  return Object.fromEntries(t.map((x) => [x.key, x.text])) as Record<string, string>;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `memory-v2-${STAMP}@example.test`,
      name: "Morgan Memory",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });
  const helper = await db.user.create({
    data: {
      email: `memory-v2-helper-${STAMP}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });
  const memCfgBefore = await getSetting<unknown>("memory_config");
  const browser = await chromium.launch();
  try {
    const ctx = await signIn(browser, user.email);
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.accept());

    // ── A. The idle-chat pass ──────────────────────────────────────────
    await newChat(page);
    await sendAndWait(
      page,
      "I'm drafting a one-line bio for our team page and need a hand in a moment. For context: I'm the marketing lead at Acme Widgets, and I prefer short answers in bullet points. " +
        "We decided today that the pricing page relaunch goes live on 14 October. Separately, I've got hay fever this week so I'm a bit slow. For now just reply with the word OK.",
      /OK/i,
    );
    const chat1 = await convIdFromUrl(page);
    const before = await topicsOf(user.id);
    const preFilled = Object.values(before).some((t) => t.trim());
    // A model may read "for context: I'm…" as a request to remember; either
    // way the notes must be right once the chat has been quiet.
    check(
      preFilled
        ? "A. (the model saved on its own — read the intro as an ask; the pass runs anyway)"
        : "A. nothing is remembered until the chat has been quiet",
      true,
      preFilled ? JSON.stringify(before) : "",
    );

    const pass1 = await runMemoryPassForConversation(chat1);
    const t1 = await topicsOf(user.id);
    check("A. the pass ran and the notes are filled", (pass1.changed.length > 0 || preFilled) && Object.values(t1).some((t) => t.trim()), JSON.stringify(pass1));
    check("A. About you: marketing lead at Acme", /marketing/i.test(t1.about) && /acme/i.test(t1.about), t1.about);
    check("A. How you like replies: bullets, short", /bullet/i.test(t1.replies), t1.replies);
    check("A. Your work: the dated decision", /14 Oct|2026-10-14|October 14|14\/10/i.test(t1.work) && /pricing/i.test(t1.work), t1.work);
    check("A. the health remark was NOT kept", !/hay ?fever/i.test(Object.values(t1).join(" ")));
    const stamped = await db.conversation.findUnique({ where: { id: chat1 }, select: { memoryPassAt: true } });
    check("A. the chat is stamped as read", !!stamped?.memoryPassAt);
    const pass1b = await runMemoryPassForConversation(chat1);
    check("A. running it again finds nothing new to read", pass1b.skipped === "nothing-said", JSON.stringify(pass1b));
    const usage = await db.usageRecord.count({ where: { userId: user.id, role: "memory" } });
    check("A. the pass's usage is recorded under its own role", usage >= 1, String(usage));

    // ── B. A new chat recalls it ───────────────────────────────────────
    await newChat(page);
    const recall = await sendAndWait(page, "In one short line: what's my job, and how do I like my answers?", /marketing|acme/i);
    check("B. a new chat knows the job unprompted", /marketing/i.test(recall), recall.slice(0, 160));
    check("B. …and the preference", /bullet/i.test(recall), recall.slice(0, 160));
    const chat2 = await convIdFromUrl(page);

    // ── C. A contradiction REPLACES ────────────────────────────────────
    await sendAndWait(page, "Actually I've just moved to the sales team, not marketing any more — please remember that.", /sales|remember|noted|updated/i);
    const t3 = await topicsOf(user.id);
    check("C. About you now says sales", /sales/i.test(t3.about), t3.about);
    // Rewritten, not appended: no line still claims the OLD job as current
    // (a "moved from marketing" aside within the sales line is fine).
    const staleLine = t3.about.split("\n").some((l) => /marketing lead/i.test(l) && !/sales/i.test(l));
    check("C. …and no line still says marketing lead (replaced, not appended)", !staleLine, t3.about);
    await expandFoldedSteps(page);
    const statusLines = await page.locator('[data-activity="status"]').allInnerTexts();
    check("C. the remember tool showed as a status line", statusLines.some((s) => /remember|updating/i.test(s)), statusLines.join(" | "));

    // ── D. Forget ──────────────────────────────────────────────────────
    await sendAndWait(page, "Forget my job entirely, please.", /forgot|forget|removed|done|cleared|no longer/i);
    const t4 = await topicsOf(user.id);
    check("D. the job is gone from About you", !/sales|marketing/i.test(t4.about), t4.about);

    // ── E. Search my past chats ────────────────────────────────────────
    // The ailment is NEVER kept in the notes (sensitive), so the only way to
    // answer is to search the earlier chat — which also proves the exclusion
    // doesn't hide the chat itself. The question shares words with what was
    // written ("slow", "week"): keyword search finds words, not meanings.
    await newChat(page);
    const found = await sendAndWait(page, "In an earlier chat today I mentioned something was making me a bit slow this week — what was it? Please search my past chats.", /hay ?fever|couldn't find|no earlier|didn't find|don't see/i, 150_000);
    check("E. answered from the earlier chat", /hay ?fever/i.test(found), found.slice(0, 200));
    await expandFoldedSteps(page);
    const eStatus = await page.locator('[data-activity="status"]').allInnerTexts();
    check("E. the search-my-chats tool ran", eStatus.some((s) => /past chats/i.test(s)), eStatus.join(" | "));
    // Cited by title (always) — the markdown link is asked for but a model may
    // still cite by name alone, which is the behaviour that matters.
    const chat1Title = (await db.conversation.findUnique({ where: { id: chat1 }, select: { title: true } }))?.title ?? "";
    const html = await page.locator("[data-role=assistant]").last().innerHTML();
    check("E. …and the reply cites the chat (by title, or with a link)", /\/chat\/[0-9a-f-]{36}/.test(html) || (chat1Title.length > 0 && found.includes(chat1Title.replace(/^\S+\s/, ""))), `${chat1Title} | ${found.slice(0, 120)}`);

    // ── F. Never incognito, never shared ───────────────────────────────
    const incog = await db.conversation.create({
      data: { userId: user.id, title: "secret", incognito: true, messages: { create: [{ role: "user", content: "My cat is called Biscuit and I live in Leeds.", userId: user.id }] } },
    });
    const sharedChat = await db.conversation.create({
      data: {
        userId: user.id,
        title: "shared",
        messages: { create: [{ role: "user", content: "My cat is called Biscuit and I live in Leeds.", userId: user.id }] },
        members: { create: [{ userId: user.id }, { userId: helper.id }] },
      },
    });
    const fi = await runMemoryPassForConversation(incog.id);
    const fs = await runMemoryPassForConversation(sharedChat.id);
    check("F. an incognito chat is skipped by the pass", fi.skipped === "private-scope", JSON.stringify(fi));
    check("F. a shared chat is skipped by the pass", fs.skipped === "private-scope", JSON.stringify(fs));
    check("F. nothing from them leaked", !/biscuit|leeds/i.test(Object.values(await topicsOf(user.id)).join(" ")));

    // ── G. Pause ───────────────────────────────────────────────────────
    const paused = await ctx.request.patch(`${BASE}/api/memory`, { data: { paused: true } });
    check("G. pause switch saved", paused.status() === 200 && ((await paused.json()) as { paused: boolean }).paused === true);
    await newChat(page);
    const logOffset = statSync(DEV_LOG).size;
    const pausedReply = await sendAndWait(page, "Remember that my favourite colour is green.", /paus|can't|cannot|unable|not able|memory/i);
    check("G. the remember tool is withheld while paused", !lastOfferedTools(logOffset).includes("memory_update"), lastOfferedTools(logOffset).filter((t) => t.startsWith("memory")).join(","));
    check("G. …and the assistant says memory is paused", /paus/i.test(pausedReply), pausedReply.slice(0, 160));
    check("G. …and nothing was saved", !/green/i.test(Object.values(await topicsOf(user.id)).join(" ")));
    const pausedChat = await convIdFromUrl(page);
    const gp = await runMemoryPassForConversation(pausedChat);
    check("G. the pass skips a paused person", gp.skipped === "paused", JSON.stringify(gp));
    await ctx.request.patch(`${BASE}/api/memory`, { data: { paused: false } });

    // ── H. Settings ────────────────────────────────────────────────────
    await page.click('button[aria-label="Account settings"]');
    await page.waitForSelector("[data-memory-section] [data-memory-topic=about] textarea", { timeout: 15_000 });
    const shownWork = await page.locator("[data-memory-topic=work] textarea").inputValue();
    check("H. settings shows the notes", /pricing/i.test(shownWork), shownWork.slice(0, 120));
    await page.fill("[data-memory-topic=about] textarea", "- Prefers to be called Mo");
    await page.$eval("[data-memory-save=about]", (el) => (el as HTMLButtonElement).click());
    const savedAbout = await (async () => {
      for (let i = 0; i < 30; i++) {
        const t = await topicsOf(user.id);
        if (/called Mo/.test(t.about)) return t.about;
        await page.waitForTimeout(250);
      }
      return (await topicsOf(user.id)).about;
    })();
    check("H. an edit in settings is saved", /called Mo/.test(savedAbout), savedAbout);
    check("H. the pause switch is shown unpaused", (await page.getAttribute("[data-memory-paused]", "data-memory-paused")) === "0");
    // Below the modal's fold in a scroll box Playwright can't always reach —
    // click it from inside the page (the confirm dialog is auto-accepted).
    await page.$eval("[data-memory-reset]", (el) => (el as HTMLButtonElement).click());
    const wiped = await (async () => {
      for (let i = 0; i < 30; i++) {
        const t = await topicsOf(user.id);
        if (Object.values(t).every((x) => !x)) return true;
        await page.waitForTimeout(250);
      }
      return false;
    })();
    check("H. Forget everything clears every note", wiped);
    await page.keyboard.press("Escape");

    // ── I. Admin: chat search off ──────────────────────────────────────
    await setSetting("memory_config", { paused: false, topicChars: 1200, chatSearch: false });
    await newChat(page);
    const off = statSync(DEV_LOG).size;
    await sendAndWait(page, "Reply with just the word READY.", /READY/i);
    const offered = lastOfferedTools(off);
    check("I. with chat search off the tool is not offered", offered.length > 0 && !offered.includes("search_my_chats") && offered.includes("memory_update"), offered.join(","));
    await setSetting("memory_config", { paused: false, topicChars: 1200, chatSearch: true });
    await newChat(page);
    const on = statSync(DEV_LOG).size;
    await sendAndWait(page, "Reply with just the word READY.", /READY/i);
    check("I. …and back on, it is", lastOfferedTools(on).includes("search_my_chats"), lastOfferedTools(on).join(","));
  } finally {
    await browser.close();
    if (memCfgBefore === null || memCfgBefore === undefined) {
      await db.setting.deleteMany({ where: { key: "memory_config" } }).catch(() => {});
    } else {
      await setSetting("memory_config", memCfgBefore as Record<string, unknown>).catch(() => {});
    }
    await db.conversation.deleteMany({ where: { userId: { in: [user.id, helper.id] } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [user.id, helper.id] } } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
