/**
 * Live harness — connected services (MCP) for the Sandbox (owner ask,
 * 2026-09-03: "one instance gets the Figma MCP, the others don't, signed in
 * inside Claude Code itself").
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-mcp.ts
 *
 * Needs the dev stack (sandboxd rebuilt with GET /agent-mcp, the
 * opninfer-agent image) and `pnpm dev`. NO model calls. Proves:
 *   - the broker reads the instance's credential volume: `claude mcp add`
 *     there (the real command, the real volume) shows up on GET /agent-mcp,
 *     as a name + type + url and a per-server "signed in" boolean — and no
 *     token material ever leaves the volume
 *   - the app's cached reader and the pure rules agree (ready only when
 *     signed in; the SDK shape is exactly {type, url})
 *   - Admin → Sandbox shows the service with its sign-in state and the
 *     per-instance setup commands
 *   - "Check connections" boots the CLI in a container WITH the server passed
 *     the way a run passes it, and the CLI itself reports the status —
 *     `needs-auth` until the owner runs the login, `connected` after
 *   - the ALERT path (owner ask 2026-09-04, "do we get emails if the link
 *     breaks?"): a bogus token planted in the dev volume makes the reader
 *     believe figma is signed in while the CLI finds it dead — Check
 *     connections must report it broken AND write the ERROR-level `agent`
 *     row the alert emails send on (with the fix named); the credentials
 *     file is restored byte-for-byte; and no unexpected service (the
 *     login's claude.ai connectors) is ever reported
 *   - removing the server (the real command again) empties the panel
 * If the volume already had `figma` (the owner signed in), it is left alone
 * and the connected path is what gets proven; otherwise the harness adds it
 * and removes it again.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { fetchAgentMcp } from "../src/lib/agent/mcp-store";
import { describeMcpServers, readyMcpServers, sdkMcpServers } from "../src/lib/agent/mcp";

try {
  process.loadEnvFile(".env");
} catch {
  /* env already present */
}

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const BROKER = (process.env.SANDBOX_BROKER_URL ?? "http://localhost:8070").replace(/\/+$/, "");
const TOKEN = process.env.SANDBOX_BROKER_TOKEN ?? "";
const VOLUME = process.env.AGENT_CONFIG_VOLUME ?? "opninfer-agent-config-default";
const IMAGE = process.env.AGENT_IMAGE ?? "opninfer-agent";
const FIGMA_URL = "https://mcp.figma.com/mcp";
const PASSWORD = "agent-mcp-1!";
const SETTING_KEY = "capability_sandbox_agent";
const DEV_LOG = "logs/dev.log";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
  if (!ok) failures++;
}

/** The REAL setup command, against the REAL dev volume. */
function claudeMcp(...args: string[]): string {
  return execFileSync(
    "docker",
    ["run", "--rm", "-v", `${VOLUME}:/home/sandbox/.claude`, IMAGE, "claude", "mcp", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function broker(fresh: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${BROKER}/agent-mcp${fresh ? "?fresh=1" : ""}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Run a node one-liner inside the agent image with the dev volume mounted
 *  (as the sandbox user, so file ownership stays right). */
function nodeInVolume(script: string): string {
  return execFileSync(
    "docker",
    ["run", "--rm", "-v", `${VOLUME}:/home/sandbox/.claude`, IMAGE, "node", "-e", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
const CRED = "/home/sandbox/.claude/.credentials.json";
/** The credentials file's exact bytes (base64), or null when absent. */
function credentialsBase64(): string | null {
  const out = nodeInVolume(
    `const fs=require("fs");const p=${JSON.stringify(CRED)};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p).toString("base64"):"NONE")`,
  ).trim();
  return out === "NONE" ? null : out;
}
/** A token entry under the key the CLI uses, with values that cannot work. */
function plantBogusFigmaToken(): void {
  nodeInVolume(
    `const fs=require("fs");const p=${JSON.stringify(CRED)};let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}` +
      `j.mcpOAuth=j.mcpOAuth||{};j.mcpOAuth["figma|d39d3b6252bc1ac5"]={serverName:"figma",serverUrl:${JSON.stringify(FIGMA_URL)},` +
      `accessToken:"bogus-access",refreshToken:"bogus-refresh",clientId:"bogus-client",clientSecret:"bogus-secret",expiresAt:1};` +
      `fs.writeFileSync(p,JSON.stringify(j),{mode:0o600})`,
  );
}
function restoreCredentials(b64: string | null): void {
  nodeInVolume(
    b64 === null
      ? `const fs=require("fs");try{fs.unlinkSync(${JSON.stringify(CRED)})}catch{}`
      : `const fs=require("fs");fs.writeFileSync(${JSON.stringify(CRED)},Buffer.from(${JSON.stringify(b64)},"base64"),{mode:0o600})`,
  );
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
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

/** dev.log since a byte offset — sliced as a BUFFER (multi-byte glyphs). */
function devLogSince(offset: number): string {
  try {
    return readFileSync(DEV_LOG).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

async function main() {
  if (!TOKEN) throw new Error("SANDBOX_BROKER_TOKEN missing from .env");

  // 1. The broker endpoint exists and answers.
  const first = await broker(true);
  check("broker answers GET /agent-mcp", first.status === 200, JSON.stringify(first.body).slice(0, 200));
  const servers0 = (first.body.servers ?? {}) as Record<string, unknown>;
  const hadFigma = !!servers0.figma;
  console.log(hadFigma ? "  (figma already set up in the volume — leaving it alone)" : "  (adding figma to the dev volume for the test)");
  let added = false;
  if (!hadFigma) {
    const out = claudeMcp("add", "--transport", "http", "-s", "user", "figma", FIGMA_URL);
    added = true;
    check("`claude mcp add` in the volume succeeded", /Added HTTP MCP server figma/.test(out), out);
  }

  // Capability must be ON for the page; remember what it was.
  const prior = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  const priorValue = (prior?.value ?? null) as { enabled?: boolean; config?: Record<string, unknown> } | null;
  if (!priorValue?.enabled) {
    await db.setting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: { enabled: true, config: priorValue?.config ?? {} } },
      update: { value: { enabled: true, config: priorValue?.config ?? {} } },
    });
  }
  const admin = await db.user.create({
    data: {
      email: `agent-mcp-${Date.now()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  const browser = await chromium.launch();
  try {
    // 2. The broker reports the server, its shape, and a boolean — no secrets.
    const b = await broker(true);
    const figma = ((b.body.servers ?? {}) as Record<string, { type?: string; url?: string }>).figma;
    check("broker lists figma as an http server with the Figma URL", figma?.type === "http" && figma?.url === FIGMA_URL, JSON.stringify(figma));
    const oauth = (b.body.oauth ?? {}) as Record<string, unknown>;
    const signed = oauth.figma === true;
    check("broker reports a per-server signed-in boolean", oauth.figma === undefined || typeof oauth.figma === "boolean", JSON.stringify(oauth));
    const raw = JSON.stringify(b.body);
    check("no token material leaves the volume", !/accessToken|refreshToken|clientSecret|clientId/.test(raw), raw.slice(0, 200));
    console.log(`  figma signed in: ${signed}`);

    // 3. The app's reader + the pure rules.
    const state = await fetchAgentMcp({ fresh: true });
    check("app reader sees figma", !!state.servers.figma, JSON.stringify(state).slice(0, 200));
    check("ready only when signed in", readyMcpServers(state).includes("figma") === signed, readyMcpServers(state).join(","));
    check("prompt line names it only when signed in", describeMcpServers(state).includes("figma") === signed, describeMcpServers(state));
    check("SDK shape is exactly {type, url} (what the CLI keys the sign-in by)", JSON.stringify(sdkMcpServers(state, { all: true }).figma) === JSON.stringify({ type: "http", url: FIGMA_URL }));

    // 4. Admin → Sandbox shows it.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(await signIn(admin.email));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/sandbox`, { waitUntil: "domcontentloaded" });
    check("Connected services panel present", (await page.locator("[data-agent-mcp]").count()) === 1);
    const row = page.locator("[data-agent-mcp-server='figma']");
    check("figma row shown", (await row.count()) === 1);
    check("row carries the sign-in state", (await row.getAttribute("data-agent-mcp-auth")) === (signed ? "ready" : "needs-sign-in"), String(await row.getAttribute("data-agent-mcp-auth")));
    // textContent, not innerText: the setup notes sit in a collapsed <details>, which innerText omits.
    const panelText = ((await page.locator("[data-agent-mcp]").textContent()) ?? "").replace(/\s+/g, " ");
    check("setup instructions use Claude Code's own commands", /claude mcp add|agent-mcp .* add figma/.test(panelText) && /login figma/.test(panelText), panelText.slice(0, 200));

    // 5. Check connections: the CLI, inside a container, given the server the
    //    way a run is given it, reports the truth.
    const logOffset = (() => {
      try {
        return statSync(DEV_LOG).size;
      } catch {
        return 0;
      }
    })();
    await page.getByRole("button", { name: "Check connections" }).click();
    await page.waitForSelector("[data-agent-mcp-server='figma'][data-agent-mcp-status]", { timeout: 120_000 });
    const status = await row.getAttribute("data-agent-mcp-status");
    const rowText = (await row.innerText()).replace(/\s+/g, " ");
    const expected = signed ? "connected" : "needs-auth";
    check(`CLI reports the server as ${expected}`, status === expected, `${status} · ${rowText}`);
    const log = devLogSince(logOffset);
    check("the CLI was spawned with an MCP config (our servers reached the container)", /mcp-config/.test(log), log.match(/spawn \(.{0,400}/)?.[0]?.slice(0, 300) ?? "(no spawn line found)");

    // 5b. The alert path — only when we added figma ourselves (no real
    //     sign-in to disturb). Plant a bogus token so the reader believes
    //     figma is signed in while the CLI finds it dead; the credentials
    //     file goes back byte-for-byte whatever happens.
    if (added) {
      const original = credentialsBase64();
      try {
        plantBogusFigmaToken();
        const b2 = await broker(true);
        check("bogus token planted: the reader now believes figma is signed in", ((b2.body.oauth ?? {}) as Record<string, unknown>).figma === true, JSON.stringify(b2.body.oauth));
        await page.reload({ waitUntil: "domcontentloaded" });
        check("page shows figma as signed in", (await row.getAttribute("data-agent-mcp-auth")) === "ready", String(await row.getAttribute("data-agent-mcp-auth")));
        const since = new Date();
        await page.getByRole("button", { name: "Check connections" }).click();
        await page.waitForSelector("[data-agent-mcp-server='figma'][data-agent-mcp-status]", { timeout: 120_000 });
        const st2 = await row.getAttribute("data-agent-mcp-status");
        check("the CLI reports the dead sign-in as broken", st2 === "needs-auth" || st2 === "failed", String(st2));
        const rows = await db.appLog.findMany({
          where: { level: "error", category: "agent", createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
        });
        const hit = rows.find((r) => /connected service "figma"/.test(r.message));
        check("an ERROR-level agent row was written — what the alert email sends on", !!hit, hit?.message ?? rows.map((r) => r.message).join(" | ").slice(0, 200));
        check("…and it names the fix", !!hit && /login figma/.test(JSON.stringify(hit.details ?? {})), JSON.stringify(hit?.details ?? {}).slice(0, 200));
        check("no unexpected service reported (the login's claude.ai connectors stay out)", (await page.locator("[data-agent-mcp-unexpected]").count()) === 0);
      } finally {
        restoreCredentials(original);
        const b3 = await broker(true);
        check("credentials restored (figma no longer reads as signed in)", ((b3.body.oauth ?? {}) as Record<string, unknown>).figma !== true);
      }
    }

    // 6. Remove (if we added it) — the real command — and the panel empties.
    if (added) {
      claudeMcp("remove", "-s", "user", "figma");
      added = false;
      const after = await broker(true);
      check("after `claude mcp remove`, the broker no longer lists figma", !((after.body.servers ?? {}) as Record<string, unknown>).figma);
      await page.reload({ waitUntil: "domcontentloaded" });
      const others = Object.keys((after.body.servers ?? {}) as Record<string, unknown>).length;
      check(
        others === 0 ? "panel shows none set up" : "panel no longer shows figma",
        others === 0 ? (await page.locator("[data-agent-mcp-empty]").count()) === 1 : (await page.locator("[data-agent-mcp-server='figma']").count()) === 0,
      );
    }
    await ctx.close();
  } finally {
    await browser.close();
    if (added) {
      try {
        claudeMcp("remove", "-s", "user", "figma");
      } catch {
        /* best effort */
      }
    }
    if (!priorValue?.enabled) {
      if (prior) await db.setting.update({ where: { key: SETTING_KEY }, data: { value: priorValue as object } });
      else await db.setting.delete({ where: { key: SETTING_KEY } }).catch(() => {});
    }
    await db.user.delete({ where: { id: admin.id } }).catch(() => {});
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
