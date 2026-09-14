/** Smoke test: /api/files/:id/context returns the SAME text read_file would
 *  hand the model (minus the pagination header, which is a tool-call
 *  mechanic, not a content difference), and is owner-gated.
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-file-context-view.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { executeFileTool } from "../src/lib/file-tools";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "file-context-smoke-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.slice(0, 150)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const owner = await db.user.create({
    data: {
      email: `file-context-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  const other = await db.user.create({
    data: {
      email: `file-context-other-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
    },
  });

  try {
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

    const ownerCookie = await login(owner.email);
    const otherCookie = await login(other.email);

    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(path.resolve("test-kit/files/notes.md"))]), "notes.md");
    const uploadRes = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: { cookie: ownerCookie() },
      body: form,
    });
    const uploaded = await uploadRes.json();
    check("uploaded notes.md", uploadRes.status === 200, JSON.stringify(uploaded).slice(0, 150));

    await new Promise((r) => setTimeout(r, 6000));

    const ctxRes = await fetch(`${BASE}/api/files/${uploaded.id}/context`, {
      headers: { cookie: ownerCookie() },
    });
    const ctx = await ctxRes.json();
    check("owner can view context (200)", ctxRes.status === 200, `status ${ctxRes.status}`);
    check("content is non-null and looks right", typeof ctx.content === "string" && ctx.content.includes("granary-2026"), ctx.content?.slice(0, 100));

    const toolResult = await executeFileTool(uploaded.conversationId, "read_file", JSON.stringify({ name: "notes.md" }));
    const toolText = typeof toolResult === "string" ? toolResult : toolResult.text;
    check(
      "matches read_file's own output (content, ignoring any pagination header)",
      toolText.trim() === ctx.content.trim() || toolText.includes(ctx.content.trim()),
      `tool=${toolText.slice(0, 80)} api=${ctx.content?.slice(0, 80)}`,
    );
    check(
      "read_file reports the file as a source (kind=file)",
      typeof toolResult !== "string" &&
        toolResult.sources?.[0]?.kind === "file" &&
        toolResult.sources?.[0]?.fileId === uploaded.id,
      JSON.stringify(typeof toolResult === "string" ? null : toolResult.sources),
    );

    const otherRes = await fetch(`${BASE}/api/files/${uploaded.id}/context`, {
      headers: { cookie: otherCookie() },
    });
    check("a different user is denied (404, not leaked)", otherRes.status === 404, `status ${otherRes.status}`);

    // The edge middleware (src/middleware.ts) redirects every unauthenticated
    // request to /login before it reaches this route's own auth() check —
    // same protection as the existing download route. Must not auto-follow.
    const anonRes = await fetch(`${BASE}/api/files/${uploaded.id}/context`, { redirect: "manual" });
    check(
      "unauthenticated is redirected to /login (not served)",
      anonRes.status === 307 && (anonRes.headers.get("location") ?? "").includes("/login"),
      `status ${anonRes.status} location ${anonRes.headers.get("location")}`,
    );
  } finally {
    await db.user.delete({ where: { id: owner.id } }).catch(() => {});
    await db.user.delete({ where: { id: other.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
