/**
 * Live harness for EDIT-AND-REVERT (owner feature, 2026-07-13): editing a sent
 * user message permanently reverts the conversation to that point and re-runs
 * the assistant. Drives the real HTTP API against the running dev server:
 *
 *  A. Three-turn chat (turn 3 carries an attachment). Edit turn TWO →
 *     - the stream's `meta` event carries the new user message id
 *     - the reply answers the EDITED content
 *     - turns 2+3 and their reply rows are gone (4 rows remain)
 *     - the dropped turn's file is deleted (DB row AND bytes on disk)
 *  B. Validation: editing an assistant row → 404; a random id → 404;
 *     editMessageId + regenerate together → 400.
 *  C. Edit the FIRST message KEEPING its attachment →
 *     - conversation re-titles (title SSE event fires again)
 *     - the kept file survives (row + disk) and is linked to the new turn
 *     - the reply can actually read the kept attachment (codeword check)
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-edit-revert.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { deleteChatPool, fileExists } from "../src/lib/storage";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "edit-revert-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

interface SseEvent { type: string; [k: string]: unknown }

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
  const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
  const { csrfToken } = await r1.json() as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email, password: PASSWORD }), redirect: "manual" });
  store(r2.headers.getSetCookie());
  return cookie;
}

interface TurnResult {
  convId: string | null;
  userMessageId: string | null;
  doneId: string | null;
  text: string;
  titleEvent: string | null;
  error: string | null;
  status: number;
}

/** POST /api/chat and consume the whole stream. */
async function turn(
  cookie: () => string,
  body: Record<string, unknown>,
): Promise<TurnResult> {
  const out: TurnResult = { convId: null, userMessageId: null, doneId: null, text: "", titleEvent: null, error: null, status: 0 };
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { cookie: cookie(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  out.status = res.status;
  if (!res.ok || !res.body) {
    out.error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    return out;
  }
  await readSse(res, (ev) => {
    if (ev.type === "meta") {
      out.convId = (ev.conversationId as string) ?? null;
      out.userMessageId = (ev.userMessageId as string) ?? null;
    }
    if (ev.type === "text") out.text += ev.delta as string;
    if (ev.type === "title") out.titleEvent = ev.title as string;
    if (ev.type === "done") out.doneId = (ev.messageId as string) ?? null;
    if (ev.type === "error") out.error = ev.message as string;
  });
  return out;
}

async function upload(cookie: () => string, convId: string, name: string, content: string) {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: "text/plain" }));
  const res = await fetch(`${BASE}/api/files?conversationId=${convId}`, {
    method: "POST",
    headers: { cookie: cookie() },
    body: fd,
  });
  return (await res.json()) as { id: string; filename: string };
}

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: { email: `edit-revert-${stamp}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "user", emailVerified: new Date() },
  });
  const convIds: string[] = [];
  try {
    const cookie = await login(user.email);

    // ---- A. three turns, then edit the middle one --------------------------
    const t1 = await turn(cookie, { content: "Reply with exactly: NOTED-ONE" });
    check("turn 1 streamed", !!t1.doneId && !t1.error, t1.error ?? t1.text.slice(0, 40));
    check("meta carries the user message id", !!t1.userMessageId, String(t1.userMessageId));
    const convId = t1.convId!;
    convIds.push(convId);

    const t2 = await turn(cookie, { conversationId: convId, content: "Reply with exactly: NOTED-TWO" });
    check("turn 2 streamed", !!t2.doneId && !t2.error, t2.error ?? "");

    const file1 = await upload(cookie, convId, "codeword.txt", "The secret codeword is PINEAPPLE-42.");
    check("attachment uploaded", !!file1.id, file1.filename);
    const file1Row = await db.file.findUnique({ where: { id: file1.id } });
    const file1Path = file1Row?.storagePath ?? "";

    const t3 = await turn(cookie, { conversationId: convId, content: "Say OK.", fileIds: [file1.id] });
    check("turn 3 (with attachment) streamed", !!t3.doneId && !t3.error, t3.error ?? "");
    const beforeRows = await db.message.count({ where: { conversationId: convId } });
    check("6 rows before the edit", beforeRows === 6, String(beforeRows));

    const edit = await turn(cookie, {
      conversationId: convId,
      editMessageId: t2.userMessageId,
      content: "My favourite colour is green. What is my favourite colour? Reply with just the colour name.",
    });
    check("edit-revert turn streamed", !!edit.doneId && !edit.error, edit.error ?? "");
    check("edit meta carries a NEW user message id", !!edit.userMessageId && edit.userMessageId !== t2.userMessageId, String(edit.userMessageId));
    check("reply answers the EDITED content", /green/i.test(edit.text), edit.text.slice(0, 80));
    check("reply shows no trace of the dropped turns", !/NOTED-TWO/.test(edit.text));

    const rows = await db.message.findMany({ where: { conversationId: convId }, orderBy: { createdAt: "asc" } });
    check("4 rows after the edit (turns 2+3 gone)", rows.length === 4, `got ${rows.length}`);
    check("turn 1 survives", rows.some((r) => r.id === t1.userMessageId));
    check("edited-away rows are gone", !rows.some((r) => r.id === t2.userMessageId || r.id === t3.userMessageId));
    check("new user row holds the edited text", rows.some((r) => r.role === "user" && r.content.startsWith("My favourite colour is green")));

    const file1After = await db.file.findUnique({ where: { id: file1.id } });
    check("dropped turn's file row deleted", !file1After);
    check("dropped turn's file removed from disk", file1Path !== "" && !(await fileExists(file1Path)), file1Path);

    // ---- B. validation ------------------------------------------------------
    const badAssistant = await turn(cookie, { conversationId: convId, editMessageId: edit.doneId, content: "x" });
    check("editing an assistant row → 404", badAssistant.status === 404, `status ${badAssistant.status}`);
    const badRandom = await turn(cookie, { conversationId: convId, editMessageId: "11111111-2222-4333-8444-555555555555", content: "x" });
    check("editing an unknown id → 404", badRandom.status === 404, `status ${badRandom.status}`);
    const badCombo = await turn(cookie, { conversationId: convId, editMessageId: edit.userMessageId, content: "x", regenerate: true });
    check("editMessageId + regenerate → 400", badCombo.status === 400, `status ${badCombo.status}`);

    // ---- C. edit the FIRST message, keeping its attachment ------------------
    const c1 = await turn(cookie, { content: "Say READY." });
    const conv2 = c1.convId!;
    convIds.push(conv2);
    const file2 = await upload(cookie, conv2, "codeword2.txt", "The secret codeword is MANGO-77.");
    // Re-send as an edit of the first turn, now keeping the attachment.
    const firstEdit = await turn(cookie, {
      conversationId: conv2,
      editMessageId: c1.userMessageId,
      content: "What codeword is in the attached file? Reply with just the codeword.",
      fileIds: [file2.id],
    });
    check("first-message edit streamed", !!firstEdit.doneId && !firstEdit.error, firstEdit.error ?? "");
    check("first-message edit re-titles the conversation", !!firstEdit.titleEvent, String(firstEdit.titleEvent));
    check("reply reads the KEPT attachment", /MANGO-77/i.test(firstEdit.text), firstEdit.text.slice(0, 80));
    const file2After = await db.file.findUnique({ where: { id: file2.id } });
    check("kept file row survives", !!file2After);
    check("kept file still on disk", !!file2After && (await fileExists(file2After.storagePath)));
    const rows2 = await db.message.findMany({ where: { conversationId: conv2 }, orderBy: { createdAt: "asc" } });
    check("first-edit conversation has exactly 2 rows", rows2.length === 2, `got ${rows2.length}`);
    const newUserRow = rows2.find((r) => r.role === "user");
    const meta = newUserRow?.meta as { fileIds?: string[] } | null;
    check("kept file re-linked to the new turn", !!meta?.fileIds?.includes(file2.id));
  } finally {
    for (const id of convIds) {
      await db.conversation.delete({ where: { id } }).catch(() => {});
      await deleteChatPool(id).catch(() => {});
    }
    await db.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
