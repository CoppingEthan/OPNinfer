/**
 * Restore a PRE-memory-v2 backup (≤ 0.5.0) into this build (NOT in the test
 * suite; live dev DB — it snapshots the DB and restores an edited copy, so
 * every row survives and only the memory notes change).
 *
 * Why: the owner migrates instances by backup-and-restore, and the archive
 * they carry over may have been taken by an older build. Such an archive has
 * a `user_memories` table this build no longer knows and no author on user
 * turns. Restore must fold the old memories into each person's "About you"
 * note (as the 0.5.1 migration did) and stamp authors — not drop them, and
 * not fail on the retired table's sequence.
 *
 *   node --conditions=react-server --env-file=.env --import tsx scripts/test-backup-legacy-restore.ts
 */
import { readFile, unlink } from "node:fs/promises";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import { backupFilePath, createBackup, restoreFromZip } from "../src/lib/backup";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.findFirst({ where: { email: { endsWith: "@test.local" } }, select: { id: true, email: true } });
  if (!user) throw new Error("no @test.local user to hang the legacy memories on — run the seed first");
  const before = {
    users: await db.user.count(),
    conversations: await db.conversation.count(),
    messages: await db.message.count(),
    files: await db.file.count(),
  };

  const info = await createBackup("manual");
  const path = backupFilePath(info.name);
  const zip = await JSZip.loadAsync(await readFile(path));
  const dump = JSON.parse(await zip.file("database.json")!.async("string")) as Record<string, Record<string, unknown>[]>;

  // Make it look like a 0.4.1 archive: the old memory table instead of the
  // new one, and no author on user turns.
  delete dump["user_memory_topics"];
  dump["user_memories"] = [
    { id: 1, userId: user.id, content: "Prefers metric units", createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z" },
    { id: 2, userId: user.id, content: "Runs the Leeds office", createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z" },
  ];
  const userTurns = (dump["messages"] ?? []).filter((m) => m.role === "user");
  for (const m of userTurns) delete m.userId;
  zip.file("database.json", JSON.stringify(dump));
  const legacy = await zip.generateAsync({ type: "nodebuffer" });

  const result = await restoreFromZip(legacy);
  check("legacy archive restores without error", true, `${JSON.stringify(result.counts ?? {}).slice(0, 120)}`);

  const after = {
    users: await db.user.count(),
    conversations: await db.conversation.count(),
    messages: await db.message.count(),
    files: await db.file.count(),
  };
  check("row counts unchanged (users/chats/messages/files)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  const about = await db.userMemoryTopic.findUnique({ where: { userId_key: { userId: user.id, key: "about" } } });
  check("old memories folded into About you, oldest first", about?.text === "- Prefers metric units\n- Runs the Leeds office", about?.text ?? "(none)");

  const unstamped = await db.message.count({ where: { role: "user", userId: null } });
  check("user turns re-stamped with their chat's owner", unstamped === 0, `${unstamped} still NULL`);

  // The note sequence advanced past the restored rows: a new note saves.
  const probe = await db.userMemoryTopic.create({ data: { userId: user.id, key: "rules", text: "- probe" } });
  check("a new note can be saved after the restore (sequence advanced)", probe.id > (about?.id ?? 0));
  await db.userMemoryTopic.delete({ where: { id: probe.id } });
  await db.userMemoryTopic.deleteMany({ where: { userId: user.id, key: "about" } });

  await unlink(path).catch(() => {});
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
