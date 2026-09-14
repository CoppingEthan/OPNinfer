"use server";

import { revalidatePath } from "next/cache";
import { appLog } from "@/lib/applog";
import { requireAdmin } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { getSetting, setSetting } from "@/lib/settings";
import { encrypt } from "@/lib/crypto";
import {
  getCapability,
  getCapabilityState,
  setCapabilityState,
} from "@/lib/capabilities/registry";
import { TOOL_GROUPS, type ToolGroup } from "@/lib/tools/types";
import { TOPIC_CHARS_BOUNDS } from "@/lib/memory-topics";

/** Admin → Tools page server actions (v0.3 step 10). All server-authoritative. */

type Result = { success?: string; error?: string };

// Straight from the single source of truth — a hand-maintained copy here is
// what silently swallowed the "ask" group's toggle.
const VALID_GROUPS: readonly ToolGroup[] = TOOL_GROUPS;

/** Instance-wide tool-group toggles. */
export async function saveToolGroups(disabled: string[]): Promise<Result> {
  const admin = await requireAdmin();
  const clean = disabled.filter((g): g is ToolGroup =>
    (VALID_GROUPS as string[]).includes(g),
  );
  await setSetting("tools_config", { disabledGroups: clean });
  await audit("tools.groups", { userId: admin.id, details: { disabled: clean } });
  revalidatePath("/admin/tools");
  return { success: "Saved." };
}

/** Tavily key — encrypted at rest, same mechanism as provider keys. */
export async function saveTavilyKey(key: string): Promise<Result> {
  const admin = await requireAdmin();
  const trimmed = key.trim();
  if (!trimmed) return { error: "Key cannot be empty." };
  // Sanity ping before storing.
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: trimmed, query: "ping", max_results: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { error: "Tavily rejected that key." };
    }
  } catch {
    /* network hiccup — store anyway; tools will surface errors */
  }
  await setSetting("web_tools_config", {
    tavilyKeyEncrypted: encrypt(trimmed).toString("base64"),
  });
  await audit("tools.tavily_key", { userId: admin.id });
  revalidatePath("/admin/tools");
  return { success: "Key verified and saved (encrypted)." };
}

export async function clearTavilyKey(): Promise<Result> {
  const admin = await requireAdmin();
  await setSetting("web_tools_config", {});
  await audit("tools.tavily_key_cleared", { userId: admin.id });
  revalidatePath("/admin/tools");
  return { success: "Key removed." };
}

/** Weekly image quotas per user. */
export async function saveImageQuotas(flash: number, pro: number): Promise<Result> {
  const admin = await requireAdmin();
  if (!Number.isFinite(flash) || flash < 0 || flash > 10_000) return { error: "Invalid standard quota." };
  if (!Number.isFinite(pro) || pro < 0 || pro > 10_000) return { error: "Invalid max-quality quota." };
  const existing = (await getSetting<Record<string, unknown>>("image_tools_config")) ?? {};
  await setSetting("image_tools_config", {
    ...existing,
    flashWeeklyLimit: Math.trunc(flash),
    proWeeklyLimit: Math.trunc(pro),
  });
  await audit("tools.image_quotas", { userId: admin.id, details: { flash, pro } });
  revalidatePath("/admin/tools");
  return { success: "Saved." };
}

/** Memory v2 settings: pause learning for everyone, the size per note, and
 *  whether the assistant may search people's own past chats. On/off itself
 *  is the "User memory" group toggle above. */
export async function saveMemoryConfig(input: {
  paused: boolean;
  topicChars: number;
  chatSearch: boolean;
}): Promise<Result> {
  const admin = await requireAdmin();
  const chars = Math.trunc(Number(input.topicChars));
  if (!Number.isFinite(chars) || chars < TOPIC_CHARS_BOUNDS.min || chars > TOPIC_CHARS_BOUNDS.max) {
    return {
      error: `Note size must be between ${TOPIC_CHARS_BOUNDS.min} and ${TOPIC_CHARS_BOUNDS.max.toLocaleString()} characters.`,
    };
  }
  const config = { paused: input.paused === true, topicChars: chars, chatSearch: input.chatSearch !== false };
  await setSetting("memory_config", config);
  await audit("tools.memory_config", { userId: admin.id, details: config });
  revalidatePath("/admin/tools");
  return { success: "Saved." };
}

/**
 * Sandbox (agent tier): who is the subscription credential signed in as?
 *
 * Asks the CLI **inside a throwaway agent container**, over the real attach
 * path, and reads accountInfo() off the control channel (no model call, no
 * tokens spent).
 *
 * Running this on the HOST instead — which it did until 2026-09-01 — reads
 * whatever `~/.claude` the SERVER process happens to have, and that is a
 * different machine's login entirely. It confidently reported the developer's
 * own account while the container was signed in as somebody else, and on a
 * deployed instance it would report "signed in" for a container that is not.
 * A status display that can be confidently wrong is worse than none.
 */
/**
 * Send the plan-alert email by hand (owner ask, 2026-09-02: "test 90% and
 * 100% and make sure they show as tests"). Same wording as the real alert
 * (planAlertEvent), to the alerts address, marked TEST in subject and body.
 */
export async function sendTestPlanAlert(kind: "warn" | "limit"): Promise<Result> {
  const admin = await requireAdmin();
  const { getAlertConfig } = await import("@/lib/alerts");
  const { isSmtpConfigured, sendMail } = await import("@/lib/mailer");
  const { errorAlertEmail } = await import("@/lib/emails");
  const { planAlertEvent } = await import("@/lib/agent/limits-store");
  if (!(await isSmtpConfigured())) return { error: "No SMTP configured — nothing can be delivered yet." };
  const cfg = await getAlertConfig();
  const to = cfg.email || admin.email;
  if (!to) return { error: "No alert address is set (Admin → SMTP → Error alerts)." };
  const now = Date.now();
  const ev = planAlertEvent(
    kind === "limit"
      ? { window: "seven_day", kind: "limit", percentUsed: 100, resetsAt: now + 3 * 86_400_000 }
      : { window: "five_hour", kind: "warn", percentUsed: 91, resetsAt: now + 2 * 3_600_000 },
  );
  try {
    const mail = await errorAlertEmail(
      { level: "error", category: "agent", message: ev.message, details: ev.details, userId: null, createdAt: new Date(now).toISOString() },
      0,
      { test: true },
    );
    await sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    return { success: `Test ${kind === "limit" ? "limit-reached" : "90%"} alert sent to ${to}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to send." };
  }
}

export async function checkAgentAccount(): Promise<
  Result & { account?: { email?: string; organization?: string; subscriptionType?: string }; warning?: string }
> {
  const admin = await requireAdmin();
  // Dynamic imports: the SDK is heavyweight and only this action needs it.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { agentOauthToken, agentTokenSource, buildAgentEnv } = await import("@/lib/agent/env");
  const { makeAgentSpawner, destroyAgentContainer } = await import("@/lib/agent/spawn");
  const { AGENT_PROBE_CONVERSATION_ID } = await import("@/lib/agent/config");
  const { ensureChatPool, ensureAgentStateDir } = await import("@/lib/storage");

  if (!process.env.SANDBOX_BROKER_URL || !process.env.SANDBOX_BROKER_TOKEN) {
    return { error: "The sandbox service isn't configured, so the agent can't be reached." };
  }

  const probeId = AGENT_PROBE_CONVERSATION_ID;
  // Both directories must exist before the container mounts them — in
  // production they are named-volume subpaths, which Docker will not create.
  await ensureChatPool(probeId);
  await ensureAgentStateDir(probeId);

  const abort = new AbortController();
  // A REAL one-turn request, not an idle stream (2026-09-04, found in
  // production): `accountInfo()` only reports what the CLI has STORED, so a
  // sign-in whose refresh token Anthropic had rotated (a cloned host) still
  // read "Signed in" all day while every run failed over to the org key —
  // 307 calls, $15. The probe now makes the plan answer, and judges the
  // outcome with the same classifier the runs use. The input stream stays
  // open after the prompt so the control requests (account, usage) work.
  type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: "Reply with exactly: OK" }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  const deadline = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        // Longer than the host-side check needed: this one may have to pull
        // the container up first, then wait for a model reply.
        setTimeout(() => reject(new Error("Timed out checking the sign-in.")), ms),
      ),
    ]);
  try {
    const q = query({
      prompt: input(),
      options: {
        cwd: "/workspace",
        env: buildAgentEnv({
          credential: "subscription",
          base: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/home/sandbox",
            LANG: "C.UTF-8",
          },
          configDir: "/home/sandbox/.claude",
          // The probe must test what the RUNS use, or it would report on a
          // credential nothing else touches.
          oauthToken: agentOauthToken(),
        }),
        spawnClaudeCodeProcess: makeAgentSpawner(probeId) as never,
        abortController: abort,
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
      },
    });
    // Read the stream: the plan's rate-limit status, any assistant text, and
    // the result. Mirrors the bridge's reading of the result message.
    let ok = false;
    let subtype = "no_result";
    let words = "";
    let planStatus: "allowed" | "allowed_warning" | "rejected" | null = null;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    void (async () => {
      try {
        for await (const m of q) {
          const msg = m as Record<string, unknown>;
          if (msg.type === "rate_limit_event") {
            const s = (msg.rate_limit_info as { status?: string } | undefined)?.status;
            if (s === "allowed" || s === "allowed_warning" || s === "rejected") planStatus = s;
          } else if (msg.type === "assistant") {
            const content = (msg.message as { content?: unknown } | undefined)?.content;
            if (Array.isArray(content)) {
              for (const b of content) {
                if ((b as { type?: string }).type === "text") words += `${String((b as { text?: string }).text ?? "")}\n`;
              }
            }
          } else if (msg.type === "result") {
            subtype = String(msg.subtype ?? "unknown");
            ok = subtype === "success" && msg.is_error !== true;
            const errors = Array.isArray(msg.errors) ? msg.errors.map(String).join("\n") : "";
            words += `${typeof msg.result === "string" ? msg.result : errors}\n`;
            settle();
          }
        }
      } catch (err) {
        // A signed-out CLI can die instead of reporting — its last words are
        // the evidence the classifier needs.
        words += `${err instanceof Error ? err.message : String(err)}\n`;
      } finally {
        settle();
      }
    })();
    const account = await deadline(q.accountInfo(), 60_000);
    await deadline(settled, 75_000);
    // While the CLI is up anyway, refresh the plan-usage readings so the
    // panel fills in on a click, not only after a run.
    const { recordPlanUsageFrom, refreshPlanUsageViaVolume } = await import("@/lib/agent/limits-store");
    // On a long-lived token this returns nothing (those are inference-only),
    // so fall back to the volume login. `force`, because a person just asked:
    // the button should always leave a current reading, not a half-hour-old
    // one. It runs after this probe's container is gone — see the finally.
    if ((await recordPlanUsageFrom(q)) === 0) {
      // Its own container and its own credential, so it neither waits for
      // nor disturbs the probe still running above.
      await refreshPlanUsageViaVolume({ force: true }).catch(() => 0);
    }
    const info = {
      email: (account as { email?: string }).email,
      organization: (account as { organization?: string }).organization,
      subscriptionType: (account as { subscriptionType?: string }).subscriptionType,
    };
    if (!ok) {
      const { classifySubscriptionFailure } = await import("@/lib/agent/policy");
      const failure = classifySubscriptionFailure(words, planStatus);
      if (failure === "signed_out") {
        // The SAME row a failing run writes, so the alert throttle groups them
        // and the email says what an admin must do.
        const usingToken = agentTokenSource() === "token";
        await appLog(
          "error",
          "agent",
          usingToken
            ? "Sandbox subscription: the long-lived token was refused — mint a new one"
            : "Sandbox subscription: signed out — runs need /login",
          {
            userId: admin.id,
            details: {
              source: "check-sign-in",
              credential: usingToken ? "long-lived token" : "container volume login",
              account: info,
              subtype,
              lastWords: words.slice(0, 300),
            },
          },
        );
        return {
          error: usingToken
            ? "The long-lived token this instance is configured with was refused — it has been revoked or has expired. " +
              "Every Sandbox run is failing over to the fallback key (or failing) until a new one is set with " +
              "./deploy.sh agent-token <instance>."
            : `The stored sign-in${info.email ? ` (${info.email})` : ""} no longer works — its token has expired or been ` +
              "rotated, which a cloned or restored host does. Every Sandbox run is failing over to the fallback key " +
              "(or failing) until the login is run again — see the note below.",
        };
      }
      if (failure === "rate_limit") {
        return {
          success: "Signed in.",
          account: info,
          warning: "The plan is at its limit right now — runs wait or fail over until it resets.",
        };
      }
      await appLog("warn", "agent", "Sandbox sign-in check: the test request failed", {
        userId: admin.id,
        details: { account: info, subtype, lastWords: words.slice(0, 500) },
      });
      return {
        error: `Signed in, but a test request failed (${subtype}): ${words.trim().slice(0, 200) || "no output"} (details in Admin → Logs).`,
      };
    }
    return { success: "Signed in — a test request went through on the plan.", account: info };
  } catch (e) {
    // Say WHY (2026-09-02, found on the first production check): every
    // failure used to read "Not signed in" — a broker refusing the request,
    // Docker unable to start the probe container, a bad token — so a real
    // sign-in looked like a missing one and nothing was logged anywhere an
    // admin could see. The underlying message is logged and shown; only a
    // genuine auth failure keeps the "Not signed in" wording.
    const msg = e instanceof Error ? e.message : String(e);
    await appLog("warn", "agent", "Sandbox sign-in check failed", {
      userId: admin.id,
      details: { error: msg.slice(0, 500) },
    });
    if (/timed out/i.test(msg)) return { error: "Timed out checking the sign-in." };
    if (/not logged in|please run \/login|authentication|invalid.*(token|credential)|oauth/i.test(msg)) {
      return {
        error: "Not signed in — run Anthropic's own login flow inside the agent container (see the card's note).",
      };
    }
    return {
      error: `The check couldn't run: ${msg.slice(0, 200)} (details in Admin → Logs).`,
    };
  } finally {
    abort.abort();
    // The probe container is disposable and holds ~1 GB — never leave it warm.
    destroyAgentContainer(probeId);
  }
}

/** Sandbox: wipe the stored plan-usage readings and the rate-limit-wait
 *  counter — after changing plan or account, stale numbers mislead. */
export async function clearAgentPlanUsage(): Promise<Result> {
  const admin = await requireAdmin();
  const { clearAgentLimits } = await import("@/lib/agent/limits-store");
  await clearAgentLimits();
  await audit("tools.agent_plan_usage_cleared", { userId: admin.id });
  revalidatePath("/admin/tools");
  return { success: "Plan usage cleared." };
}

/** Enable/configure a client capability. */
export async function saveCapability(
  id: string,
  enabled: boolean,
  config: Record<string, unknown>,
): Promise<Result> {
  const admin = await requireAdmin();
  const cap = getCapability(id);
  if (!cap) return { error: "Unknown capability." };
  if (enabled) {
    const parsed = cap.configSchema.safeParse(config);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid configuration." };
    }
  }
  // Preserve stored secrets the form left blank (secret inputs echo nothing).
  const prior = await getCapabilityState(cap);
  const merged = { ...config };
  for (const field of cap.secretFields) {
    if (!merged[field] && prior.config[field]) merged[field] = prior.config[field];
  }
  await setCapabilityState(cap, enabled, merged);
  await audit("tools.capability", { userId: admin.id, details: { id, enabled } });
  revalidatePath("/admin/tools");
  revalidatePath("/admin/sandbox");
  revalidatePath("/admin", "layout"); // the nav tab appears/disappears
  return { success: enabled ? "Capability enabled." : "Capability disabled." };
}

/**
 * Admin → Sandbox → Connected services → "Check connections" (2026-09-03).
 * Boots the agent in a disposable container with the instance's MCP servers
 * — the same `mcpServers` a run gets, plus the ones still needing a sign-in
 * — and asks the CLI for each server's status, so "signed in" is a fact the
 * CLI reported from inside the container, not a guess from a file.
 */
export async function checkAgentMcp(): Promise<
  Result & { servers?: { name: string; status: string; detail?: string }[]; unexpected?: string[] }
> {
  const admin = await requireAdmin();
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { agentOauthToken, buildAgentEnv } = await import("@/lib/agent/env");
  const { makeAgentSpawner, destroyAgentContainer } = await import("@/lib/agent/spawn");
  const { AGENT_PROBE_CONVERSATION_ID } = await import("@/lib/agent/config");
  const { ensureChatPool, ensureAgentStateDir } = await import("@/lib/storage");
  const { fetchAgentMcp } = await import("@/lib/agent/mcp-store");
  const { readyMcpServers, sdkMcpServers } = await import("@/lib/agent/mcp");
  const { reportMcpHealth } = await import("@/lib/agent/mcp-health");

  if (!process.env.SANDBOX_BROKER_URL || !process.env.SANDBOX_BROKER_TOKEN) {
    return { error: "The sandbox service isn't configured, so the agent can't be reached." };
  }
  const state = await fetchAgentMcp({ fresh: true });
  const servers = sdkMcpServers(state, { all: true });
  const names = Object.keys(servers);
  if (names.length === 0) return { success: "No connected services are set up for this instance.", servers: [] };

  const probeId = AGENT_PROBE_CONVERSATION_ID;
  await ensureChatPool(probeId);
  await ensureAgentStateDir(probeId);
  const abort = new AbortController();
  async function* idle(): AsyncGenerator<never> {
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  try {
    const q = query({
      prompt: idle() as AsyncIterable<never>,
      options: {
        cwd: "/workspace",
        env: buildAgentEnv({
          credential: "subscription",
          base: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/sandbox", LANG: "C.UTF-8" },
          configDir: "/home/sandbox/.claude",
          oauthToken: agentOauthToken(),
        }),
        spawnClaudeCodeProcess: makeAgentSpawner(probeId) as never,
        abortController: abort,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: servers as never,
        maxTurns: 1,
      },
    });
    void (async () => {
      try {
        for await (const _ of q) void _;
      } catch {
        /* torn down below */
      }
    })();
    // MCP start-up is non-blocking: poll until nothing is still pending.
    const deadline = Date.now() + 45_000;
    let statuses: Awaited<ReturnType<typeof q.mcpServerStatus>> = [];
    for (;;) {
      statuses = await Promise.race([
        q.mcpServerStatus(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out checking the connections.")), Math.max(1_000, deadline - Date.now())),
        ),
      ]);
      if (!statuses.some((s) => s.status === "pending") || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const rows = names.map((name) => {
      const s = statuses.find((x) => x.name === name);
      const detail = s?.serverInfo
        ? `${s.serverInfo.name} ${s.serverInfo.version}`.trim()
        : (s as { error?: string } | undefined)?.error;
      return { name, status: s?.status ?? "unknown", ...(detail ? { detail } : {}) };
    });
    // The same judgement a run makes: a signed-in service that failed is an
    // error row (→ alert email); anything the CLI reported that isn't set up
    // here is flagged. So the button proves the alert path, not just the UI.
    const health = await reportMcpHealth(
      statuses.map((s) => ({ name: s.name, status: s.status, ...((s as { error?: string }).error ? { error: (s as { error?: string }).error } : {}) })),
      { ready: readyMcpServers(state), known: names },
      { userId: admin.id, source: "check" },
    );
    return { success: "Checked from inside a container.", servers: rows, unexpected: health.unexpected };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appLog("warn", "agent", "Sandbox MCP check failed", {
      userId: admin.id,
      details: { error: msg.slice(0, 500) },
    });
    return { error: `The check couldn't run: ${msg.slice(0, 200)} (details in Admin → Logs).` };
  } finally {
    abort.abort();
    destroyAgentContainer(probeId);
  }
}
