/**
 * Manual round-trip test for the backup/restore feature (NOT in the test suite).
 *
 *   node --conditions=react-server --env-file=.env --import tsx scripts/test-backup.ts
 *
 * (`--conditions=react-server` lets the Node-only `server-only` guard import
 * cleanly outside Next.) It snapshots the live dev DB, restores that very
 * snapshot (idempotent — data is unchanged), and asserts row counts + the tricky
 * type round-trips (Bytes / Decimal / BigInt) and timestamp fidelity survive.
 */
import { readFile, unlink } from "node:fs/promises";
import JSZip from "jszip";
import { db } from "../src/lib/db";
import {
  createBackup,
  restoreFromZip,
  backupFilePath,
} from "../src/lib/backup";

async function counts() {
  return {
    users: await db.user.count(),
    credentials: await db.providerCredential.count(),
    usage: await db.usageRecord.count(),
    conversations: await db.conversation.count(),
    messages: await db.message.count(),
    files: await db.file.count(),
    settings: await db.setting.count(),
    auditLog: await db.auditLog.count(),
  };
}

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("— Backup / restore round-trip —\n");

  const before = await counts();
  console.log("Row counts:", JSON.stringify(before), "\n");

  // Sample the special-typed columns before the round-trip.
  const credBefore = await db.providerCredential.findFirst();
  const usageBefore = await db.usageRecord.findFirst();
  const fileBefore = await db.file.findFirst();
  const convBefore = await db.conversation.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  // 1) Create the backup and inspect the archive.
  const info = await createBackup("manual");
  console.log(`Created ${info.name} (${info.sizeBytes} bytes)\n`);
  const path = backupFilePath(info.name);
  const buffer = await readFile(path);
  const zip = await JSZip.loadAsync(buffer);
  check("archive has manifest.json", !!zip.file("manifest.json"));
  check("archive has database.json", !!zip.file("database.json"));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  check(
    "manifest table counts match DB",
    manifest.tables.users === before.users &&
      manifest.tables.messages === before.messages,
    `users=${manifest.tables.users} messages=${manifest.tables.messages}`,
  );

  // 2) Restore the snapshot (idempotent).
  const result = await restoreFromZip(buffer);
  check("restore reports no master-key mismatch", !result.masterKeyMismatch);
  console.log(
    `Restored ${result.restoredFiles} files, tables:`,
    JSON.stringify(result.tables),
    "\n",
  );

  // 3) Row counts unchanged.
  const after = await counts();
  check(
    "row counts identical after restore",
    JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify(after),
  );

  // 4) Special-typed columns round-trip byte-for-byte.
  if (credBefore) {
    const credAfter = await db.providerCredential.findUnique({
      where: { id: credBefore.id },
    });
    check(
      "credential Bytes column round-trips",
      !!credAfter &&
        Buffer.from(credAfter.encryptedValue).equals(
          Buffer.from(credBefore.encryptedValue),
        ),
    );
  } else {
    console.log("• no provider credential present — Bytes check skipped");
  }
  if (usageBefore) {
    const usageAfter = await db.usageRecord.findUnique({
      where: { id: usageBefore.id },
    });
    check(
      "usage Decimal column round-trips",
      !!usageAfter &&
        usageAfter.costEstimate.toString() === usageBefore.costEstimate.toString(),
      usageBefore.costEstimate.toString(),
    );
  } else {
    console.log("• no usage record present — Decimal check skipped");
  }
  if (fileBefore) {
    const fileAfter = await db.file.findUnique({ where: { id: fileBefore.id } });
    check(
      "file BigInt column round-trips",
      !!fileAfter && fileAfter.sizeBytes === fileBefore.sizeBytes,
    );
  } else {
    console.log("• no file record present — BigInt check skipped");
  }
  if (convBefore) {
    const convAfter = await db.conversation.findUnique({
      where: { id: convBefore.id },
    });
    check(
      "conversation updatedAt preserved (not reset to now)",
      !!convAfter &&
        convAfter.updatedAt.getTime() === convBefore.updatedAt.getTime(),
      convBefore.updatedAt.toISOString(),
    );
  } else {
    console.log("• no conversation present — updatedAt check skipped");
  }

  // Clean up the test artifact.
  await unlink(path).catch(() => {});
  console.log(`\nRemoved test backup ${info.name}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
