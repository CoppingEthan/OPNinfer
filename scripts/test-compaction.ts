/**
 * Live proof of conversation compaction (2026-09-10, docs/V07_CONTEXT_COMPACTION.md).
 *
 *   TEST_BASE_URL=http://localhost:3014 node --import tsx \
 *     --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-compaction.ts
 *
 * Runs against a dev server (start one on its own port + NEXT_DIST_DIR — the
 * documented "localhost:3000 is not necessarily this project" trap). Real
 * front-end AND conversation models; ~$0.50 of spend at Sonnet 5 rates.
 *
 * The admin trigger is lowered to 30k / keep 6k for the run (restored in
 * `finally`) so the seeds stay cheap; the code path is identical.
 *
 * What it proves:
 *  1. A chat over the trigger is summarised at the start of the next turn:
 *     the phase line, the `compacted` event, the stored row, and the reply
 *     model's prompt well under the trigger.
 *  2. The summary CARRIES INFORMATION: five facts planted early in the
 *     summarised part are recalled (≥ 4 of 5) with no tools.
 *  3. The next message reads the new prefix from the prompt cache.
 *  4. The summarisation is billed under the `compaction` role on the
 *     front-end model.
 *  5. Retry keeps the compaction; the divider shows on the chat page and in
 *     the admin viewer (with the summary itself).
 *  6. Editing a message from BEFORE the boundary voids the compaction.
 *  7. A 400k-token chat in the imported shape (tied timestamps, scrambled
 *     physical order) compacts in several chunks, replays user-first, and
 *     its next real turn is sent under the trigger.
 *  8. The boot sweep compacts an oversize idle chat, skips one with a live
 *     turn, and moves nobody's "last activity".
 */
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { setTokenLimits, getTokenLimits } from "../src/lib/limits";
import { compactConversation, loadCompaction, sweepOversizedConversations } from "../src/lib/compaction";
import { orderThreadRows } from "../src/lib/thread-order";
import { startTurn, endTurn } from "../src/lib/turn-stream";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Compaction-Harness-Pass-42!";
const COMPACT_AT = 30_000;
const KEEP = 6_000;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

type SseEvent = { type: string; [k: string]: unknown };
async function readSse(res: Response, onEvent: (ev: SseEvent) => void | "stop"): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.startsWith("data:") ? frame.slice(5).trim() : "";
      if (!line) continue;
      if (onEvent(JSON.parse(line) as SseEvent) === "stop") {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  }
}

async function login(email: string) {
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
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return cookie;
}

/** One turn through the real route; collects what the stream said. */
async function turn(cookie: () => string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = { status: res.status, text: "", phases: [] as string[], compactedThrough: null as string | null, messageId: null as string | null, conversationId: null as string | null, error: null as string | null };
  if (!res.ok || !res.body) {
    out.error = await res.text().catch(() => String(res.status));
    return out;
  }
  await readSse(res, (ev) => {
    if (ev.type === "meta") out.conversationId = (ev.conversationId as string) ?? null;
    if (ev.type === "phase" && typeof ev.label === "string") out.phases.push(ev.label);
    if (ev.type === "compacted") out.compactedThrough = ev.throughMessageId as string;
    if (ev.type === "text") out.text += ev.delta as string;
    if (ev.type === "error") out.error = String(ev.message);
    if (ev.type === "done") { out.messageId = (ev.messageId as string) ?? null; return "stop"; }
  });
  return out;
}

// ---- realistic filler so the summariser (and the reply model) see prose ----
const PARAS = [
  "Thanks for the update on the Fremantle crane hire. The client has confirmed the site will be clear from Monday, so mobilisation can start at six in the morning. Please make sure the rigging crew has the revised lift plan and that the permit copies are in the site office before the first lift.",
  "On the pricing question: the quote we sent in July assumed a four-week hire, but they now expect six. I would suggest we hold the weekly rate and add the extra fortnight at the same rate rather than reprice the whole job, which keeps the relationship simple and avoids another round of approvals on their side.",
  "For the safety audit next month, the auditor has asked for the maintenance logs for both tower cranes, the operator certifications, and the incident register. Most of this is already in the shared folder, but the certifications for the two new operators still need to be uploaded.",
  "The invoice for the Perth job went out on the 14th with thirty-day terms. Their accounts team usually pays on time, but it is worth a polite reminder a week before the due date, especially since the retention amount was queried last time and we do not want the same confusion again.",
  "Regarding the proposal for the Sydney distribution centre: the tender closes on the 28th. We need a one-page summary of our approach, a schedule showing the crane positions for each stage, and references from two comparable projects. I can draft the summary if you pull the schedule together.",
];
function prose(seed: number, chars: number): string {
  let s = "";
  let i = seed;
  while (s.length < chars) { s += PARAS[i % PARAS.length] + ` (note ${seed}-${i}) `; i++; }
  return s.slice(0, chars).trim();
}

const FACTS = {
  name: "Marguerite Okonkwo-Fairweather",
  rate: "£1,847",
  date: "14 November 2026",
  subcontractor: "Delta Rigging",
  signoff: "we lift more than steel",
};
/** ~45k tokens across 36 turns; the five facts sit in turns 2–6, the part
 *  that will be summarised (keep 6k covers only the last few turns). */
function seedRows(convId: string, turns = 36, userChars = 900, assistantChars = 4_000) {
  const t0 = Date.now() - turns * 120_000;
  const rows: { conversationId: string; role: "user" | "assistant"; content: string; createdAt: Date; userId?: string }[] = [];
  for (let k = 0; k < turns; k++) {
    let u = `Message ${k}. ` + prose(k, userChars);
    let a = `Reply ${k}. ` + prose(k + 100, assistantChars);
    if (k === 2) u = `Our client contact for this whole project is ${FACTS.name} — please always address her by her full name. ` + u;
    if (k === 3) a = `Noted: the crane hire day rate agreed with the client is ${FACTS.rate} per day, fixed for the duration. ` + a;
    if (k === 4) u = `The site handover date is confirmed as ${FACTS.date}. ` + u;
    if (k === 5) a = `Decision recorded: we will NOT use the subcontractor ${FACTS.subcontractor} on this job, after the audit findings. ` + a;
    if (k === 6) u = `Our email template's sign-off line must always be exactly: "Warm regards, Team Tower — ${FACTS.signoff}." Keep that wording. ` + u;
    rows.push({ conversationId: convId, role: "user", content: u, createdAt: new Date(t0 + k * 120_000) });
    rows.push({ conversationId: convId, role: "assistant", content: a, createdAt: new Date(t0 + k * 120_000 + 15_000) });
  }
  return rows;
}

async function promptTokensOf(userId: string, since: Date, role = "conversation") {
  const rows = await db.usageRecord.findMany({ where: { userId, role, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    prompt: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    read: r.cacheReadTokens,
    write: r.cacheWriteTokens,
    model: r.model,
    cost: Number(r.costEstimate),
  }));
}

async function main() {
  const stamp = Date.now();
  const email = `compaction-${stamp}@example.test`;
  const previousLimits = await getTokenLimits();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date(), lastSeenVersion: "9.9.9", name: "Compaction Harness" },
  });
  try {
    await setTokenLimits({ ...previousLimits, compactAtTokens: COMPACT_AT, compactKeepTokens: KEEP });
    const cookie = await login(email);

    // ---- 1. a chat over the trigger is compacted at the start of the next turn ----
    const convo = await db.conversation.create({ data: { userId: user.id, title: `Compaction fixture ${stamp}` } });
    const seeded = seedRows(convo.id).map((r) => ({ ...r, userId: r.role === "user" ? user.id : undefined }));
    await db.message.createMany({ data: seeded });
    const seededChars = seeded.reduce((n, r) => n + r.content.length, 0);
    check("seed is over the trigger", seededChars / 4 > COMPACT_AT, `${Math.round(seededChars / 4)} tokens`);

    let t = new Date();
    const first = await turn(cookie, { conversationId: convo.id, content: "Reply with exactly the word: ready" });
    check("turn 1 streamed a reply", first.status === 200 && !first.error && first.text.length > 0, first.error ?? first.text.slice(0, 40));
    check("the phase line said what was happening", first.phases.some((p) => /summarising earlier messages/i.test(p)), first.phases.join(" | "));
    check("the stream announced the compaction boundary", !!first.compactedThrough);

    const rows1 = orderThreadRows(await db.message.findMany({ where: { conversationId: convo.id } }));
    const comp1 = await loadCompaction(convo.id, rows1);
    check("a compaction row exists and its boundary is a real message", !!comp1 && comp1.boundaryIndex >= 0);
    check("…and the boundary matches what the stream announced", comp1?.boundaryMessageId === first.compactedThrough);
    check("…and the first kept message is a user turn (whole turns only)", rows1[(comp1?.boundaryIndex ?? -2) + 1]?.role === "user");
    check("…and the summary is substantial but bounded", !!comp1 && comp1.summary.length > 800 && comp1.summary.length <= 40_000, `${comp1?.summary.length} chars`);
    const stored = await db.conversationCompaction.findFirst({ where: { conversationId: convo.id } });
    check("…and it recorded before/after sizes", !!stored && stored.tokensBefore > COMPACT_AT && stored.tokensAfter < COMPACT_AT, `${stored?.tokensBefore} → ${stored?.tokensAfter}`);

    let usage = await promptTokensOf(user.id, t);
    check("the reply model's prompt was well under the trigger", usage.length > 0 && usage.every((u) => u.prompt < COMPACT_AT), usage.map((u) => u.prompt).join(","));
    const compUsage = await promptTokensOf(user.id, t, "compaction");
    check("the summarisation is billed under the compaction role", compUsage.length >= 1, `${compUsage.length} call(s), $${compUsage.reduce((n, u) => n + u.cost, 0).toFixed(4)}`);
    const frontend = (await db.setting.findUnique({ where: { key: "assistant_config" } }))?.value as { roles?: { frontend?: { model?: string } } } | null;
    check("…on the front-end model", !!frontend?.roles?.frontend?.model && compUsage.every((u) => u.model === frontend!.roles!.frontend!.model), compUsage.map((u) => u.model).join(","));

    // ---- 2. the summary carries information ----
    t = new Date();
    const recall = await turn(cookie, {
      conversationId: convo.id,
      content:
        "Without using any tools, answer from this conversation only, one item per line: (1) the client contact's full name, (2) the agreed crane hire day rate, (3) the site handover date, (4) the subcontractor we decided NOT to use, (5) the exact sign-off line from our email template.",
    });
    const got = recall.text.toLowerCase().replace(/\s+/g, " ");
    const hits = Object.entries(FACTS).filter(([, v]) => got.includes(v.toLowerCase())).map(([k]) => k);
    check("the assistant recalls at least 4 of the 5 facts that now exist only in the summary", hits.length >= 4, `recalled: ${hits.join(", ")} — reply: ${recall.text.slice(0, 300)}`);

    // ---- 3. the next message reads the compacted prefix from the cache ----
    usage = await promptTokensOf(user.id, t);
    const last = usage[usage.length - 1];
    check("turn 2 hit the prompt cache on the compacted prefix", !!last && last.read >= 0.6 * last.prompt, last ? `read ${last.read} of ${last.prompt}` : "no usage row");

    // ---- 5. retry keeps it; the divider shows on the page and in the admin viewer ----
    const before = await db.conversationCompaction.count({ where: { conversationId: convo.id } });
    const retry = await turn(cookie, { conversationId: convo.id, regenerate: true });
    check("retry still replies", retry.status === 200 && !retry.error);
    const rows2 = orderThreadRows(await db.message.findMany({ where: { conversationId: convo.id } }));
    const comp2 = await loadCompaction(convo.id, rows2);
    check("retry keeps the compaction (boundary intact, no new row)", !!comp2 && comp2.id === comp1?.id && (await db.conversationCompaction.count({ where: { conversationId: convo.id } })) === before);

    browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 10; i++) {
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', PASSWORD);
      if ((await page.inputValue('input[name="email"]')) === email) break;
      await page.waitForTimeout(200);
    }
    await page.click('button[type="submit"]');
    await page.waitForFunction(`!location.pathname.startsWith('/login')`, undefined, { timeout: 60_000 });
    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='assistant']", { timeout: 60_000 });
    const dividers = await page.locator("[data-compaction-divider]").count();
    check("the chat page draws exactly one divider", dividers === 1, `${dividers}`);
    const dividerPos = await page.evaluate(`(() => {
      const d = document.querySelector('[data-compaction-divider]');
      const bubbles = [...document.querySelectorAll('[data-role]')];
      const after = bubbles.filter(b => d && (d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).length;
      return { total: bubbles.length, after };
    })()`) as { total: number; after: number };
    check("…with the recent messages below it and the summarised ones above", dividerPos.after > 0 && dividerPos.after < dividerPos.total, JSON.stringify(dividerPos));
    const total = await page.locator("[data-role]").count();
    check("…and every message is still on screen", total >= rows2.filter((r) => r.role === "user" || r.role === "assistant").length, `${total} bubbles`);

    // Admin viewer: unlock with the admin's own password, open the chat.
    await page.goto(`${BASE}/admin/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("input[type=password]", { timeout: 30_000 });
    await page.fill("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForSelector("table", { timeout: 30_000 });
    await page.goto(`${BASE}/admin/chats/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-role='assistant']", { timeout: 60_000 });
    check("the admin viewer draws the divider too", (await page.locator("[data-compaction-divider]").count()) === 1);
    const summaryBox = page.locator("[data-compaction-summary]");
    check("…and offers the summary itself", (await summaryBox.count()) === 1);
    const summaryText = (await summaryBox.textContent()) ?? "";
    check("…which names the client from the summarised part", summaryText.includes(FACTS.name), summaryText.slice(0, 120));
    await ctx.close();

    // ---- 6. editing a message from before the boundary voids the compaction ----
    const earlyUser = rows2.find((r, i) => r.role === "user" && i < (comp2?.boundaryIndex ?? 0));
    const edited = await turn(cookie, { conversationId: convo.id, editMessageId: earlyUser!.id, content: "Edited from before the boundary. Reply with exactly the word: ok" });
    check("edit-and-revert from before the boundary still replies", edited.status === 200 && !edited.error, edited.error ?? "");
    const rows3 = orderThreadRows(await db.message.findMany({ where: { conversationId: convo.id } }));
    check("…the boundary row is gone", !rows3.some((r) => r.id === comp2?.boundaryMessageId));
    check("…so the compaction is void and the full (now short) history is used", (await loadCompaction(convo.id, rows3)) === null);
    check("…and no divider is announced for the reverted chat", edited.compactedThrough === null);

    // ---- 7. the imported shape: 400k tokens, tied timestamps, scrambled order ----
    const big = await db.conversation.create({ data: { userId: user.id, title: `Compaction big ${stamp}` } });
    const bigRows: { conversationId: string; role: "user" | "assistant"; content: string; createdAt: Date; userId?: string }[] = [];
    const b0 = Date.now() - 400 * 60_000;
    for (let k = 0; k < 200; k++) {
      const at = new Date(b0 + k * 60_000); // user and reply share the SECOND, as OWUI does
      bigRows.push({ conversationId: big.id, role: "user", content: `Question ${k}: ` + prose(k, 1_000), createdAt: at, userId: user.id });
      bigRows.push({ conversationId: big.id, role: "assistant", content: `Answer ${k}: ` + prose(k + 7, 7_000), createdAt: at });
    }
    bigRows[2].content = `Question 1: our project code word is PELICAN-SEVEN — remember it, I will ask for it later. ` + bigRows[2].content;
    for (let i = bigRows.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [bigRows[i], bigRows[j]] = [bigRows[j], bigRows[i]]; }
    await db.message.createMany({ data: bigRows });
    const bigChars = bigRows.reduce((n, r) => n + r.content.length, 0);
    check("big seed is in the imported-chat shape", bigChars / 4 > 380_000, `${Math.round(bigChars / 4)} tokens, tied pairs`);
    const bigOrdered = orderThreadRows(await db.message.findMany({ where: { conversationId: big.id } }));
    let tiesUserFirst = true;
    for (let i = 0; i + 1 < bigOrdered.length; i += 2) if (bigOrdered[i].role !== "user" || bigOrdered[i + 1].role !== "assistant") tiesUserFirst = false;
    check("the replay order puts every question before its answer", tiesUserFirst);
    t = new Date();
    const bigResult = await compactConversation({ conversationId: big.id, userId: user.id, rows: bigOrdered, reason: "sweep" });
    check("the 400k chat compacts", !!bigResult, bigResult ? `${bigResult.tokensBefore} → ${bigResult.tokensAfter} in ${bigResult.calls} calls, $${bigResult.cost.toFixed(4)}, ${(bigResult.ms / 1000).toFixed(1)}s` : "null");
    check("…in several chunks the front-end model can read", !!bigResult && bigResult.calls >= 4);
    check("…to well under the trigger", !!bigResult && bigResult.tokensAfter < COMPACT_AT);
    check("…keeping the early code word", !!bigResult && /PELICAN-SEVEN/i.test(bigResult.compaction.summary));
    t = new Date();
    const bigTurn = await turn(cookie, { conversationId: big.id, content: "Without tools: what is the project code word? Reply with just the code word." });
    check("a real turn on the compacted 400k chat replies", bigTurn.status === 200 && !bigTurn.error, bigTurn.error ?? "");
    check("…and knows the code word", /PELICAN-SEVEN/i.test(bigTurn.text), bigTurn.text.slice(0, 80));
    usage = await promptTokensOf(user.id, t);
    check("…from a prompt under the trigger, not 400k", usage.length > 0 && usage.every((u) => u.prompt < COMPACT_AT), usage.map((u) => u.prompt).join(","));

    // ---- 8. the sweep ----
    const idle = await db.conversation.create({ data: { userId: user.id, title: `Compaction idle ${stamp}` } });
    await db.message.createMany({ data: seedRows(idle.id, 30).map((r) => ({ ...r, userId: r.role === "user" ? user.id : undefined })) });
    const busy = await db.conversation.create({ data: { userId: user.id, title: `Compaction busy ${stamp}` } });
    await db.message.createMany({ data: seedRows(busy.id, 30).map((r) => ({ ...r, userId: r.role === "user" ? user.id : undefined })) });
    const idleBefore = (await db.conversation.findUnique({ where: { id: idle.id } }))!.updatedAt;
    const live = startTurn(busy.id); // a turn is running in "this" process → the sweep must leave it alone
    const swept = await sweepOversizedConversations({ limit: 10 });
    if (live) endTurn(live);
    const idleRows = orderThreadRows(await db.message.findMany({ where: { conversationId: idle.id } }));
    const busyRows = orderThreadRows(await db.message.findMany({ where: { conversationId: busy.id } }));
    check("the sweep compacts the oversize idle chat", (await loadCompaction(idle.id, idleRows)) !== null, JSON.stringify(swept));
    check("…skips the chat with a live turn", (await loadCompaction(busy.id, busyRows)) === null);
    check("…and does not touch the chat's last activity", (await db.conversation.findUnique({ where: { id: idle.id } }))!.updatedAt.getTime() === idleBefore.getTime());
    check("…and leaves an already-compacted chat alone", (await db.conversationCompaction.count({ where: { conversationId: big.id } })) === 1);
  } finally {
    await browser?.close().catch(() => {});
    await setTokenLimits(previousLimits).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
