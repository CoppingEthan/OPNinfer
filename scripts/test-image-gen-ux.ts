/**
 * Live harness for the image-generation UX: the chat route must stream an
 * `image_start` event (with aspect ratio, prompt, and a learned time estimate)
 * as soon as the tool is invoked, then `image_done` (with the file id) when the
 * image is ready; the generated image is persisted in the reply's meta.images
 * and NOT duplicated as a file chip; and the file's meta records genMs so the
 * estimate learns.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-image-gen-ux.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "img-ux-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: { email: `img-ux-${Date.now()}@example.test`, passwordHash: await hashPassword(PASSWORD), role: "admin", emailVerified: new Date() },
  });
  try {
    const jar = new Map<string, string>();
    const store = (cs: string[]) => { for (const c of cs) { const p = c.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" }); store(r1.headers.getSetCookie());
    const { csrfToken } = await r1.json() as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }), redirect: "manual" });
    store(r2.headers.getSetCookie());

    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({ conversationId: null, content: "Generate a 16:9 image of a lighthouse at dusk. Use the image tool." }),
    });
    check("chat responds 200", res.status === 200, `status ${res.status}`);
    let full = ""; const reader = res.body?.getReader(); const dec = new TextDecoder();
    if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; full += dec.decode(value, { stream: true }); } }

    const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => { try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; } });
    const start = events.find((e) => e.type === "image_start") as { aspectRatio?: string; prompt?: string; estimateMs?: number; id?: string } | undefined;
    const done = events.find((e) => e.type === "image_done") as { id?: string; fileId?: string; aspectRatio?: string; prompt?: string } | undefined;

    check("streamed image_start with aspect ratio + prompt", !!start && !!start.aspectRatio && !!start.prompt, JSON.stringify(start));
    check("image_start carries a time estimate (learned or default)", typeof start?.estimateMs === "number" && (start!.estimateMs as number) > 0, `estimateMs=${start?.estimateMs}`);
    check("streamed image_done with a fileId", !!done?.fileId, JSON.stringify({ id: done?.id, fileId: done?.fileId }));
    check("start/done are linked by the same id", !!start?.id && start?.id === done?.id);
    check("no vague error in the reply", !full.includes('"type":"error"') && !full.includes('"type":"image_error"'));

    // The generated image must NOT also appear as a plain file chip.
    const fileEvents = events.filter((e) => e.type === "files").flatMap((e) => (e.files as { id: string }[]) ?? []);
    check("generated image is NOT duplicated as a file chip", done?.fileId ? !fileEvents.some((f) => f.id === done.fileId) : true, JSON.stringify(fileEvents.map((f) => f.id)));

    // Persistence + genMs learning (on the reply meta — worker-proof).
    if (done?.fileId) {
      const doneEvt = events.find((e) => e.type === "done") as { messageId?: string } | undefined;
      if (doneEvt?.messageId) {
        const msg = await db.message.findUnique({ where: { id: doneEvt.messageId } });
        const mmeta = msg?.meta as { images?: { fileId: string; prompt: string; aspectRatio: string; genMs?: number }[] } | null;
        const rec = mmeta?.images?.find((i) => i.fileId === done.fileId);
        check("reply persists meta.images (survives reload)", !!rec, JSON.stringify(mmeta?.images?.map((i) => i.fileId)));
        check("meta.images records genMs (feeds the ETA estimate)", typeof rec?.genMs === "number" && rec!.genMs! > 0, `genMs=${rec?.genMs}`);
      }
    }
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL IMAGE-UX CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("Harness error:", e); await db.$disconnect(); process.exit(1); });
