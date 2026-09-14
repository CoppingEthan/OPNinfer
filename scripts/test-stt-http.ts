/**
 * Live STT smoke (NOT in the test suite). Requires the dev server (with
 * WHISPER_URL in .env) + the whisper container (`--profile heavy`, port 9000
 * on loopback):
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; $env:FIXTURES_DIR='…'
 *   node --env-file=.env --import tsx scripts/test-stt-http.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const PASSWORD = "stt-smoke-pw-6644!";
const FIXTURES = process.env.FIXTURES_DIR ?? "";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  let userId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `stt-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;

    // login
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
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie(),
      },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());
    check("login", [...jar.keys()].some((k) => k.includes("session-token")));

    // anonymous is blocked
    const anonFd = new FormData();
    anonFd.append("audio", new File([Buffer.from([1])], "x.webm"));
    const anon = await fetch(`${BASE}/api/stt`, { method: "POST", body: anonFd, redirect: "manual" });
    check("anonymous /api/stt blocked", anon.status === 401 || anon.status === 307, `status ${anon.status}`);

    // real speech through the route
    const wav = readFileSync(join(FIXTURES, "speech.wav"));
    const fd = new FormData();
    fd.append("audio", new File([wav as unknown as BlobPart], "dictation.wav", { type: "audio/wav" }));
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/stt`, {
      method: "POST",
      body: fd,
      headers: { cookie: cookie() },
    });
    const data = (await res.json()) as { text?: string; language?: string; error?: string };
    check("authenticated /api/stt → 200", res.status === 200, data.error ?? "");
    const text = (data.text ?? "").toLowerCase();
    check(
      "transcript contains the spoken words",
      text.includes("successful") && text.includes("transcription"),
      `${Math.round((Date.now() - t0) / 100) / 10}s: "${data.text ?? ""}"`,
    );
    check("language detected", data.language === "en", String(data.language));

    // no audio → 400
    const empty = await fetch(`${BASE}/api/stt`, {
      method: "POST",
      body: new FormData(),
      headers: { cookie: cookie() },
    });
    check("missing audio → 400", empty.status === 400, `status ${empty.status}`);
  } finally {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
    console.log("\nCleaned up throwaway user.");
  }

  console.log(`\n${failures === 0 ? "ALL STT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
