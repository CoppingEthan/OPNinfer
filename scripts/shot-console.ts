/**
 * Screenshot every operator-console page, light and dark, for eyeballing.
 *
 * Same trick as `test-console.ts`: a second dev server with
 * OPNINFER_MODE=console and its own NEXT_DIST_DIR, pointed at the local dev
 * database. It is listed three times under different names so the per-portal
 * tables and the "one shared plan" comparison have something to show — the
 * numbers are the same database three times over, which is fine for looking
 * at layout and useless for anything else.
 *
 * Needs the `console_ro` role to exist locally: run `scripts/test-console.ts`
 * once first, which creates it.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/shot-console.ts
 *
 * Writes into logs/ (git-ignored).
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashPassword } from "../src/lib/hash";

const PORT = Number(process.env.CONSOLE_SHOT_PORT ?? 3012);
const BASE = `http://localhost:${PORT}`;
const OPERATOR = "shot@example.test";
const PASSWORD = "console-shot-1!";
const RO_PASSWORD = process.env.CONSOLE_RO_PASSWORD ?? "consoleHarnessRoPw";
const OUT = path.resolve("logs");

const PAGES = [
  ["overview", "/console"],
  ["usage", "/console/usage"],
  ["people", "/console/users"],
  ["activity", "/console/activity"],
  ["feedback", "/console/feedback"],
  ["sandbox", "/console/sandbox"],
  ["logs", "/console/logs"],
] as const;

/**
 * Next REWRITES `next-env.d.ts` and `tsconfig.json` to match `distDir` on
 * every dev start, so running the console server points them at
 * `.next-console` — a git-ignored directory that does not exist on a fresh
 * checkout, which would then fail `tsc`. Snapshot both and put them back.
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

function readOnlyUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = "console_ro";
  u.password = RO_PASSWORD;
  return u.toString();
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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const restoreNextFiles = snapshotNextFiles();
  const hash = await hashPassword(PASSWORD);
  const url = readOnlyUrl();

  const server = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "dev", "--port", String(PORT)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_DIST_DIR: ".next-console",
        OPNINFER_MODE: "console",
        OPNINFER_INSTANCE: "console",
        CONSOLE_OPERATORS: `${OPERATOR}:${hash}`,
        CONSOLE_INSTANCES: "acme globex northwind",
        CONSOLE_DB_ACME: url,
        CONSOLE_LABEL_ACME: "chat.acme.example",
        CONSOLE_DB_GLOBEX: url,
        CONSOLE_LABEL_GLOBEX: "ai.globex.example",
        CONSOLE_DB_NORTHWIND: url,
        CONSOLE_LABEL_NORTHWIND: "ai.northwind.example",
        AUTH_URL: "",
      },
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  );

  try {
    if (!(await waitFor(`${BASE}/login`, 180_000))) throw new Error("console never started");
    const browser = await chromium.launch();
    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('input[name="email"]', { timeout: 60_000 });
      await page.fill('input[name="email"]', OPERATOR);
      await page.fill('input[name="password"]', PASSWORD);
      await Promise.all([
        page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
        page.click('button[type="submit"]'),
      ]);
      for (const [name, route] of PAGES) {
        await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
        // The live pages fetch after mount; give them a beat to fill in.
        await page.waitForTimeout(3_500);
        const file = path.join(OUT, `console-${name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`wrote ${file}`);
      }
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
  }
  process.exit(0);
}

void main();
