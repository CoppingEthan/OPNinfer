/**
 * Regression harness for the Anthropic tool_use/tool_result ordering bug:
 * when a single round calls an image-carrying tool (view_image) alongside
 * another tool (read_file), the synthetic "image attached" user turn used to
 * land BETWEEN the two tool_result blocks in the merged Anthropic message —
 * Anthropic requires all tool_results contiguous at the front, so the second
 * one was orphaned → 400 "tool_use ids were found without tool_result blocks
 * immediately after". Fixed in src/lib/providers/anthropic.ts
 * (toAnthropicMessages) by stable-sorting tool_result blocks to the front of
 * each merged user turn. This harness drives the real chat route end-to-end
 * with an image + a PDF so both tools fire in the same round.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-anthropic-multi-tool.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "multitool-smoke-pw-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 150)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = await db.user.create({
    data: {
      email: `multitool-smoke-${Date.now()}@example.test`,
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
    check("logged in", r2.status === 302 || r2.status === 200, `status ${r2.status}`);

    const testKit = path.resolve("test-kit/files");
    let convoId: string | null = null;

    async function uploadFile(filename: string) {
      const filePath = path.join(testKit, filename);
      const buf = fs.readFileSync(filePath);
      const url = convoId ? `${BASE}/api/files?conversationId=${convoId}` : `${BASE}/api/files`;
      const form = new FormData();
      form.append("file", new Blob([buf]), filename);
      const res = await fetch(url, { method: "POST", headers: { cookie: cookie() }, body: form });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.conversationId) convoId = json.conversationId;
      return res.status;
    }

    check("upload photo.png", (await uploadFile("photo.png")) === 200);
    check("upload report.pdf", (await uploadFile("report.pdf")) === 200);

    // Give the worker time to ingest both files before the model reads them.
    await new Promise((r) => setTimeout(r, 9000));

    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { cookie: cookie(), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: convoId,
        content: "What do you see in image and what is in the pdf?",
      }),
    });
    check("chat route responds 200", chatRes.status === 200, `status ${chatRes.status}`);

    const reader = chatRes.body?.getReader();
    const decoder = new TextDecoder();
    let full = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
      }
    }

    check(
      "both tools fired in one round",
      full.includes("photo.png") && full.includes("report.pdf") && full.includes('"type":"tool"'),
    );
    check("no tool_use/tool_result 400", !/tool_use.*tool_result/i.test(full), full.match(/"error":"[^"]*"/)?.[0]);
    check("no error event at all", !full.includes('"type":"error"'), full.match(/"error":"[^"]*"/)?.[0]);
    check("answer read the image", /sunflower/i.test(full));
    check("answer read the pdf", full.includes("12,987.65") || full.includes("INV-2091"));
    check(
      "read files surfaced as kind=file sources",
      full.includes('"kind":"file"') && full.includes('"type":"sources"'),
    );
  } finally {
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
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
