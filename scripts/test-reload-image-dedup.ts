/**
 * Regression for the reload bug where a GENERATED IMAGE also showed up as a
 * plain file-download card. On reload the image is rendered from the message's
 * meta.images (as a GeneratedImage), but the loader's time-based file
 * reconstruction would ALSO attach it as a file card. The fix: exclude any
 * fileId referenced in meta.images from the file reconstruction. This harness
 * builds that exact DB shape and replicates the loader's dedup logic, asserting
 * the image is NOT a file card while a genuine generated file (e.g. a .txt)
 * still is.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-reload-image-dedup.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { attachFilesToMessages } from "../src/lib/message-files";
import { chatPoolRelDir } from "../src/lib/storage";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `reload-dedup-${Date.now()}@x.test`, passwordHash: await hashPassword("x"), role: "admin", emailVerified: new Date() },
  });
  const convo = await db.conversation.create({ data: { userId: user.id, title: "dedup" } });
  const rel = chatPoolRelDir(convo.id);

  try {
    // A user turn, then an assistant reply that generated an IMAGE and a TXT.
    const userMsg = await db.message.create({ data: { conversationId: convo.id, role: "user", content: "make me an image and a text file" } });
    const img = await db.file.create({
      data: { userId: user.id, conversationId: convo.id, filename: "generate-x.jpg", mimeType: "image/jpeg", detectedMime: "image/jpeg", sizeBytes: BigInt(1000), storagePath: `${rel}/generate-x.jpg`, kind: "generated" },
    });
    const txt = await db.file.create({
      data: { userId: user.id, conversationId: convo.id, filename: "notes.txt", mimeType: "text/plain", detectedMime: "text/plain", sizeBytes: BigInt(20), storagePath: `${rel}/notes.txt`, kind: "generated" },
    });
    // The reply: meta.images references the IMAGE; meta.fileIds references the TXT.
    const reply = await db.message.create({
      data: {
        conversationId: convo.id, role: "assistant", content: "Here's your image and the text file.",
        meta: { images: [{ fileId: img.id, aspectRatio: "1:1", prompt: "a leaf", operation: "generate", genMs: 8000 }], fileIds: [txt.id] },
      },
    });

    // --- replicate the loader's reconstruction (src/app/chat/[id]/page.tsx) ---
    const rows = [userMsg, reply];
    const files = await db.file.findMany({ where: { conversationId: convo.id } });
    const imageFileIds = new Set<string>();
    for (const m of rows) {
      const imgs = (m.meta as { images?: { fileId: string }[] } | null)?.images;
      if (imgs) for (const im of imgs) imageFileIds.add(im.fileId);
    }
    const { byMessage } = attachFilesToMessages(
      rows.map((m) => ({ id: m.id, role: m.role as "user" | "assistant", createdAt: m.createdAt, fileIds: (m.meta as { fileIds?: string[] } | null)?.fileIds })),
      files.filter((f) => !imageFileIds.has(f.id)).map((f) => ({ id: f.id, kind: f.kind, createdAt: f.createdAt })),
    );
    const replyFiles = (byMessage.get(reply.id) ?? []).map((f) => f.id);

    check("generated IMAGE is NOT reconstructed as a file card", !replyFiles.includes(img.id), JSON.stringify(replyFiles));
    check("generated TXT file IS reconstructed as a file card", replyFiles.includes(txt.id));
    check("image still available via meta.images", (reply.meta as { images?: unknown[] }).images?.length === 1);

    // Sanity: WITHOUT the exclusion the image WOULD wrongly attach (proves the guard matters).
    const noGuard = attachFilesToMessages(
      rows.map((m) => ({ id: m.id, role: m.role as "user" | "assistant", createdAt: m.createdAt, fileIds: (m.meta as { fileIds?: string[] } | null)?.fileIds })),
      files.map((f) => ({ id: f.id, kind: f.kind, createdAt: f.createdAt })),
    );
    check("…(control) without the guard the image WOULD have attached", (noGuard.byMessage.get(reply.id) ?? []).map((f) => f.id).includes(img.id));
  } finally {
    await db.conversation.delete({ where: { id: convo.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL RELOAD-DEDUP CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
