/**
 * Live harness: OWUI → OPNinfer import against the REAL example backup
 * (owui-importing/webui.db, git-ignored) and the live dev database.
 *
 * Verifies user/chat/message/memory import end-to-end, spot-checks a known
 * chat's thread, proves idempotency (second run imports nothing), then
 * CLEANS UP everything it created (created users cascade their imported
 * conversations + memories; conversations imported for pre-existing users
 * are deleted explicitly).
 *
 * Run:
 *   node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-owui-import.ts
 */
import Database from "better-sqlite3";
import { db } from "../src/lib/db";
import { importOwuiBackup, linearizeOwuiChat } from "../src/lib/owui-import";

const DB_PATH = "owui-importing/webui.db";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  // Ground truth straight from the SQLite file.
  const sdb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const owuiUsers = (sdb.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n;
  const owuiChats = (sdb.prepare("SELECT COUNT(*) AS n FROM chat").get() as { n: number }).n;
  const owuiMems = (sdb.prepare("SELECT COUNT(*) AS n FROM memory").get() as { n: number }).n;
  const sampleChat = sdb
    .prepare("SELECT id, title, updated_at, chat FROM chat ORDER BY updated_at DESC LIMIT 1")
    .get() as { id: string; title: string; updated_at: number; chat: string };
  sdb.close();
  const sampleThread = linearizeOwuiChat(JSON.parse(sampleChat.chat));

  const preUsers = await db.user.count();
  const preConvs = await db.conversation.count();
  const preMsgs = await db.message.count();

  console.log(`\nOWUI source: ${owuiUsers} users, ${owuiChats} chats, ${owuiMems} memories`);
  console.log(`Dev DB before: ${preUsers} users, ${preConvs} conversations\n`);

  // ---- first import ----
  console.log("First import…");
  const t0 = Date.now();
  const s1 = await importOwuiBackup(DB_PATH);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`, {
    ...s1,
    createdUserIds: s1.createdUserIds.length,
    importedConversationIds: s1.importedConversationIds.length,
  });

  check("every OWUI user accounted for",
    s1.usersCreated + s1.usersMatched + s1.usersSkipped === owuiUsers);
  check("every OWUI chat accounted for",
    s1.chatsImported + s1.chatsSkippedExisting + s1.chatsEmpty + s1.chatsUnknownOwner === owuiChats,
    { of: owuiChats, s: s1 });
  check("imported a substantial thread count", s1.chatsImported > 1000, s1.chatsImported);
  check("imported thousands of messages", s1.messagesImported > 5000, s1.messagesImported);

  const dbConvs = await db.conversation.count();
  const dbMsgs = await db.message.count();
  check("conversation rows match summary", dbConvs - preConvs === s1.chatsImported);
  check("message rows match summary", dbMsgs - preMsgs === s1.messagesImported);
  check("memories imported", s1.memoriesImported + s1.memoriesSkipped === owuiMems,
    { imported: s1.memoriesImported, skipped: s1.memoriesSkipped });

  // ---- spot-check the newest chat ----
  const conv = await db.conversation.findUnique({
    where: { id: sampleChat.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  check("sample chat imported under its OWUI id", !!conv);
  if (conv) {
    check("sample chat keeps its title", conv.title === sampleChat.title.trim(),
      { got: conv.title, want: sampleChat.title });
    check("sample chat keeps OWUI updated_at",
      Math.abs(conv.updatedAt.getTime() - sampleChat.updated_at * 1000) < 1500,
      { got: conv.updatedAt.toISOString() });
    check("sample thread length matches the active-branch walk",
      conv.messages.length === sampleThread.length,
      { got: conv.messages.length, want: sampleThread.length });
    check("sample thread starts with a user turn", conv.messages[0]?.role === "user");
    check("sample thread content matches walk order",
      conv.messages.every((m, i) => m.content === sampleThread[i]?.content));
    check("imported messages carry provenance meta",
      conv.messages.every((m) => (m.meta as { imported?: string })?.imported === "owui"));
  }

  // Imported users are verified + regular-role with a password nobody knows.
  const createdUsers = await db.user.findMany({
    where: { id: { in: s1.createdUserIds } },
    select: { role: true, emailVerified: true, passwordHash: true, disabled: true },
  });
  check("created users are verified regular users",
    createdUsers.length === s1.usersCreated &&
    createdUsers.every((u) => u.role === "user" && u.emailVerified && !u.disabled && u.passwordHash.length > 20));

  // ---- idempotency: run again ----
  console.log("\nSecond import (idempotency)…");
  const s2 = await importOwuiBackup(DB_PATH);
  check("second run creates no users", s2.usersCreated === 0, s2.usersCreated);
  check("second run matches all users", s2.usersMatched === s1.usersCreated + s1.usersMatched);
  check("second run imports no chats", s2.chatsImported === 0, s2.chatsImported);
  check("second run skips previously imported chats",
    s2.chatsSkippedExisting === s1.chatsImported + s1.chatsSkippedExisting);
  check("second run imports no memories", s2.memoriesImported === 0, s2.memoriesImported);
  const dbMsgs2 = await db.message.count();
  check("second run adds zero message rows", dbMsgs2 === dbMsgs);

  // ---- cleanup ----
  console.log("\nCleaning up…");
  // Conversations imported for users that already existed (cascade won't get these).
  await db.conversation.deleteMany({ where: { id: { in: s1.importedConversationIds } } });
  // Created users cascade their memories.
  await db.user.deleteMany({ where: { id: { in: s1.createdUserIds } } });
  const postUsers = await db.user.count();
  const postConvs = await db.conversation.count();
  const postMsgs = await db.message.count();
  check("cleanup restored user count", postUsers === preUsers, { postUsers, preUsers });
  check("cleanup restored conversation count", postConvs === preConvs, { postConvs, preConvs });
  check("cleanup restored message count", postMsgs === preMsgs, { postMsgs, preMsgs });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
