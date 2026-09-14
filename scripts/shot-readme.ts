/**
 * The screenshot on the README's front page.
 *
 * Seeds a small, entirely fictional workspace — a made-up company's assistant,
 * a handful of chats in the sidebar, and one open conversation — then shoots
 * the chat screen in light and dark. No model is called: the reply is written
 * into the database, so this is reproducible, free, and cannot accidentally
 * capture anything real.
 *
 * Everything it creates is deleted afterwards, including on a crash. It runs
 * its own dev server on its own port and its own NEXT_DIST_DIR, so it does not
 * disturb one you already have open (see the NEXT_DIST_DIR gotcha in
 * CLAUDE.md — Next rewrites next-env.d.ts and tsconfig.json to match, and both
 * are snapshotted and put back).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/shot-readme.ts
 *
 * Writes .github/assets/screenshot-{light,dark}.png.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const PORT = Number(process.env.SHOT_PORT ?? 3014);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "readme-shot-1!";
const OUT = path.resolve(".github/assets");

/** A fictional company, so the picture shows the product rather than a client. */
const COMPANY = "Acme";
const ASSISTANT = `${COMPANY} AI`;

/** The sidebar. Emoji + 2–5 words, sentence case — the locked title format. */
const SIDEBAR = [
  "📊 Q3 channel performance",
  "🧾 Expense policy rewrite",
  "🗓️ Team offsite outline",
  "🔍 Competitor pricing scan",
  "📦 Supplier onboarding pack",
];

const OPEN_TITLE = "✉️ Support rota announcement";

const ASK =
  "We're moving the support inbox onto a weekly rota instead of whoever gets to it first. Draft a short note to the team — friendly, not corporate.";

const REPLY = `Here's a note you can send as it stands.

**Subject — support@ is moving to a weekly rota**

Hi all,

From Monday the 22nd, the support inbox stops being "whoever sees it first" and
moves onto a weekly rota. Three things change, and none of them should create
work for you outside your week:

- **One owner per week.** Whoever is on rota clears the inbox twice a day — once
  first thing, once mid-afternoon — and nothing else in the inbox is anyone
  else's problem that week.
- **Escalations have somewhere to go.** Anything you can't answer in ten minutes
  gets tagged \`needs-specialist\` and posted in #support-help rather than sitting
  unanswered while you work out who owns it.
- **Handover is written down.** At the end of your week, leave a two-line note
  on anything still open. That's the whole handover.

The rota for the next six weeks is on the team calendar. If your week clashes
with something, swap it with whoever you like and just update the calendar —
no need to ask.

Thanks,
Jo

---

Want me to shorten it for Slack, or add a line about out-of-hours cover?`;

/**
 * Next REWRITES next-env.d.ts and tsconfig.json to match distDir on every dev
 * start, which would leave them pointing at a git-ignored directory that does
 * not exist on a fresh checkout — and tsc then fails in CI for a reason nothing
 * in the diff explains. Snapshot both and put them back.
 */
function snapshotNextFiles(): () => void {
  const files = ["next-env.d.ts", "tsconfig.json"];
  const before = files.map((f) => [f, readFileSync(f, "utf8")] as const);
  return () => {
    for (const [f, text] of before) {
      try {
        if (readFileSync(f, "utf8") !== text) writeFileSync(f, text);
      } catch {
        /* nothing worth failing the run over */
      }
    }
  };
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function signIn(email: string) {
  const jar = new Map<string, string>();
  const store = (cs: string[]) => {
    for (const c of cs) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
  store(r1.headers.getSetCookie());
  const { csrfToken } = (await r1.json()) as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const restoreNextFiles = snapshotNextFiles();
  const stamp = Date.now();
  const email = `jo.taylor+shot${stamp}@example.test`;

  // Remember what the instance's assistant is called, so a dev box that is set
  // up for something else is handed back exactly as it was found.
  const priorAssistant = await db.setting.findUnique({ where: { key: "assistant_config" } });

  const user = await db.user.create({
    data: {
      email,
      name: "Jo Taylor",
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
      // Or the What's-new panel covers the screen (the documented gotcha).
      lastSeenVersion: "9.9.9",
    },
  });

  // Sidebar filler, oldest first so the open chat sorts to the top.
  const base = stamp - 6 * 3_600_000;
  for (const [i, title] of SIDEBAR.entries()) {
    await db.conversation.create({
      data: {
        userId: user.id,
        title,
        createdAt: new Date(base + i * 600_000),
        updatedAt: new Date(base + i * 600_000),
      },
    });
  }

  const convo = await db.conversation.create({
    data: { userId: user.id, title: OPEN_TITLE },
  });
  // Strictly increasing createdAt — a tie is broken by whatever Postgres's
  // sort does that day (the tie gotcha in CLAUDE.md).
  await db.message.create({
    data: {
      conversationId: convo.id,
      userId: user.id,
      role: "user",
      content: ASK,
      createdAt: new Date(stamp),
    },
  });
  await db.message.create({
    data: {
      conversationId: convo.id,
      role: "assistant",
      content: REPLY,
      createdAt: new Date(stamp + 1_000),
    },
  });

  const server = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "dev", "--port", String(PORT)],
    {
      cwd: process.cwd(),
      env: { ...process.env, NEXT_DIST_DIR: ".next-harness", AUTH_URL: "" },
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  );

  try {
    await db.setting.upsert({
      where: { key: "assistant_config" },
      create: { key: "assistant_config", value: { name: ASSISTANT } },
      update: { value: { ...((priorAssistant?.value as object) ?? {}), name: ASSISTANT } },
    });

    if (!(await waitFor(`${BASE}/login`, 240_000))) throw new Error("dev server never started");
    const cookies = await signIn(email);

    const browser = await chromium.launch();
    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2, // a crisp image on a retina/HiDPI display
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      // NEVER networkidle on /chat — the live feed holds a request open for
      // the life of the tab, so it can never fire.
      await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-chat-scroll]", { timeout: 90_000 });
      // `next dev` floats its own dev-tools badge over the bottom-left corner,
      // which lands squarely on the account row and reads as a broken avatar.
      // It is not part of the app and never ships, so take it out of the shot.
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.waitForTimeout(4_000); // let the reply render and settle
      const file = path.join(OUT, `screenshot-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`wrote ${file}`);
      await ctx.close();
    }
    await browser.close();
  } finally {
    if (process.platform === "win32" && server.pid) {
      spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
    restoreNextFiles();
    // Put the instance back exactly as it was found.
    if (priorAssistant) {
      await db.setting.update({
        where: { key: "assistant_config" },
        data: { value: priorAssistant.value as object },
      });
    } else {
      await db.setting.deleteMany({ where: { key: "assistant_config" } });
    }
    await db.conversation.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
  process.exit(0);
}

void main();
