/**
 * Live test of the clarifying-question card (`ask_user`) against a REAL model
 * and a real browser, in the shape a user actually meets it: ask something with
 * a genuine fork in it, get the card, pick an option, and watch the SAME reply
 * carry on using the answer.
 *
 * What it proves, in order:
 *   1. the model reaches for the card on an ambiguous request
 *   2. the card renders above the composer, with numbered options and a stepper
 *   3. the reply is genuinely PAUSED (no final answer arrives while it waits)
 *   4. picking an option resumes THAT reply — one assistant row, not two
 *   5. the answer lands as the user's own message (so later turns remember it)
 *      WITHOUT getting a bubble of its own — the card shows it in the position
 *      the question was asked, and a bubble would sort above that card
 *   6. the reply honours the choice and not the alternative
 *   7. the question + chosen answer survive a reload
 *   8. a second turn can still see what was answered
 *   9. Stop releases a waiting card instead of hanging until the timeout
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-ask-user.ts
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "ask-user-1!";

/** Two mutually exclusive outputs the model cannot possibly guess between, each
 *  with a marker word that can only come from having taken that branch. */
const PICK = "Haiku";
const OTHER = "Limerick";
const PROMPT =
  `Write me one short poem about the sea. I have a strong preference about the form ` +
  `— it must be either a ${PICK} or a ${OTHER}, and I have not told you which. ` +
  `Ask me which form I want before writing anything, then write exactly that one. ` +
  `Start your reply with the chosen form's name in square brackets, like [Form].`;

let failures = 0;
/** A finished reply folds its working steps; click the row open (no-op if absent). */
async function expandFoldedSteps(page: Page) {
  const folded = page.locator("[data-role='assistant'] [data-activity-collapsed]");
  if ((await folded.count()) > 0) {
    await folded.last().click();
    await page.waitForTimeout(250);
  }
}
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
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

/** Rows for a conversation, once the trailing reply has been saved. */
async function settledRows(convId: string, minRows: number) {
  let rows: { id: string; role: string; content: string; meta: unknown }[] = [];
  for (let i = 0; i < 40; i++) {
    rows = await db.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, meta: true },
    });
    if (rows.length >= minRows && rows[rows.length - 1].role === "assistant") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return rows;
}

async function waitForCard(page: Page, timeout = 120_000) {
  await page.locator("[data-ask-card]").waitFor({ state: "visible", timeout });
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `ask-user-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
      // The What's new panel (a modal) opens for a brand-new account and
      // blocks pointer clicks on the ask card; mark the notes as seen.
      lastSeenVersion: "9.9.9",
    },
  });
  const browser = await chromium.launch();
  const convIds: string[] = [];

  try {
    const cookies = await signIn(user.email);
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 950 },
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    // ---- 1. the model asks -------------------------------------------------
    await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    const ta = page.locator("textarea");
    await ta.fill(PROMPT);
    await ta.press("Enter");

    await waitForCard(page);
    const card = page.locator("[data-ask-card]").first();
    check("question card appeared", true);

    const questionText = (await card.locator("[data-ask-question]").first().innerText()).trim();
    check("card shows a real question", questionText.length > 5, questionText);

    const options = card.locator("[data-ask-option]");
    const optionCount = await options.count();
    check("card offers at least two options", optionCount >= 2, `${optionCount} options`);

    const labels = await options.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-ask-option") ?? ""),
    );
    check(
      "options cover both forms the user named",
      labels.some((l) => new RegExp(PICK, "i").test(l)) &&
        labels.some((l) => new RegExp(OTHER, "i").test(l)),
      labels.join(" | "),
    );
    check("free-text escape hatch offered", await card.locator("[data-ask-something-else]").isVisible());
    check("skip offered", await card.locator("[data-ask-skip]").isVisible());

    // ---- 2. the card sits above the composer -------------------------------
    const geometry = await page.evaluate(() => {
      const c = document.querySelector("[data-ask-card]")?.getBoundingClientRect();
      const t = document.querySelector("textarea")?.getBoundingClientRect();
      return c && t ? { cardBottom: c.bottom, composerTop: t.top } : null;
    });
    check(
      "card is directly above the composer",
      !!geometry && geometry.cardBottom <= geometry.composerTop + 4,
      geometry ? `card bottom ${Math.round(geometry.cardBottom)} / composer top ${Math.round(geometry.composerTop)}` : "no geometry",
    );
    check(
      'composer invites a direct reply',
      (await page.locator("textarea").getAttribute("placeholder")) === "Or reply directly…",
    );

    // ---- 3. the reply really is paused ------------------------------------
    convIds.push((await page.evaluate(() => location.pathname.split("/chat/")[1] ?? null)) ?? "");
    const convId = convIds[0];
    check("conversation id resolved", !!convId, convId);

    const before = await db.message.count({ where: { conversationId: convId, role: "assistant" } });
    await page.waitForTimeout(6_000);
    const during = await db.message.count({ where: { conversationId: convId, role: "assistant" } });
    check(
      "reply is parked while the card waits (no answer saved)",
      before === 0 && during === 0,
      `assistant rows: ${before} → ${during}`,
    );
    check("card still waiting after that pause", await card.isVisible());

    // ---- 3b. the card survives a reload WHILE waiting ---------------------
    // The turn is detached and its events are replayed on re-attach, so the
    // card has to come back — and still be answerable, since the mailbox entry
    // it resolves is the same one.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForCard(page, 60_000);
    check("card returns after a mid-question reload", true);
    const cardAfter = page.locator("[data-ask-card]").first();
    const labelsAfter = await cardAfter
      .locator("[data-ask-option]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-ask-option") ?? ""));
    check(
      "the same options come back",
      labelsAfter.join("|") === labels.join("|"),
      labelsAfter.join(" | "),
    );

    // ---- 4. answering resumes THAT reply ----------------------------------
    const chosen = labels.find((l) => new RegExp(PICK, "i").test(l))!;
    await cardAfter.locator(`[data-ask-option="${chosen}"]`).click();
    await page.locator("[data-ask-card]").waitFor({ state: "detached", timeout: 30_000 });
    check("card retired once answered", true);

    const rows = await settledRows(convId, 3);
    const roles = rows.map((r) => r.role).join(",");
    check("transcript is prompt → answer → ONE reply", roles === "user,user,assistant", roles);
    check(
      "the answer is the user's own message",
      new RegExp(PICK, "i").test(rows[1]?.content ?? ""),
      rows[1]?.content,
    );
    check(
      "the answer row is flagged as card-rendered",
      (rows[1]?.meta as { askAnswer?: boolean } | null)?.askAnswer === true,
      JSON.stringify(rows[1]?.meta),
    );
    // The row is needed (later turns replay only user/assistant rows) but must
    // not be drawn: it is written mid-turn while the reply is saved at the end,
    // so its bubble would land ABOVE the question card that asked for it.
    check(
      "the answer gets no bubble of its own (only the original prompt)",
      (await page.locator('[data-role="user"]').count()) === 1,
      `${await page.locator('[data-role="user"]').count()} user bubbles vs ${rows.filter((r) => r.role === "user").length} user rows`,
    );

    const reply = rows[rows.length - 1]?.content ?? "";
    check("reply was produced", reply.length > 20, `${reply.length} chars`);
    // The prompt asks for the form in square brackets precisely so this is a
    // fact about which BRANCH ran, not a guess from the poem's shape — an
    // earlier version keyword-sniffed the reply and failed on a perfectly
    // correct haiku that simply never used the word.
    check(
      "reply honours the chosen form, not the alternative",
      new RegExp(`\\[\\s*${PICK}`, "i").test(reply) && !new RegExp(`\\[\\s*${OTHER}`, "i").test(reply),
      reply.slice(0, 160),
    );

    // ---- 5. the exchange is persisted -------------------------------------
    const meta = rows[rows.length - 1]?.meta as {
      asks?: { id: string; status: string; questions: unknown[]; answers?: { chosen: string[] }[] }[];
      activity?: { kind: string; id?: string }[];
    } | null;
    check("question persisted in meta.asks", (meta?.asks?.length ?? 0) === 1, JSON.stringify(meta?.asks?.[0]?.status));
    check("persisted ask is marked answered", meta?.asks?.[0]?.status === "answered");
    check(
      "persisted ask carries the chosen answer",
      new RegExp(PICK, "i").test(meta?.asks?.[0]?.answers?.[0]?.chosen?.join(",") ?? ""),
      meta?.asks?.[0]?.answers?.[0]?.chosen?.join(","),
    );
    check(
      "ask is positioned in the activity log",
      meta?.activity?.some((a) => a.kind === "ask" && a.id === meta?.asks?.[0]?.id) === true,
      JSON.stringify(meta?.activity),
    );

    // ---- 6. it survives a reload ------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    // Since 2026-09-02 a finished reply FOLDS its working steps (the question
    // record among them) into one row — expand it before looking.
    await expandFoldedSteps(page);
    const record = page.locator("[data-activity='ask']").first();
    await record.waitFor({ state: "visible", timeout: 20_000 });
    const recordText = await record.innerText();
    check("reload shows the question that was asked", /\?/.test(recordText), recordText);
    check("reload shows the answer that was given", new RegExp(PICK, "i").test(recordText), recordText);
    check("no live card after reload", (await page.locator("[data-ask-card]").count()) === 0);
    check(
      "still no separate answer bubble after reload",
      (await page.locator('[data-role="user"]').count()) === 1,
      `${await page.locator('[data-role="user"]').count()} user bubbles`,
    );

    // ---- 7. a later turn remembers the answer -----------------------------
    // The whole reason the answer is a real user row: only user/assistant rows
    // are replayed, so without it the model would have forgotten by now.
    await page.locator("textarea").fill("In one word, which poem form did I ask you for earlier?");
    await page.locator("textarea").press("Enter");
    const later = await settledRows(convId, 5);
    const lastReply = later[later.length - 1]?.content ?? "";
    check(
      "a later turn still knows the answer",
      new RegExp(PICK, "i").test(lastReply),
      lastReply.slice(0, 120),
    );

    // ---- 8. several questions in a row (the "1 of 3" stepper) -------------
    const pageM = await ctx.newPage();
    pageM.on("pageerror", (e) => errors.push(String(e)));
    pageM.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await pageM.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await pageM.locator("textarea").fill(
      "Book me a fictional meeting room for a team workshop. I have firm preferences you " +
        "cannot guess on THREE separate things: which day of the week, how long the session " +
        "runs, and what refreshments to lay on. Ask me about all three up front in one go, " +
        "then confirm the booking back to me in a short list.",
    );
    await pageM.locator("textarea").press("Enter");
    await waitForCard(pageM);
    const convM = (await pageM.evaluate(() => location.pathname.split("/chat/")[1] ?? null)) ?? "";
    convIds.push(convM);

    const cardM = pageM.locator("[data-ask-card]").first();
    const progress = cardM.locator("[data-ask-progress]");
    const hasStepper = await progress.isVisible().catch(() => false);
    const firstProgress = hasStepper ? (await progress.innerText()).trim() : "";
    check("stepper shown for a multi-question ask", hasStepper, firstProgress);
    check("stepper starts at question 1", /^1 of [2-4]$/.test(firstProgress), firstProgress);

    const totalAsked = Number(firstProgress.split(" of ")[1] ?? 0);
    // Answer the first by picking, the second by typing (the "Something else"
    // path), and the rest by picking — then the set submits on the last one.
    for (let i = 0; i < totalAsked; i++) {
      const expected = `${i + 1} of ${totalAsked}`;
      const shown = (await progress.innerText()).trim();
      if (i > 0) {
        check(`stepper advanced to ${expected}`, shown === expected, shown);
      }
      if (i === 1) {
        await cardM.locator("[data-ask-something-else]").click();
        await cardM.locator("[data-ask-custom]").fill("Ninety minutes exactly");
        await cardM.locator("[data-ask-custom]").press("Enter");
      } else {
        await cardM.locator("[data-ask-option]").first().click();
      }
      if (i < totalAsked - 1) {
        await pageM.waitForFunction(
          (want) =>
            document.querySelector("[data-ask-progress]")?.textContent?.trim() === want,
          `${i + 2} of ${totalAsked}`,
          { timeout: 10_000 },
        );
      }
    }

    await pageM.locator("[data-ask-card]").waitFor({ state: "detached", timeout: 30_000 });
    check("card retired after the last question", true);

    const rowsM = await settledRows(convM, 3);
    check(
      "multi-question transcript is prompt → one answer message → ONE reply",
      rowsM.map((r) => r.role).join(",") === "user,user,assistant",
      rowsM.map((r) => r.role).join(","),
    );
    check(
      "the single answer message carries every answer, labelled",
      (rowsM[1]?.content.match(/:/g) ?? []).length >= totalAsked - 1 &&
        /Ninety minutes exactly/i.test(rowsM[1]?.content ?? ""),
      rowsM[1]?.content,
    );
    const metaM = rowsM[rowsM.length - 1]?.meta as {
      asks?: { questions: unknown[]; answers?: { chosen: string[]; custom?: boolean }[] }[];
    } | null;
    check(
      "one card recorded, holding all the questions",
      metaM?.asks?.length === 1 && metaM.asks[0].questions.length === totalAsked,
      `${metaM?.asks?.length} card(s), ${metaM?.asks?.[0]?.questions.length} question(s)`,
    );
    check(
      "the typed answer is recorded as free text",
      metaM?.asks?.[0]?.answers?.some((a) => a.custom === true) === true,
      JSON.stringify(metaM?.asks?.[0]?.answers),
    );
    check(
      "reply reflects the typed answer",
      /ninety minutes|90 minutes/i.test(rowsM[rowsM.length - 1]?.content ?? ""),
      rowsM[rowsM.length - 1]?.content.slice(0, 200),
    );

    // ---- 9. Stop releases a waiting card ---------------------------------
    // Without the turn's abort signal reaching the mailbox this would sit for
    // the full five-minute timeout instead of winding down.
    const page2 = await ctx.newPage();
    page2.on("pageerror", (e) => errors.push(String(e)));
    await page2.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await page2.locator("textarea").fill(PROMPT);
    await page2.locator("textarea").press("Enter");
    await waitForCard(page2);
    const conv2 = (await page2.evaluate(() => location.pathname.split("/chat/")[1] ?? null)) ?? "";
    convIds.push(conv2);
    check("second chat is waiting on a card", true);

    const stoppedAt = Date.now();
    await page2.getByLabel("Stop").click();
    await page2.locator("[data-ask-card]").waitFor({ state: "detached", timeout: 20_000 });
    const elapsed = Date.now() - stoppedAt;
    check("Stop retires the card promptly", elapsed < 20_000, `${elapsed}ms`);
    // The turn must actually be free again — a stuck turn would 409 forever.
    const res = await page2.evaluate(
      async (id) =>
        (
          await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: id, content: "Say READY and nothing else." }),
          })
        ).status,
      conv2,
    );
    check("conversation accepts a new turn after Stop (not 409)", res === 200, `status ${res}`);

    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    for (const id of convIds.filter(Boolean)) {
      await db.conversation.delete({ where: { id } }).catch(() => {});
    }
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await browser.close();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
