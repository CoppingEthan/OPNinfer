/**
 * Live harness: attachments render on the MESSAGE they were sent with (not
 * pinned above the composer), and survive a reload. Reproduces the owner's
 * two-turn shape: a plain turn, then a turn with an image + a PDF attached.
 * Verifies (a) the chat route saves meta.fileIds on the user turn, (b) the
 * conversation loader re-associates them to that turn, (c) generated files
 * from a tool ride the assistant reply.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-message-files-http.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { attachFilesToMessages } from "../src/lib/message-files";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "msgfiles-smoke-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `msgfiles-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });

  try {
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
    check("logged in", r2.status === 302 || r2.status === 200);

    async function chat(conversationId: string | null, content: string, fileIds?: string[]) {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { cookie: cookie(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId, content, fileIds }),
      });
      let full = "";
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += decoder.decode(value, { stream: true });
        }
      }
      const cid = full.match(/"conversationId":"([^"]+)"/)?.[1] ?? conversationId;
      return { full, conversationId: cid };
    }

    // Turn 1: no files.
    const t1 = await chat(null, "hey there, what is 2+2?");
    const convId = t1.conversationId!;
    check("turn 1 created the conversation", !!convId);

    // Upload an image + a PDF into that conversation (like the owner did).
    const testKit = path.resolve("test-kit/files");
    async function upload(filename: string) {
      const buf = fs.readFileSync(path.join(testKit, filename));
      const form = new FormData();
      form.append("file", new Blob([buf]), filename);
      const res = await fetch(`${BASE}/api/files?conversationId=${convId}`, {
        method: "POST",
        headers: { cookie: cookie() },
        body: form,
      });
      return (await res.json()).id as string;
    }
    const pngId = await upload("photo.png");
    const pdfId = await upload("report.pdf");
    check("uploaded png + pdf", !!pngId && !!pdfId);

    // Turn 2: send WITH the two attachments.
    await chat(convId, "What do you see here?", [pngId, pdfId]);

    // Server: the user turn stored meta.fileIds.
    const userTurns = await db.message.findMany({
      where: { conversationId: convId, role: "user" },
      orderBy: { createdAt: "asc" },
    });
    const secondTurn = userTurns[1];
    const savedIds = (secondTurn?.meta as { fileIds?: string[] } | null)?.fileIds ?? [];
    check(
      "user turn 2 saved meta.fileIds = [png, pdf]",
      savedIds.includes(pngId) && savedIds.includes(pdfId),
      JSON.stringify(savedIds),
    );
    check("user turn 1 has NO files", !(userTurns[0]?.meta as { fileIds?: string[] } | null)?.fileIds);

    // Loader: files re-associate to the 2nd user turn, none pending.
    const convo = await db.conversation.findUnique({
      where: { id: convId },
      include: { messages: { orderBy: { createdAt: "asc" } }, files: true },
    });
    const { byMessage, pending } = attachFilesToMessages(
      convo!.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          createdAt: m.createdAt,
          fileIds: (m.meta as { fileIds?: string[] } | null)?.fileIds,
        })),
      convo!.files.map((f) => ({ id: f.id, kind: f.kind, createdAt: f.createdAt })),
    );
    check("loader attaches both files to the 2nd user turn", (byMessage.get(secondTurn.id) ?? []).length === 2, `${byMessage.get(secondTurn.id)?.length}`);
    check("loader leaves nothing pinned above the composer (0 pending)", pending.length === 0, `pending=${pending.length}`);

    // Generated file rides the assistant reply.
    const gen = await chat(convId, "Write a file called hello.txt containing the word BANANA, using the sandbox.");
    const genFile = await db.file.findFirst({
      where: { conversationId: convId, kind: "generated" },
      orderBy: { createdAt: "desc" },
    });
    check("assistant generated a file", !!genFile, genFile?.filename);
    check("generated-file chip streamed on the reply (files SSE)", gen.full.includes('"type":"files"') && (genFile ? gen.full.includes(genFile.id) : false));
    const lastAssistant = await db.message.findFirst({
      where: { conversationId: convId, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    const replyFileIds = (lastAssistant?.meta as { fileIds?: string[] } | null)?.fileIds ?? [];
    check("assistant reply persisted its generated fileIds", genFile ? replyFileIds.includes(genFile.id) : false, JSON.stringify(replyFileIds));
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL MESSAGE-FILE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
