/**
 * Live proof for the Sandbox's long-lived token (2026-09-07, owner ask:
 * "it's annoying we get signed out all the time").
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-agent-token.ts
 *
 * The problem it fixes: the container volume login is a refreshing pair every
 * chat shares, so at each ~8-hour expiry whichever chat refreshes first
 * rotates the token out from under the others — a burst of failed runs and
 * alert emails, then quiet again. A `claude setup-token` token never
 * refreshes, so there is nothing to race over.
 *
 * The decisive question is NOT "does the variable get set" — a unit test can
 * answer that. It is "does the CLI inside the real container authenticate
 * with OUR token rather than the login sitting right beside it". So the
 * checks below run the true path (buildAgentEnv → makeAgentSpawner → the
 * broker's duplex attach → the container's own pinned CLI) with a token that
 * is deliberately INVALID: if the run fails on auth while the volume login is
 * present and working, the token is provably what was used. A run with no
 * token must still succeed on that same login — the check that stops this
 * becoming a one-way change.
 *
 * Needs: the dev sandboxd + the opninfer-agent image, and the volume login
 * (./deploy.sh agent-login, or the docker run … claude form in dev).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentOauthToken, agentTokenSource, buildAgentEnv } from "../src/lib/agent/env";
import { planUsageAge } from "../src/lib/agent/limits";
import { makeAgentSpawner, destroyAgentContainer } from "../src/lib/agent/spawn";

try {
  process.loadEnvFile(".env");
} catch {
  /* already in env */
}

const ROOT = process.cwd();
let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures++;
}

/** Shaped exactly like a real token, and cannot possibly work. */
const BOGUS = "sk-ant-oat01-NOTAREALTOKEN_0123456789abcdefghij";

function setEnvToken(v: string | undefined, opts: { b64?: boolean } = {}) {
  delete process.env.AGENT_OAUTH_TOKEN;
  delete process.env.AGENT_OAUTH_TOKEN_B64;
  if (v === undefined) return;
  if (opts.b64) process.env.AGENT_OAUTH_TOKEN_B64 = Buffer.from(v).toString("base64");
  else process.env.AGENT_OAUTH_TOKEN = v;
}

/** One real run in a real container. Returns everything the CLI said. */
async function runInContainer(
  convId: string,
  oauthToken: string | undefined,
  plantInStateDir?: string,
) {
  const pool = join(ROOT, "storage", "default", "chats", convId);
  const state = join(ROOT, "storage", "default", "agent", convId);
  mkdirSync(pool, { recursive: true });
  mkdirSync(state, { recursive: true });
  // Stands in for what the CLI leaves behind: the broker reads this path out
  // of the container at start and decides whether to carry it back.
  if (plantInStateDir !== undefined) {
    writeFileSync(join(state, ".credentials.json"), plantInStateDir);
  }
  const abort = new AbortController();
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "Reply with exactly: OK" },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage;
    await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r(), { once: true }));
  }
  let words = "";
  let ok = false;
  try {
    const q = query({
      prompt: input(),
      options: {
        cwd: "/workspace",
        env: buildAgentEnv({
          credential: "subscription",
          base: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/sandbox", LANG: "C.UTF-8" },
          configDir: "/home/sandbox/.claude",
          oauthToken,
        }),
        spawnClaudeCodeProcess: makeAgentSpawner(convId) as never,
        abortController: abort,
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
      },
    });
    for await (const m of q) {
      const msg = m as Record<string, unknown>;
      if (msg.type === "assistant") {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if ((b as { type?: string }).type === "text") {
              words += `${String((b as { text?: string }).text ?? "")}\n`;
            }
          }
        }
      } else if (msg.type === "result") {
        ok = msg.subtype === "success" && msg.is_error !== true;
        const errors = Array.isArray(msg.errors) ? msg.errors.map(String).join("\n") : "";
        words += `${typeof msg.result === "string" ? msg.result : errors}\n`;
        break;
      }
    }
  } catch (e) {
    words += `${e instanceof Error ? e.message : String(e)}\n`;
  } finally {
    abort.abort();
    destroyAgentContainer(convId);
    rmSync(pool, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
  return { ok, words: words.trim() };
}

async function main() {
  if (!process.env.SANDBOX_BROKER_URL || !process.env.SANDBOX_BROKER_TOKEN) {
    console.error("SANDBOX_BROKER_URL / SANDBOX_BROKER_TOKEN missing — is the dev stack up?");
    process.exit(1);
  }
  const saved = {
    plain: process.env.AGENT_OAUTH_TOKEN,
    b64: process.env.AGENT_OAUTH_TOKEN_B64,
  };

  try {
    // --- 1. What the app believes is configured ---------------------------
    setEnvToken(undefined);
    check("no token configured reads as the container login", agentTokenSource() === "none");
    check("…and hands the CLI nothing", agentOauthToken() === undefined);

    setEnvToken(BOGUS, { b64: true });
    check(
      "a base64 token is understood",
      agentTokenSource() === "token" && agentOauthToken() === BOGUS,
    );

    setEnvToken("sk-ant-api03-an-organisation-key-pasted-by-mistake");
    check(
      "an organisation API key is refused, not used",
      agentTokenSource() === "malformed" && agentOauthToken() === undefined,
    );

    setEnvToken("sk-ant-");
    check("a value compose chewed reads as misconfigured", agentTokenSource() === "malformed");

    // --- 2. The endpoint deploy.sh confirms itself with --------------------
    const { GET } = await import("../src/app/api/admin/agent-credential/route");
    process.env.OPNINFER_DEPLOY_TOKEN = "harness-deploy-token";
    const authed = () =>
      new Request("http://x/api/admin/agent-credential", {
        headers: { authorization: "Bearer harness-deploy-token" },
      });
    const source = async () => ((await (await GET(authed())).json()) as { source?: string }).source;

    setEnvToken(BOGUS, { b64: true });
    check("the credential endpoint reports 'token'", (await source()) === "token");
    setEnvToken(undefined);
    check("…and 'none' when there isn't one", (await source()) === "none");
    const denied = await GET(new Request("http://x/api/admin/agent-credential"));
    check("…and refuses a request with no deploy token", denied.status === 401, `status ${denied.status}`);
    setEnvToken(BOGUS, { b64: true });
    const body = await (await GET(authed())).text();
    check("…and never returns the token itself", !body.includes(BOGUS), body);

    // --- 3. THE REAL PATH: which credential does the CLI actually use? -----
    // Control first: with no token the volume login must still work. If this
    // fails, the box simply isn't signed in and the next check proves nothing.
    console.log("\n  running a real container job with NO token (the volume login)…");
    const control = await runInContainer(randomUUID(), undefined);
    check("a run with no token succeeds on the container login", control.ok, control.words);
    if (!control.ok) {
      console.log("\n  ! The dev volume login isn't working, so the decisive check below");
      console.log("    cannot tell 'the token was used' from 'nothing works'. Sign in first:");
      console.log("    docker run -it --rm -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent claude");
    }

    console.log("\n  running the same job again WITH a deliberately invalid token…");
    const withToken = await runInContainer(randomUUID(), BOGUS);
    // The point: the volume login is present and working (proved above), so
    // the only way this can fail on auth is if our token crossed the wire and
    // the CLI preferred it.
    const authFailed = /oauth|authenticat|401|invalid.*token/i.test(withToken.words);
    check(
      "the CLI authenticates with OUR token, not the login beside it",
      !withToken.ok && authFailed,
      withToken.words,
    );

    // …and that failure must route to the right repair: a refused long-lived
    // token is fixed by minting a new one, never by running /login.
    const { classifySubscriptionFailure } = await import("../src/lib/agent/policy");
    check(
      "a refused token classifies as signed_out, so a run fails over",
      classifySubscriptionFailure(withToken.words, null) === "signed_out",
    );

    // --- 4. THE STICKY SIGN-OUT (found while building this) ---------------
    // A failed refresh does not leave the credential alone: the CLI rewrites
    // it with both tokens BLANKED. The broker used to accept that — it still
    // says "claudeAiOauth" — and copy it over the shared volume, so one
    // unlucky chat signed the whole instance out until someone ran the login
    // again. That is what makes the eight-hourly race STICK.
    const BLANKED = JSON.stringify({
      claudeAiOauth: {
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        scopes: [],
        subscriptionType: "max",
      },
    });
    const sharedFingerprint = () =>
      execFileSync(
        "docker",
        [
          "run", "--rm", "--user", "root",
          "-v", "opninfer-agent-config-default:/v",
          "--entrypoint", "sh", "opninfer-agent",
          "-c", "md5sum /v/.credentials.json 2>/dev/null | cut -d' ' -f1",
        ],
        { encoding: "utf8" },
      ).trim();

    const before = sharedFingerprint();
    check("the shared sign-in is readable to begin with", before.length === 32, before);
    console.log("\n  planting a blanked credential (what a FAILED refresh leaves) and running…");
    setEnvToken(undefined);
    const wrecker = await runInContainer(randomUUID(), undefined, BLANKED);
    const after = sharedFingerprint();
    check(
      "a failed refresh in one chat does NOT wipe the shared sign-in",
      after === before,
      `${before} -> ${after}`,
    );
    check("…and that chat still runs, on the shared login", wrecker.ok, wrecker.words);

    // --- 5. The plan-usage reading survives the token ---------------------
    // The measured cost of a long-lived token: Claude Code limits those to
    // inference, so the run's own credential CANNOT read the plan's usage
    // screen — no per-window percentages, which is what the Sandbox panel
    // and the 90% alert email are made of. The fix takes that one reading
    // with the volume login instead. Proven here end to end, against the
    // real plan.
    const { getAgentLimits, refreshPlanUsageViaVolume, clearAgentLimits, PLAN_USAGE_MAX_AGE_MS } =
      await import("../src/lib/agent/limits-store");
    const savedLimits = await getAgentLimits();
    const savedFlag = process.env.AGENT_PLAN_USAGE_VIA_VOLUME;
    try {
      await clearAgentLimits();
      // OFF by default since the volume login was deprecated (2026-09-07):
      // on a normal box there is no volume sign-in for it to read, so
      // leaving it on would start a 1 GB container after runs to learn
      // nothing. The code is kept and stays PROVEN by turning it on here.
      delete process.env.AGENT_PLAN_USAGE_VIA_VOLUME;
      setEnvToken(BOGUS, { b64: true });
      check(
        "the volume reading is off unless asked for",
        (await refreshPlanUsageViaVolume({ force: true })) === 0,
      );
      process.env.AGENT_PLAN_USAGE_VIA_VOLUME = "1";
      // No token configured → the run's own query reads the screen, so this
      // must not spend a container duplicating it.
      setEnvToken(undefined);
      check("with no token, the fallback does nothing", (await refreshPlanUsageViaVolume()) === 0);

      setEnvToken(BOGUS, { b64: true });
      console.log("\n  taking a plan-usage reading with the volume login…");
      const n = await refreshPlanUsageViaVolume();
      const state = await getAgentLimits();
      const windows = Object.values(state).filter(Boolean) as { window: string; percentUsed?: number }[];
      const withPct = windows.filter((w) => typeof w.percentUsed === "number");
      check("the volume login reads the plan's usage screen", n > 0, `${n} windows`);
      check(
        "…with a real percentage for every window it reported",
        withPct.length === windows.length && withPct.length > 0,
        withPct.map((w) => `${w.window}=${w.percentUsed}%`).join(" "),
      );
      check("…so the panel's reading counts as fresh", (planUsageAge(state) ?? Infinity) < 60_000);
      // Throttled: a second call inside the window must not spend another
      // container. Usage only moves when runs happen.
      const again = await refreshPlanUsageViaVolume();
      check("a second call inside the window is skipped", again === 0);
      check("…but force overrides it", (await refreshPlanUsageViaVolume({ force: true })) > 0);
      check("the throttle window is half an hour", PLAN_USAGE_MAX_AGE_MS === 30 * 60_000);
    } finally {
      setEnvToken(undefined);
      const { setSetting } = await import("../src/lib/settings");
      await setSetting("agent_rate_limits", savedLimits as unknown as Record<string, unknown>);
      delete process.env.AGENT_PLAN_USAGE_VIA_VOLUME;
      if (savedFlag !== undefined) process.env.AGENT_PLAN_USAGE_VIA_VOLUME = savedFlag;
    }

    // --- 6. Nothing changes when no token is set --------------------------
    setEnvToken(undefined);
    const back = await runInContainer(randomUUID(), agentOauthToken());
    check("removing the token restores the container login", back.ok, back.words);
  } finally {
    setEnvToken(undefined);
    if (saved.plain !== undefined) process.env.AGENT_OAUTH_TOKEN = saved.plain;
    if (saved.b64 !== undefined) process.env.AGENT_OAUTH_TOKEN_B64 = saved.b64;
  }

  console.log(`\n${failures === 0 ? "ALL AGENT-TOKEN CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
