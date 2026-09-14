import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { devLog } from "@/lib/dev-log";
import { appLog } from "@/lib/applog";
import { extractPackageUses } from "@/lib/agent/packages";
import { recordPackageUses } from "@/lib/agent/packages-store";
import { syncAgentSkills } from "@/lib/agent/skills-sync";
import { fetchAgentMcp } from "@/lib/agent/mcp-store";
import { describeMcpServers, sdkMcpServers, type AgentMcpState } from "@/lib/agent/mcp";
import { reportMcpHealth } from "@/lib/agent/mcp-health";
import { buildAssistantSystemBlock, getAssistantConfig } from "@/lib/assistant";
import { ensureAgentStateDir, ensureChatPool } from "@/lib/storage";
import { syncPool } from "@/lib/pool-sync";
import { peekInterjections } from "@/lib/interject";
import { openAsk } from "@/lib/ask-mailbox";
import { extendTurnHardStop, resetTurnHardStop } from "@/lib/turn-stream";
import { agentOauthToken, agentTokenSource, buildAgentEnv } from "@/lib/agent/env";
import { mintProxyToken, revokeProxyToken } from "@/lib/agent/proxy-tokens";
import { loadCredential } from "@/lib/providers/credentials";
import { makeAgentSpawner } from "@/lib/agent/spawn";
import { AGENT_WORKSPACE, AgentBridge, type AgentEvent, type AgentStreamEvent } from "@/lib/agent/bridge";
import {
  recordPlanUsageFrom,
  recordRateLimit,
  recordRateLimitHit,
  refreshPlanUsageViaVolume,
} from "@/lib/agent/limits-store";
import { agentSteering, type AgentConfig } from "@/lib/agent/config";
import {
  AGENT_AUTO_ALLOWED_TOOLS,
  AGENT_DISALLOWED_TOOLS,
  AGENT_TOOL_NAME,
  askAnswersForAgent,
  askQuestionsFromAgent,
  buildAgentSystemAppend,
  classifySubscriptionFailure,
  decideToolUse,
  summariseAgentRun,
} from "@/lib/agent/policy";
import { PRESENT_FILES_DEF, executePresentFiles } from "./present";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx, ToolOutput } from "./types";

/**
 * `sandbox_task` — hand a job to the Sandbox agent and stream its work into
 * the chat.
 *
 * One outer tool call; inside it a full Claude Agent SDK run in this chat's
 * container. Everything the agent does flows up through ctx.emitEvent as
 * `agent` events (see agent/bridge.ts), which the pipeline turns into the
 * run blocks and status lines the chat already renders. The run resumes the
 * chat's previous agent session by default — the agent keeps its own memory
 * of what it built — and stays steerable: messages the user types mid-run
 * are fed straight into it, Stop interrupts it, and a question it raises
 * parks it on the same card ask_user uses.
 */

const HOW_TO_USE =
  " HOW TO USE IT: give it the task in full, in plain English, with every detail the user provided (names, formats, sizes, wording, constraints) — it cannot see this conversation. It works in this chat's workspace, where the user's uploaded files already are, and it presents finished files to the user itself. By default it CONTINUES this chat's previous agent session (it remembers what it built and why), so follow-up changes go to the same work; set fresh=true only for an unrelated new task. It has the same SKILLS you do (see the SKILLS list) — name the skill in the task when one applies (e.g. \"use your design-graphics skill\" for adverts, posts, posters, mockups). When it reports back, summarise the outcome for the user in your own words and say which files they now have.";

/** The tool definition, built per turn so the description carries the
 *  admin's current steering text (Admin → Tools → Sandbox). */
export function sandboxTaskDef(config: AgentConfig, services: string[] = []): ToolDef {
  // Connected services (MCP, 2026-09-03): named here so the conversation
  // model routes "look at my Figma file" to the Sandbox instead of saying it
  // has no access. Ready (signed-in) ones only — see agent/mcp.ts.
  const connected = services.length
    ? ` CONNECTED SERVICES: it is signed in to these through MCP and can use them directly — ${services.join(", ")}. Send it any request that involves them (a design file, a board, a ticket, a document held there), with the link or identifier the user gave.`
    : "";
  return {
    name: AGENT_TOOL_NAME,
    description: agentSteering(config) + HOW_TO_USE + connected,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The complete task, in plain English, including every specific the user gave. Name the deliverable(s) you expect back.",
        },
        fresh: {
          type: "boolean",
          description:
            "Start a brand-new agent session instead of continuing this chat's previous one. Only for an unrelated new task.",
        },
      },
      required: ["task"],
    },
  };
}

/** Env the CLI gets inside the container — container paths, never the host's. */
const CONTAINER_BASE_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/sandbox",
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
};
const CONTAINER_CONFIG_DIR = "/home/sandbox/.claude";

/**
 * Where the agent container reaches this app's credential proxy. The app port
 * is already published on the host for the reverse proxy, so nothing new is
 * exposed; `host.docker.internal` resolves on Docker Desktop natively and via
 * the host-gateway mapping sandboxd sets on Linux. Override per deployment
 * with AGENT_PROXY_BASE (docker-compose.yml sets it from APP_PORT).
 */
function agentProxyBase(): string {
  const base = process.env.AGENT_PROXY_BASE ?? `http://host.docker.internal:${process.env.PORT ?? 3000}`;
  return base.replace(/\/+$/, "");
}

/** Snap-back budget for the rest of the turn once the agent is done — enough
 *  for the conversation model to summarise, not enough to hang. */
const AFTER_AGENT_TURN_MS = 5 * 60_000;

/** A resume that fails because the session is gone (state dir wiped, first
 *  run after a migration) should retry fresh, not fail the task. */
const RESUME_FAILURE = /session|resume|conversation.*not found|no conversation/i;

export async function executeSandboxTask(
  args: Record<string, unknown>,
  config: AgentConfig,
  ctx: ToolCtx,
): Promise<ToolOutput> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return { text: "Error: `task` must be a non-empty description of the job." };
  const fresh = args.fresh === true;

  if (!process.env.SANDBOX_BROKER_URL || !process.env.SANDBOX_BROKER_TOKEN) {
    return {
      text: "Error: the Sandbox service isn't configured on this instance. [To the assistant: tell the user the Sandbox isn't available here and do what you can yourself.]",
    };
  }
  // API-key path: the org's key never enters the container. The CLI is
  // pointed at the credential proxy with a per-run bearer, and the proxy
  // injects the key server-side and meters real usage.
  let proxy: { baseUrl: string; token: string } | null = null;
  if (config.credential === "api") {
    const cred = config.credentialId ? await loadCredential(config.credentialId) : null;
    if (!cred || cred.provider !== "anthropic-api") {
      return {
        text: "Error: the Sandbox is set to use an organisation API key, but no valid Anthropic key is selected for it (Admin → Tools → Sandbox). [To the assistant: tell the user the Sandbox isn't configured on this instance yet and do what you can yourself.]",
      };
    }
    const grant = mintProxyToken({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      credentialId: cred.id,
      ceilingUsd: config.maxBudgetUsd,
    });
    proxy = { baseUrl: `${agentProxyBase()}/api/agent-proxy`, token: grant.token };
  }
  if (!ctx.emitEvent) {
    return { text: "Error: the Sandbox needs a live chat to stream into and this call has none." };
  }

  const convId = ctx.conversationId;
  const emit = (event: AgentStreamEvent) => ctx.emitEvent!({ kind: "agent", event });

  // Both directories must exist before the container mounts them (prod uses
  // named-volume subpaths, which Docker won't create).
  const [, stateDir] = await Promise.all([ensureChatPool(convId), ensureAgentStateDir(convId)]);
  // The agent gets the assistant's skills as its own (design-graphics etc.).
  await syncAgentSkills(stateDir);
  // …and the instance's connected services (MCP): Claude Code's own config
  // in the credential volume, signed-in ones only (agent/mcp.ts).
  const mcp = await fetchAgentMcp();

  const [assistantCfg, convo] = await Promise.all([
    getAssistantConfig(),
    db.conversation.findUnique({ where: { id: convId }, select: { agentSessionId: true } }),
  ]);
  const previousSession = fresh ? null : (convo?.agentSessionId ?? null);

  // The turn's hard stop stretches to the agent's own budget while it runs
  // (owner decision), and snaps back in the finally below.
  extendTurnHardStop(convId, config.maxMinutes * 60_000 + 120_000);

  const t0 = Date.now();
  const presented: string[] = [];
  const interjections: string[] = [];
  let subscriptionFailureLogged = false;
  try {
    let attempt = await runOnce({ task, resume: previousSession, config, ctx, emit, presented, interjections, assistantCfg, t0, proxy, mcp });
    if (!attempt.ok && attempt.resumed && RESUME_FAILURE.test(attempt.text)) {
      devLog("warn", "agent", "resume failed — retrying fresh", { conversationId: convId, error: attempt.text.slice(0, 200) });
      attempt = await runOnce({ task, resume: null, config, ctx, emit, presented, interjections, assistantCfg, t0, proxy, mcp });
    }

    // SUBSCRIPTION FAILURE (owner ask, 2026-09-02): the plan is spent or the
    // sign-in is gone. Both stop EVERY user's Sandbox until an admin acts, so
    // both are logged at error level — which is what the alert emails watch
    // — and, when an organisation key is configured as the fallback, the run
    // is retried on it through the proxy so the user still gets their work.
    if (!attempt.ok && !proxy) {
      const failure = classifySubscriptionFailure(attempt.text, attempt.planStatus);
      if (failure) {
        subscriptionFailureLogged = true;
        const fallback = config.credentialId ? await loadCredential(config.credentialId) : null;
        const canFailOver = !!fallback && fallback.provider === "anthropic-api";
        // Two different repairs, so two different messages — which is also
        // how the alert throttle groups them. A refreshing volume login is
        // fixed by signing in again; a long-lived token is fixed by minting
        // a new one, and "run /login" would send the admin the wrong way.
        const source = agentTokenSource();
        await appLog(
          "error",
          "agent",
          failure !== "signed_out"
            ? "Sandbox subscription: plan limit reached"
            : source === "token"
              ? "Sandbox subscription: the long-lived token was refused — mint a new one"
              : "Sandbox subscription: signed out — runs need /login",
          {
            userId: ctx.userId,
            details: {
              conversationId: convId,
              failure,
              credential: source === "token" ? "long-lived token" : "container volume login",
              failover: canFailOver ? "organisation API key" : "none configured",
              lastWords: attempt.text.slice(0, 300),
            },
          },
        );
        if (canFailOver) {
          emit({
            type: "status",
            label:
              failure === "signed_out"
                ? "The Claude subscription is signed out — switching to the organisation's API key"
                : "The Claude plan's limit is reached — switching to the organisation's API key",
          });
          const grant = mintProxyToken({
            conversationId: convId,
            userId: ctx.userId,
            credentialId: fallback!.id,
            ceilingUsd: config.maxBudgetUsd,
          });
          proxy = { baseUrl: `${agentProxyBase()}/api/agent-proxy`, token: grant.token };
          devLog("warn", "agent", "subscription failure — failing over to the API key", { conversationId: convId, failure });
          attempt = await runOnce({ task, resume: previousSession, config, ctx, emit, presented, interjections, assistantCfg, t0, proxy, mcp });
        }
      }
    }
    // Production had no trace of a run that died — devLog is dev-only, and
    // the model's summary of the tool result is all a support reader ever
    // saw ("the sandbox run failed to start"). A WARN row, not an error: the
    // subscription cases above are the ones that need an email.
    if (!attempt.ok && !subscriptionFailureLogged) {
      await appLog("warn", "agent", "Sandbox run did not complete", {
        userId: ctx.userId,
        details: {
          conversationId: convId,
          subtype: attempt.subtype,
          seconds: Math.round((Date.now() - t0) / 1000),
          steps: attempt.numTurns,
          lastWords: attempt.text.slice(0, 300),
        },
      });
    }
    return {
      text: summariseAgentRun({
        ok: attempt.ok,
        text: attempt.text,
        presented,
        numTurns: attempt.numTurns,
        durationMs: Date.now() - t0,
        denials: attempt.denials,
        subtype: attempt.subtype,
      }),
    };
  } finally {
    // The bearer dies with the run — a leaked token is worthless after this.
    if (proxy) revokeProxyToken(proxy.token);
    resetTurnHardStop(convId, AFTER_AGENT_TURN_MS);
    // Files the agent wrote but didn't present still need rows, so the next
    // turn's manifest and list_files see them.
    await syncPool(convId, ctx.userId).catch((e) =>
      devLog("warn", "agent", "pool sync after run failed", { conversationId: convId, error: String(e) }),
    );
  }
}

interface RunOutcome {
  ok: boolean;
  text: string;
  subtype: string;
  numTurns: number;
  denials: number;
  resumed: boolean;
  /** The last plan-limit status the run reported (subscription only). */
  planStatus?: "allowed" | "allowed_warning" | "rejected" | null;
}

async function runOnce(opts: {
  task: string;
  resume: string | null;
  config: AgentConfig;
  ctx: ToolCtx;
  emit: (e: AgentStreamEvent) => void;
  presented: string[];
  /** Filled with every mid-run user message fed to the agent, so the
   *  conversation model's summary can honour them too. */
  interjections: string[];
  assistantCfg: Awaited<ReturnType<typeof getAssistantConfig>>;
  t0: number;
  /** API-key path: where the CLI sends model calls (null = subscription). */
  proxy: { baseUrl: string; token: string } | null;
  /** Connected services (MCP) for this instance — see agent/mcp.ts. */
  mcp: AgentMcpState;
}): Promise<RunOutcome> {
  const { task, resume, config, ctx, emit, presented, interjections, proxy, mcp } = opts;
  const convId = ctx.conversationId;
  // Heavy module, loaded only when a run actually happens.
  const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;

  // --- host-side tools the agent can call ---------------------------------
  const opninfer = createSdkMcpServer({
    name: "opninfer",
    version: "1.0.0",
    tools: [
      tool(
        "present_files",
        PRESENT_FILES_DEF.description,
        { names: z.array(z.string()).min(1).describe('Filenames in the workspace to present, e.g. ["report.pdf"]') },
        async (a) => {
          // Files the agent just wrote have no rows yet — reconcile first,
          // or present_files reports them missing.
          await syncPool(convId, ctx.userId).catch(() => {});
          const out = await executePresentFiles({ names: a.names }, ctx);
          if (out.presented?.length) {
            presented.push(...out.presented);
            emit({ type: "presented", names: out.presented });
          }
          return { content: [{ type: "text", text: out.text }] };
        },
      ),
    ],
  });

  // --- input: the task, then anything the user types mid-run ---------------
  let closed = false;
  let wake: (() => void) | null = null;
  const closeInput = () => {
    closed = true;
    wake?.();
  };
  const userMsg = (content: string): SDKUserMessage =>
    ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" }) as SDKUserMessage;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield userMsg(task);
    // Held open for the whole run: interrupt() travels over stdin, and so do
    // the user's mid-run course corrections (the interject mailbox).
    //
    // PEEK, never drain: the agent gets a COPY of each message, and the
    // mailbox keeps it for the pipeline, which drains it between rounds the
    // moment this tool returns — persisting it, moving the bubble, and
    // appending it to the live transcript as a genuine user turn. A first
    // version drained here and relayed the text inside the tool result
    // instead; the conversation model — correctly — treated "the user also
    // said…" arriving in a tool result as a likely injection and refused it.
    let fed = 0;
    while (!closed) {
      const pending = peekInterjections(convId);
      for (const { content } of pending.slice(fed)) {
        fed++;
        interjections.push(content);
        devLog("info", "agent", "steering the agent mid-run", { conversationId: convId, content: content.slice(0, 200) });
        yield userMsg(content);
      }
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 400);
      });
      wake = null;
    }
  }

  // --- the run ---------------------------------------------------------------
  // The connected services this run may use: exactly the ready ones passed
  // below. The permission callback refuses any other server's tools.
  const mcpAllow: ReadonlySet<string> = new Set(Object.keys(sdkMcpServers(mcp)));
  const abort = new AbortController();
  const q = query({
    prompt: input(),
    options: {
      cwd: AGENT_WORKSPACE,
      env: proxy
        ? buildAgentEnv({ credential: "api", base: CONTAINER_BASE_ENV, configDir: CONTAINER_CONFIG_DIR, proxy })
        : buildAgentEnv({
            credential: "subscription",
            base: CONTAINER_BASE_ENV,
            configDir: CONTAINER_CONFIG_DIR,
            oauthToken: agentOauthToken(),
          }),
      // On the proxy path the CLI must not call api.anthropic.com directly
      // for anything — the WebFetch preflight would, and would fail.
      ...(proxy ? { skipWebFetchPreflight: true, maxBudgetUsd: config.maxBudgetUsd } : {}),
      spawnClaudeCodeProcess: makeAgentSpawner(convId) as never,
      abortController: abort,
      model: config.model,
      effort: config.effort,
      maxTurns: config.maxTurns,
      permissionMode: "acceptEdits",
      allowedTools: [...AGENT_AUTO_ALLOWED_TOOLS],
      disallowedTools: [...AGENT_DISALLOWED_TOOLS],
      // Ours plus the instance's connected services, passed EXACTLY as
      // stored (name/type/url/headers are what the CLI keys the sign-in by).
      mcpServers: { opninfer, ...(sdkMcpServers(mcp) as unknown as Record<string, typeof opninfer>) },
      // "user" = the chat's state dir (mounted as ~/.claude): that is where
      // syncAgentSkills mirrors the repo's skills so the agent sees them as
      // its own. Nothing else lives there (no settings.json, no CLAUDE.md).
      settingSources: ["user"],
      strictMcpConfig: true,
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildAgentSystemAppend({
          assistantBlock: buildAssistantSystemBlock(opts.assistantCfg),
          services: describeMcpServers(mcp),
        }),
      },
      ...(resume ? { resume } : {}),
      stderr: (d: string) => devLog("debug", "agent", `agent stderr (${convId})`, { line: d.slice(0, 500) }),
      canUseTool: async (toolName, toolInput) => {
        const d = decideToolUse(toolName, toolInput, AGENT_WORKSPACE, mcpAllow);
        if (d.behavior !== "ask_user") {
          return d.behavior === "allow" ? { behavior: "allow", updatedInput: toolInput } : d;
        }
        // The agent's question → the chat's own card, parking the run on the
        // answer exactly as ask_user does.
        const questions = askQuestionsFromAgent(toolInput);
        if (!questions) {
          return { behavior: "deny", message: "Those questions couldn't be shown. Choose the most sensible default and carry on." };
        }
        const id = randomUUID();
        const settled = openAsk(convId, id, questions, { signal: ctx.signal });
        ctx.emitEvent!({ kind: "ask", id, questions });
        const r = await settled;
        emit({ type: "ask_done", id, status: r.status, ...(r.status === "answered" ? { answers: r.answers } : {}) });
        if (r.status !== "answered") {
          return { behavior: "deny", message: "The user didn't answer. Choose the most sensible default, say which you chose, and carry on." };
        }
        return { behavior: "allow", updatedInput: askAnswersForAgent(toolInput, questions, r.answers) };
      },
    },
  });

  // Stop (the turn's abort) → interrupt the agent; if it won't wind down,
  // pull the plug shortly after.
  const onAbort = () => {
    void q.interrupt().catch(() => {});
    setTimeout(() => abort.abort(), 5_000);
  };
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });

  // Our own wall clock — the admin's per-run minutes.
  let timedOut = false;
  const wall = setTimeout(() => {
    timedOut = true;
    void q.interrupt().catch(() => {});
  }, config.maxMinutes * 60_000);

  const bridge = new AgentBridge();
  let outcome: RunOutcome = { ok: false, text: "", subtype: "no_result", numTurns: 0, denials: 0, resumed: !!resume };
  let sessionSaved = false;
  let sessionId: string | null = resume;
  try {
    for await (const msg of q as AsyncIterable<unknown>) {
      let finished = false;
      for (const ev of bridge.feed(msg)) {
        finished = (await handleEvent(ev)) || finished;
      }
      if (finished) break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    devLog("error", "agent", "run threw", { conversationId: convId, error: message });
    outcome = { ...outcome, ok: false, text: outcome.text || message, subtype: outcome.subtype === "no_result" ? "error" : outcome.subtype };
  } finally {
    clearTimeout(wall);
    ctx.signal?.removeEventListener("abort", onAbort);
    closeInput();
    try {
      await q.close?.();
    } catch {
      /* already closed */
    }
    // A run that died mid-tool must not leave a live block spinning forever.
    for (const id of bridge.danglingRuns()) {
      emit({ type: "run_done", id, error: "The run ended before this step finished." });
    }
  }
  if (timedOut) {
    outcome = { ...outcome, ok: false, subtype: "timed_out", text: `${outcome.text}\n(Stopped at the ${config.maxMinutes}-minute limit set for Sandbox runs.)` };
  }
  return outcome;

  async function checkMcpHealthAfterRun(): Promise<void> {
    try {
      const statuses = await Promise.race([
        q.mcpServerStatus(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mcpServerStatus timed out")), 5_000)),
      ]);
      const ready = [...mcpAllow];
      const health = await reportMcpHealth(statuses, { ready, known: ready }, { userId: ctx.userId, conversationId: convId, source: "run" });
      for (const b of health.broken) {
        emit({
          type: "status",
          label:
            b.status === "needs-auth"
              ? `The ${b.name} connection is signed out — the admin has been alerted`
              : `The ${b.name} connection isn't working (${b.status}) — the admin has been alerted`,
        });
      }
    } catch (e) {
      devLog("warn", "agent", "MCP health check after the run failed", { conversationId: convId, error: String(e) });
    }
  }

  /** Returns true when the run is finished. */
  async function handleEvent(ev: AgentEvent): Promise<boolean> {
    switch (ev.type) {
      case "session":
        if (ev.sessionId) sessionId = ev.sessionId;
        if (!sessionSaved && ev.sessionId && ev.sessionId !== resume) {
          sessionSaved = true;
          await db.conversation
            .update({ where: { id: convId }, data: { agentSessionId: ev.sessionId } })
            .catch(() => {});
        }
        return false;
      case "rate_limit": {
        void recordRateLimit(ev.info);
        const status = (ev.info as { status?: string } | null)?.status;
        if (status === "allowed" || status === "allowed_warning" || status === "rejected") {
          outcome = { ...outcome, planStatus: status };
          // Approaching is worth a WARNING in the log (not an email): the
          // email comes when it is actually hit and a run fails.
          if (status === "allowed_warning") {
            void appLog("warn", "agent", "Sandbox subscription: nearing the plan's limit", {
              userId: ctx.userId,
              details: { conversationId: convId, info: ev.info },
            });
          }
        }
        return false;
      }
      case "retry":
        // A rate-limit wait is the subscription's real cost signal — count it.
        if (ev.reason === "rate_limit") void recordRateLimitHit();
        emit(ev);
        return false;
      case "result":
        // Subscription: the SDK's per-model report is the only usage source.
        // API key: the PROXY has already booked every call from Anthropic's
        // real numbers — emitting these too would double-count.
        if (!proxy) {
          for (const [model, usage] of Object.entries(ev.byModel)) {
            emit({ type: "usage", model, usage, ...(sessionId ? { sessionId } : {}) });
          }
          // The plan's own usage screen (real percentages for every window);
          // the CLI is still up because the input stream is held open.
          const got = await recordPlanUsageFrom(q);
          // On a LONG-LIVED TOKEN that comes back empty — Claude Code limits
          // those to inference, so this run's credential cannot read the
          // usage screen at all (measured 2026-09-07). Take the reading with
          // the volume login instead, in the background: the panel and the
          // 90% alert email are the only things that need it, and neither is
          // worth making the user wait for. Throttled to every 30 minutes,
          // and a no-op when no token is configured.
          if (got === 0) {
            void refreshPlanUsageViaVolume().catch(() => undefined);
          }
        }
        // Connected services: did the ones we passed actually work? A
        // signed-out or failing service is an ERROR row (→ the alert email)
        // and a status line — nobody should learn of a broken link from a
        // user. The CLI is still up (input held open), so it can be asked.
        if (mcpAllow.size > 0) await checkMcpHealthAfterRun();
        outcome = {
          ...outcome,
          ok: ev.ok,
          text: ev.text,
          subtype: ev.subtype,
          numTurns: ev.numTurns,
          denials: ev.permissionDenials,
          resumed: !!resume,
        };
        return true;
      case "run_exec":
        // Tally installs and external fetches (Admin → Tools shows the top
        // ones against the image's manifest) — the command itself is the data.
        void recordPackageUses(extractPackageUses(ev.command), { conversationId: convId, userId: ctx.userId });
        emit(ev);
        return false;
      default:
        emit(ev);
        return false;
    }
  }
}
