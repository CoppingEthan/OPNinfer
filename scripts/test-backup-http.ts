/**
 * Authenticated HTTP smoke for the backup admin surface (NOT in the test suite).
 * Drives the REAL running dev server through a genuine admin session so Next
 * actually compiles + serves the new page and API routes.
 *
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
 *   node --env-file=.env --import tsx scripts/test-backup-http.ts
 *
 * A throwaway admin user is created and deleted in a `finally`, so no existing
 * account is touched.
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const BASE = process.env.TEST_BASE_URL ?? "https://localhost:3000";
const EMAIL = `backup-smoke-${Date.now()}@example.test`;
const PASSWORD = "smoke-test-pw-9137!";

const jar = new Map<string, string>();
function store(setCookies: string[]) {
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i < 0) continue;
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () =>
  [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function login() {
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
  store(r1.headers.getSetCookie());
  const { csrfToken } = (await r1.json()) as { csrfToken: string };

  const body = new URLSearchParams({
    csrfToken,
    email: EMAIL,
    password: PASSWORD,
    callbackUrl: `${BASE}/admin/backups`,
  });
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(),
    },
    body,
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar.keys()].some((k) => k.includes("session-token"));
}

async function main() {
  let userId: string | null = null;
  try {
    const user = await db.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "admin",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    console.log(`Created throwaway admin ${EMAIL}\n`);

    // Unauthenticated: middleware should redirect (not 500/200).
    const anon = await fetch(`${BASE}/admin/backups`, { redirect: "manual" });
    check("unauthenticated /admin/backups is redirected", anon.status === 307, `status ${anon.status}`);

    const loggedIn = await login();
    check("admin credentials login succeeds", loggedIn);
    if (!loggedIn) throw new Error("login failed — aborting authed checks");

    // Authenticated page render.
    const page = await fetch(`${BASE}/admin/backups`, {
      headers: { cookie: cookieHeader() },
      redirect: "manual",
    });
    const html = await page.text();
    check("GET /admin/backups renders (200)", page.status === 200, `status ${page.status}`);
    check(
      "page contains backup UI",
      html.includes("Automatic backups") && html.includes("Restore from a zip"),
    );

    // Download route: bad name → 400, missing → 404.
    const bad = await fetch(`${BASE}/api/admin/backup/not-a-zip`, {
      headers: { cookie: cookieHeader() },
      redirect: "manual",
    });
    check("download rejects invalid name (400)", bad.status === 400, `status ${bad.status}`);

    const missing = await fetch(`${BASE}/api/admin/backup/opninfer-backup-00000000000000-0000.zip`, {
      headers: { cookie: cookieHeader() },
      redirect: "manual",
    });
    check("download of missing backup (404)", missing.status === 404, `status ${missing.status}`);

    // Restore route: no file → 400 with JSON error.
    const noFile = await fetch(`${BASE}/api/admin/backup/restore`, {
      method: "POST",
      headers: { cookie: cookieHeader() },
      body: new FormData(),
      redirect: "manual",
    });
    const noFileJson = (await noFile.json().catch(() => ({}))) as { error?: string };
    check(
      "restore with no file (400 + error)",
      noFile.status === 400 && !!noFileJson.error,
      noFileJson.error ?? `status ${noFile.status}`,
    );
  } finally {
    if (userId) {
      await db.user.delete({ where: { id: userId } }).catch(() => {});
      console.log(`\nRemoved throwaway admin ${EMAIL}`);
    }
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL HTTP CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
