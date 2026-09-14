/**
 * Shared chats (v0.5 — docs/V05_SHARED_CHATS.md), end to end, with TWO real
 * people in TWO browser sessions against a real model:
 *
 *   1. Alice starts a chat and gets a reply.
 *   2. Alice shares it with Bob from the People panel (owner badge, Bob listed).
 *   3. Bob's sidebar gains it LIVE, in the "Shared" section, with a notice.
 *   4. Bob opens it: Alice's message carries her name; Alice's panel shows
 *      Bob online.
 *   5. Bob sends; Alice's screen shows Bob's bubble (with his name) and the
 *      SAME reply, live, without a refresh.
 *   6. While a long reply streams, both people schedule a message: both chips
 *      show on BOTH screens, and afterwards they run in arrival order, each
 *      as its author, each with its own reply — on both screens.
 *   7. Bob attaches a file; the model reads it; Alice can download it.
 *   8. The assistant's question card is answered by Bob; both screens show
 *      the reply honouring it and "Answered by Bob".
 *   9. Ratings are per person: Alice 👍, Bob 👎, two feedback rows.
 *  10. Bob may not edit Alice's message (403), delete or invite (no controls);
 *      he can rename, search finds the chat for him, he can export it.
 *  11. Unread: activity while Alice is elsewhere marks the row; opening clears.
 *  12. Alice removes Bob: his open screen is bounced, his sidebar loses it,
 *      every route refuses him, and the chat is private again.
 *  13. Alice re-shares, then deletes: Bob's screen says so.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-shared-chat.ts
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "shared-chat-1!";
const STAMP = Date.now();

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 180)}` : ""}`);
  if (!ok) failures++;
}

async function signIn(browser: Awaited<ReturnType<typeof chromium.launch>>, email: string): Promise<BrowserContext> {
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
  return ctx;
}

async function sendMessage(page: Page, text: string) {
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
}

/** Wait until the LAST assistant bubble on the page contains `needle`. */
async function waitForReply(page: Page, needle: RegExp, timeout = 120_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const texts = await page.locator("[data-role=assistant]").allInnerTexts();
    const last = texts[texts.length - 1] ?? "";
    if (needle.test(last) && !(await page.locator("[data-role=assistant] .oi-shimmer").count())) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${needle} — last: ${last.slice(0, 200)}`);
    await page.waitForTimeout(400);
  }
}

async function waitFor(fn: () => Promise<boolean>, timeout = 15_000, step = 250): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

async function main() {
  const alice = await db.user.create({
    data: {
      email: `alice-${STAMP}@example.test`,
      name: "Alice Owner",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });
  const bob = await db.user.create({
    data: {
      email: `bob-${STAMP}@example.test`,
      name: "Bob Member",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  const browser = await chromium.launch();
  let convId = "";
  try {
    const aCtx = await signIn(browser, alice.email);
    const bCtx = await signIn(browser, bob.email);
    const a = await aCtx.newPage();
    const b = await bCtx.newPage();
    a.on("dialog", (d) => void d.accept());
    b.on("dialog", (d) => void d.accept());

    // ── 1. Alice starts a chat ─────────────────────────────────────────
    await a.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await a.waitForSelector("textarea", { timeout: 30_000 });
    await sendMessage(a, "Reply with exactly the word PING and nothing else.");
    await waitForReply(a, /PING/i);
    await waitFor(async () => /\/chat\/[0-9a-f-]{36}$/.test(a.url()));
    convId = a.url().split("/chat/")[1];
    check("1. Alice's chat exists and got a reply", /^[0-9a-f-]{36}$/.test(convId), convId);

    // ── 2. Share from the People panel ─────────────────────────────────
    await b.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await b.waitForSelector("textarea", { timeout: 30_000 });
    await a.click("[data-people-button]");
    await a.waitForSelector(`[data-people-panel="${convId}"] [data-people-list]`, { timeout: 15_000 });
    check("2. the panel lists Alice as owner", (await a.locator(`[data-person="${alice.id}"][data-person-role=owner]`).count()) === 1);
    await a.fill("[data-people-search]", "bob-");
    await a.waitForSelector(`[data-people-result="${bob.id}"]`, { timeout: 15_000 });
    await a.click(`[data-people-result="${bob.id}"]`);
    await a.waitForSelector(`[data-person="${bob.id}"]`, { timeout: 15_000 });
    check("2. Bob is now listed as a member", (await a.locator(`[data-person="${bob.id}"][data-person-role=member]`).count()) === 1);
    const members = await db.conversationMember.count({ where: { conversationId: convId } });
    check("2. membership rows: owner + Bob", members === 2, String(members));

    // ── 3. Bob's sidebar gains it live ─────────────────────────────────
    const gained = await waitFor(async () => (await b.locator(`[data-sidebar-section=shared] [data-conversation="${convId}"]`).count()) === 1);
    check("3. Bob's sidebar shows the chat under Shared, live (no reload)", gained);
    const toast = await b.locator("[data-live-toasts]").innerText().catch(() => "");
    check("3. …with a notice naming Alice", /Alice/.test(toast), toast);
    check("3. Alice's own row moved to Shared", (await a.locator(`[data-sidebar-section=shared] [data-conversation="${convId}"][data-mine="1"]`).count()) === 1);

    // ── 4. Bob opens it ────────────────────────────────────────────────
    await b.goto(`${BASE}/chat/${convId}`, { waitUntil: "domcontentloaded" });
    await b.waitForSelector("[data-role=user]", { timeout: 30_000 });
    check("4. Alice's message carries her name on Bob's screen", (await b.locator(`[data-role=user] [data-author="${alice.id}"]`).count()) === 1);
    const online = await waitFor(async () => (await a.locator(`[data-person="${bob.id}"][data-person-online="1"]`).count()) === 1);
    check("4. Alice's panel shows Bob online", online);
    await a.keyboard.press("Escape");

    // ── 5. Bob sends; Alice sees it live ───────────────────────────────
    await sendMessage(b, "Reply with exactly the word PONG and nothing else.");
    const bobBubble = await waitFor(async () => (await a.locator(`[data-role=user] [data-author="${bob.id}"]`).count()) === 1, 20_000);
    check("5. Bob's bubble appears on Alice's screen with his name", bobBubble);
    const aReply = await waitForReply(a, /PONG/i);
    const bReply = await waitForReply(b, /PONG/i);
    check("5. Alice's screen streamed the same reply Bob got", aReply.trim() === bReply.trim(), `${aReply.slice(0, 40)} | ${bReply.slice(0, 40)}`);
    check("5. Alice's screen: exactly two user bubbles, no duplicates", (await a.locator("[data-role=user]").count()) === 2);

    // ── 6. Scheduling from both people during a long reply ─────────────
    await sendMessage(a, "Count from 1 to 40, one number per line, then write the word FINISHED.");
    await a.waitForSelector("[data-role=assistant] .oi-shimmer, [data-role=assistant]", { timeout: 20_000 });
    await b.waitForTimeout(800);
    await sendMessage(b, "Reply with exactly the word ALPHA and nothing else.");
    await b.waitForTimeout(400);
    await sendMessage(a, "Reply with exactly the word BETA and nothing else.");
    const chipsA = await waitFor(async () => (await a.locator("[data-queued]").count()) === 2, 10_000);
    const chipsB = await waitFor(async () => (await b.locator("[data-queued]").count()) === 2, 10_000);
    check("6. both scheduled chips show on Alice's screen", chipsA, String(await a.locator("[data-queued]").count()));
    check("6. …and on Bob's", chipsB, String(await b.locator("[data-queued]").count()));
    const order = await a.locator("[data-queued]").evaluateAll((els) => els.map((e) => e.getAttribute("data-queued-by")));
    check("6. chips in arrival order: Bob then Alice", order[0] === bob.id && order[1] === alice.id, order.join(","));
    check("6. a prose reply offers the message as a steer (chip says so)", (await a.locator('[data-queued][data-queued-steering="1"]').count()) === 2);
    // Both run after the long reply — each as its author, each with a reply.
    await waitForReply(b, /BETA/i, 180_000);
    await waitForReply(a, /BETA/i, 60_000);
    const users = await b.locator("[data-role=user]").evaluateAll((els) =>
      els.map((e) => ({ by: e.querySelector("[data-author]")?.getAttribute("data-author"), text: (e.textContent ?? "").trim().slice(0, 60) })),
    );
    const alphaIdx = users.findIndex((u) => /ALPHA/.test(u.text));
    const betaIdx = users.findIndex((u) => /BETA/.test(u.text));
    check("6. ALPHA (Bob) ran before BETA (Alice), each attributed", alphaIdx > 0 && betaIdx === alphaIdx + 1 && users[alphaIdx].by === bob.id && users[betaIdx].by === alice.id, JSON.stringify(users.slice(-3)));
    const replies = await a.locator("[data-role=assistant]").allInnerTexts();
    check("6. Alice's screen: the ALPHA reply then the BETA reply", /ALPHA/.test(replies[replies.length - 2] ?? "") && /BETA/.test(replies[replies.length - 1] ?? ""), replies.slice(-2).map((r) => r.slice(0, 30)).join(" | "));
    check("6. queue is empty again", (await a.locator("[data-queued]").count()) === 0);
    const alphaRow = await db.message.findFirst({ where: { conversationId: convId, role: "user", content: { contains: "ALPHA" } } });
    check("6. the scheduled message is stored as Bob's", alphaRow?.userId === bob.id);
    const usage = await db.usageRecord.findMany({ where: { userId: bob.id, role: "conversation" } });
    check("6. Bob's turns are charged to Bob", usage.length >= 2, String(usage.length));

    // ── 7. A file from Bob ─────────────────────────────────────────────
    await b.locator("input[type=file]").setInputFiles({ name: "secret.txt", mimeType: "text/plain", buffer: Buffer.from("The secret code is ZEBRA-42.\n") });
    // The composer's chip strip sits ABOVE the form; the chip's remove button
    // names the file.
    await b.waitForSelector('button[aria-label="Remove secret.txt"]', { timeout: 20_000 });
    await sendMessage(b, "What is the secret code in the attached file? Reply with just the code.");
    const fileReply = await waitForReply(a, /ZEBRA-42/i, 180_000);
    check("7. the model read Bob's file; Alice's screen shows the answer", /ZEBRA-42/.test(fileReply));
    const file = await db.file.findFirst({ where: { conversationId: convId, filename: "secret.txt" } });
    const dl = file ? await aCtx.request.get(`${BASE}/api/files/${file.id}`) : null;
    check("7. Alice can download Bob's file", dl?.status() === 200, String(dl?.status()));
    const ctxView = file ? await aCtx.request.get(`${BASE}/api/files/${file.id}/context`) : null;
    check("7. …and see what the assistant read", ctxView?.status() === 200);

    // ── 8. The question card, answered by Bob ──────────────────────────
    await sendMessage(a, "Use your ask_user tool to ask me ONE multiple-choice question 'Which animal?' with exactly two options: Cat and Dog. After I answer, reply with only the chosen animal inside square brackets, like [Cat].");
    const cardOnBob = await waitFor(async () => (await b.locator("[data-ask-card]").count()) === 1, 90_000);
    check("8. the question card appears on Bob's screen", cardOnBob);
    if (cardOnBob) {
      await b.click('[data-ask-option="Dog"]');
      const answered = await waitForReply(a, /\[Dog\]/i, 120_000);
      check("8. Alice's screen got the reply honouring Bob's answer", /\[Dog\]/i.test(answered));
      await b.locator("[data-activity-collapsed]").last().click().catch(() => {});
      const by = await waitFor(async () => (await b.locator(`[data-ask-answered-by="${bob.id}"]`).count()) >= 1, 10_000);
      check("8. the record says who answered", by);
      check("8. Alice's card retired too", (await a.locator("[data-ask-card]").count()) === 0);
    }

    // ── 9. Ratings per person ──────────────────────────────────────────
    const lastAssistant = await db.message.findFirst({ where: { conversationId: convId, role: "assistant" }, orderBy: { createdAt: "desc" } });
    await a.locator("[data-role=assistant]").last().hover();
    await a.locator('[data-role=assistant] button[aria-label="Good response"]').last().click({ force: true });
    await b.locator("[data-role=assistant]").last().hover();
    await b.locator('[data-role=assistant] button[aria-label="Bad response"]').last().click({ force: true });
    const rated = await waitFor(async () => {
      const m = await db.message.findUnique({ where: { id: lastAssistant!.id } });
      const r = (m?.meta as { ratings?: Record<string, string> } | null)?.ratings ?? {};
      return r[alice.id] === "up" && r[bob.id] === "down";
    }, 10_000);
    check("9. Alice 👍 and Bob 👎 both stored on the same reply", rated);
    const fb = await db.messageFeedback.count({ where: { messageId: lastAssistant!.id } });
    check("9. two feedback rows, one per rater", fb === 2, String(fb));

    // ── 10. What Bob may not do ────────────────────────────────────────
    const aliceMsg = await db.message.findFirst({ where: { conversationId: convId, role: "user", userId: alice.id }, orderBy: { createdAt: "asc" } });
    const edit = await bCtx.request.post(`${BASE}/api/chat`, { data: { conversationId: convId, content: "hijack", editMessageId: aliceMsg!.id } });
    check("10. Bob cannot edit-revert Alice's message (403)", edit.status() === 403, String(edit.status()));
    await b.click("[data-people-button]");
    await b.waitForSelector(`[data-people-panel="${convId}"] [data-people-list]`, { timeout: 15_000 });
    check("10. Bob's panel has no add-people box, but a Leave button", (await b.locator("[data-people-search]").count()) === 0 && (await b.locator("[data-people-leave]").count()) === 1);
    await b.keyboard.press("Escape");
    const row = b.locator(`[data-conversation="${convId}"]`);
    await row.hover();
    await row.locator('button[aria-label="Chat options"]').click({ force: true });
    const items = await b.locator('[role=menu] [role=menuitem]').allInnerTexts();
    check("10. Bob's kebab offers Leave, never Delete", items.includes("Leave") && !items.includes("Delete"), items.join(","));
    await b.click('[role=menuitem]:has-text("Rename")');
    await b.fill(`[data-conversation="${convId}"] input, li input`, `Renamed by Bob ${STAMP}`);
    await b.keyboard.press("Enter");
    const renamed = await waitFor(async () => (await a.locator(`[data-conversation="${convId}"]`).innerText()).includes(`Renamed by Bob ${STAMP}`), 10_000);
    check("10. Bob's rename shows on Alice's sidebar live", renamed);
    const search = await bCtx.request.get(`${BASE}/api/search?q=PING`);
    const hits = ((await search.json()) as { results: { id: string }[] }).results ?? [];
    check("10. search finds the shared chat for Bob", hits.some((h) => h.id === convId));
    const exp = await bCtx.request.get(`${BASE}/api/conversations/${convId}/export`);
    const expBody = exp.status() === 200 ? ((await exp.json()) as { messages: { author?: string }[] }) : null;
    check("10. Bob can export it, with authors", !!expBody && expBody.messages.some((m) => m.author === "Alice Owner"));
    const searchAsBob = await bCtx.request.get(`${BASE}/api/chat/thread?conversationId=${convId}`);
    check("10. Bob can reload the thread", searchAsBob.status() === 200);

    // ── 11. Unread dot ─────────────────────────────────────────────────
    await a.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await a.waitForSelector("textarea", { timeout: 30_000 });
    await sendMessage(b, "Reply with exactly the word GAMMA and nothing else.");
    await waitForReply(b, /GAMMA/i);
    const unread = await waitFor(async () => (await a.locator(`[data-conversation="${convId}"][data-unread="1"]`).count()) === 1, 15_000);
    check("11. Alice's sidebar marks the chat unread while she is elsewhere", unread);
    await a.goto(`${BASE}/chat/${convId}`, { waitUntil: "domcontentloaded" });
    await a.waitForSelector("[data-role=user]", { timeout: 30_000 });
    const cleared = await waitFor(async () => (await a.locator(`[data-conversation="${convId}"][data-unread="1"]`).count()) === 0, 10_000);
    check("11. …and opening it clears the dot", cleared);
    check("11. Alice's reload shows GAMMA (the full thread, authors intact)", (await a.locator("[data-role=user]").allInnerTexts()).some((t) => /GAMMA/.test(t)) && (await a.locator(`[data-role=user] [data-author="${bob.id}"]`).count()) >= 3);

    // ── 12. Remove Bob ─────────────────────────────────────────────────
    await a.click("[data-people-button]");
    await a.waitForSelector(`[data-people-remove="${bob.id}"]`, { timeout: 15_000 });
    await a.click(`[data-people-remove="${bob.id}"]`);
    const bounced = await waitFor(async () => (await b.locator("[data-access-lost=removed]").count()) === 1, 15_000);
    check("12. Bob's open screen says he no longer has access", bounced);
    check("12. Bob's sidebar lost the chat", (await b.locator(`[data-conversation="${convId}"]`).count()) === 0);
    const t404 = await bCtx.request.get(`${BASE}/api/chat/thread?conversationId=${convId}`);
    const f404 = file ? await bCtx.request.get(`${BASE}/api/files/${file.id}`) : null;
    const e404 = await bCtx.request.get(`${BASE}/api/conversations/${convId}/export`);
    const s = await bCtx.request.post(`${BASE}/api/chat`, { data: { conversationId: convId, content: "still here?" } });
    check("12. every route refuses Bob now", t404.status() === 404 && f404?.status() === 404 && e404.status() === 404 && s.status() === 404, `${t404.status()} ${f404?.status()} ${e404.status()} ${s.status()}`);
    const left = await db.conversationMember.count({ where: { conversationId: convId } });
    check("12. the chat is private again (no member rows)", left === 0, String(left));
    const bobFiles = await db.file.count({ where: { conversationId: convId, userId: bob.id } });
    check("12. Bob's file stayed with the chat (re-stamped to Alice)", bobFiles === 0 && !!file && (await db.file.findUnique({ where: { id: file.id } }))?.userId === alice.id);
    await a.keyboard.press("Escape");
    const privateRow = await waitFor(async () => (await a.locator(`[data-conversation="${convId}"][data-shared="0"]`).count()) === 1, 10_000);
    check("12. Alice's row left the Shared section", privateRow);

    // ── 13. Re-share, then delete ──────────────────────────────────────
    await b.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    await b.waitForSelector("textarea", { timeout: 30_000 });
    await a.click("[data-people-button]");
    await a.waitForSelector("[data-people-search]", { timeout: 15_000 });
    await a.fill("[data-people-search]", "bob-");
    await a.waitForSelector(`[data-people-result="${bob.id}"]`, { timeout: 15_000 });
    await a.click(`[data-people-result="${bob.id}"]`);
    await a.waitForSelector(`[data-person="${bob.id}"]`, { timeout: 15_000 });
    await a.keyboard.press("Escape");
    const back = await waitFor(async () => (await b.locator(`[data-conversation="${convId}"]`).count()) === 1, 15_000);
    check("13. re-shared: Bob's sidebar has it again", back);
    await b.goto(`${BASE}/chat/${convId}`, { waitUntil: "domcontentloaded" });
    await b.waitForSelector("[data-role=user]", { timeout: 30_000 });
    const aRow = a.locator(`[data-conversation="${convId}"]`);
    await aRow.hover();
    await aRow.locator('button[aria-label="Chat options"]').click({ force: true });
    await a.click('[role=menuitem]:has-text("Delete")');
    const gone = await waitFor(async () => (await b.locator("[data-access-lost=deleted]").count()) === 1, 15_000);
    check("13. Alice deleted it: Bob's screen says so", gone);
    check("13. …and it is gone from Bob's sidebar", (await b.locator(`[data-conversation="${convId}"]`).count()) === 0);
    const rowGone = await waitFor(async () => !(await db.conversation.findUnique({ where: { id: convId } })), 10_000);
    check("13. the conversation row is gone", rowGone);
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { OR: [{ userId: alice.id }, { userId: bob.id }] } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
