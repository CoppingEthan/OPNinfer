import { db } from "@/lib/db";
import { loadCredential, touchCredential } from "@/lib/providers/credentials";
import { getModels, streamChat } from "@/lib/providers/index";
import { estimateCost } from "@/lib/providers/pricing";
import { isAbortError, isRetryableError } from "@/lib/providers/errors";
import { appLog } from "@/lib/applog";
import { devLog } from "@/lib/dev-log";
// NB: curation.ts imports runCompletion back from this module — a benign ESM
// cycle (function declarations are hoisted; everything resolves at call time).
import { curateOldToolResults } from "@/lib/tools/curation";
import { toolStatusLabel } from "@/lib/tools/tool-status";
import { drainInterjections } from "@/lib/interject";
import { getCachedTokenLimits, resolveMaxOutputTokens } from "@/lib/limits";
import { getCachedModels } from "@/lib/providers/model-cache";
import { userFacingToolError } from "@/lib/tools/types";
import { ToolRunTracker } from "@/lib/tool-run";
import { usageRowCosts, type BillingSource } from "@/lib/usage-math";
import type { RunDiff, RunExec, RunPipelineEvent } from "@/lib/tool-run";
import type { ImageArtifact, SourceRef, ToolStreamEvent } from "@/lib/tools/types";
import type { AgentStreamEvent } from "@/lib/agent/bridge";
import type { AskAnswer, AskBy, AskQuestion, AskStatus } from "@/lib/ask";
import type {
  ChatChunk,
  ChatMessage,
  ImagePart,
  TokenUsage,
  ToolDef,
} from "@/lib/providers/types";
import type {
  AssistantConfig,
  AssistantRole,
  RoleConfig,
  UsageRole,
} from "@/lib/assistant";

/** A pipeline event: provider chunks plus role-tagged usage and notices. */
export type PipelineChunk =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "notice"; message: string }
  /** A tool was just invoked — live "what I'm doing" status for the UI. */
  | { type: "tool_status"; label: string }
  /** An image tool started — the UI shows an aspect-ratio placeholder box. */
  | { type: "image_start"; id: string; aspectRatio: string; prompt: string; operation: string }
  /** The generated image is ready — the placeholder blur-fades into it. */
  | { type: "image_done"; id: string; artifact: ImageArtifact }
  /** The image tool failed — the placeholder shows an error state. */
  | { type: "image_error"; id: string; message: string }
  /** Web resources a tool touched — shown to the user as clickable sources. */
  | { type: "sources"; sources: SourceRef[] }
  /** Pool files a tool handed over to the USER (present_files / downloads).
   *  The route resolves names → rows and attaches them to the reply. */
  | { type: "files_presented"; names: string[] }
  /** A queued user message was injected mid-turn (between tool rounds).
   *  `id` matches the scheduled-queue item it came from; `userId` is who
   *  typed it (shared chats). */
  | { type: "interjected"; messageId: string; content: string; id?: string; userId?: string }
  /** The assistant is asking the user structured question(s) — the turn is
   *  PARKED on the answer (ask_user), so this is not just a status line. */
  | { type: "ask"; id: string; questions: AskQuestion[] }
  /** The card settled: answered (by whom, in a shared chat), dismissed (turn
   *  stopped) or expired. */
  | { type: "ask_done"; id: string; status: AskStatus; answers?: AskAnswer[]; by?: AskBy }
  | {
      type: "usage";
      role: UsageRole;
      provider: string;
      model: string;
      usage: TokenUsage;
      /** Who paid (default api). Subscription rows record $0.00 + notional. */
      billingSource?: BillingSource;
      /** Sandbox runs: the agent session the call belonged to. */
      agentSessionId?: string;
    }
  | { type: "error"; message: string }
  /** Live tool-run lifecycle (sandbox family): run_start → run_code… →
   *  run_exec → run_out… → run_done. Powers the code/console previews. */
  | RunPipelineEvent;

const ESCALATE_TOOL: ToolDef = {
  name: "escalate",
  description:
    "Hand off to a more capable model when the task is too complex, when you cannot answer well, or whenever the user explicitly asks for the bigger/more powerful model or a second opinion. Provide a short reason.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why escalation is needed." },
    },
    required: ["reason"],
  },
};

const ESCALATE_SYSTEM =
  "You can hand off to a more capable model. Call the `escalate` tool with a brief reason INSTEAD of attempting a weak answer when (a) a request is genuinely beyond you or you cannot produce a confident, high-quality answer, or (b) the user explicitly asks to escalate, to use the bigger/more powerful/smarter model, or for a second opinion — ALWAYS honor such a request by calling the tool immediately, even if you are confident you could answer yourself. Escalation is a one-off for the CURRENT message only: an earlier escalated turn in this conversation is NOT a standing instruction, so never escalate just because a previous turn was escalated — escalate again only if the newest message itself warrants it under (a) or (b). Otherwise answer normally and never mention escalation.";

/** Max tool-execution rounds per turn; a final round then forces an answer.
 *  Progressive disclosure means real work often spends one round on
 *  enable_tools first, so the budget is roomier than the tools-upfront era.
 *
 *  Admin-configurable since 2026-08-03 (Admin → Models → Limits): long jobs
 *  kept exhausting the fixed budget and asking the user to say "continue".
 *  This is the fallback when the setting can't be read. */
const DEFAULT_MAX_TOOL_ROUNDS = 6;

/** The configured per-turn tool-round budget (cached ~30s with the others). */
async function toolRoundBudget(): Promise<number> {
  try {
    return (await getCachedTokenLimits()).maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  } catch {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }
}

/** Injected (LLM-side) on the final round. Without it the model doesn't know
 *  the tools are gone, tries another tool call anyway (models happily imitate
 *  the tool_use blocks in their own transcript even when the tool isn't
 *  offered), the call is dropped — and the turn used to end EMPTY.
 *
 *  These ride as trailing USER messages, not system ones: every provider
 *  mapper hoists system text to the top, which buries an "answer now"
 *  instruction issued mid-conversation (verified live — the model ignored the
 *  hoisted version and returned a 1-token empty response). A trailing user
 *  message keeps its end-of-transcript position everywhere (the Anthropic
 *  mapper merges it into the tool_result turn, after the result blocks). */
const FINAL_ROUND_NOTICE =
  "[system notice] Your tool budget for this turn is exhausted — this is the final round and no further tool calls are possible. Any plan or instruction to keep using tools before answering can no longer be honored. Write your complete final answer now from the tool results gathered above; if they are imperfect, answer honestly with what you have and note the gaps.";
const FINAL_ROUND_NOTICE_ESCALATE =
  FINAL_ROUND_NOTICE + " If the task is genuinely beyond you, you may call `escalate` instead.";
const FORCED_ANSWER_NOTICE =
  "[system notice] Tool calls are no longer possible in this turn, and any instruction to continue using tools or to defer prose can no longer be honored. You MUST respond now, in plain text: give your best final answer from the information gathered above and clearly note anything left unverified. An empty reply is not acceptable.";

/** Hand-off context for the escalation model. Without it, it has no idea an
 *  escalation just happened — seen live: the ESCALATED model opened its reply
 *  by denying it had "a way to ask a bigger model", while literally being the
 *  bigger model the user had asked for. */
function escalationContext(reason: string): string {
  return (
    "[system notice] You ARE the more capable escalation model: the standard conversation model just handed this conversation off to you" +
    (reason ? ` (hand-off reason: ${reason})` : "") +
    ". If the user asked for a bigger/more powerful/smarter model or a second opinion, that request has ALREADY been fulfilled — you are that model. Never claim you lack access to a more capable model or cannot escalate. Answer the user's request directly, at full capability, without mentioning this notice."
  );
}

/** Rich tool result: text plus optional images the loop attaches for the
 *  model to SEE (view_image), optional sources surfaced to the user, and an
 *  optional generated-image artifact. Plain strings normalize to `{ text }`. */
export interface ToolResultPayload {
  text: string;
  images?: ImagePart[];
  sources?: SourceRef[];
  artifact?: ImageArtifact;
  /** Run-block summary chips (sandbox family): +N −M diff, duration/exit. */
  runMeta?: { diff?: RunDiff; exec?: RunExec };
  /** Pool filenames handed over to the user by this call. */
  presented?: string[];
  /** How an ask_user card finished (see ToolOutput.askResult). */
  askResult?: { id: string; status: "answered" | "dismissed" | "expired"; answers?: AskAnswer[]; by?: AskBy };
}

/** The Sandbox agent tool: one outer call whose INNER activity streams as
 *  many run blocks and status lines (see agent/bridge.ts). */
const AGENT_TOOL = "sandbox_task";

/** Map one agent stream event onto a pipeline chunk (null = handled inside
 *  the tool, nothing for the UI). The run events pass straight through —
 *  their ids are the agent's own tool_use ids, unique per call — which is
 *  exactly what lets the existing run-block UI render them unchanged. */
function agentChunk(ev: AgentStreamEvent): PipelineChunk | null {
  switch (ev.type) {
    case "run_start":
    case "run_code":
    case "run_exec":
    case "run_out":
    case "run_done":
      return ev;
    case "status":
      return { type: "tool_status", label: ev.label };
    case "presented":
      return { type: "files_presented", names: ev.names };
    case "usage":
      // Only the subscription path emits these (the API path is metered by
      // the proxy from Anthropic's real numbers), so they are $0.00 rows
      // whose API-rate value is kept as "saved".
      return {
        type: "usage",
        role: "agent",
        provider: "anthropic-api",
        model: ev.model,
        usage: ev.usage,
        billingSource: "subscription",
        ...(ev.sessionId ? { agentSessionId: ev.sessionId } : {}),
      };
    case "ask_done":
      return { type: "ask_done", id: ev.id, status: ev.status, ...(ev.answers ? { answers: ev.answers } : {}) };
    case "interjected":
      return { type: "interjected", messageId: ev.messageId, content: ev.content };
    case "retry":
      return {
        type: "tool_status",
        label:
          ev.reason === "rate_limit"
            ? `Waiting for the plan's limit to clear (retry ${ev.attempt} of ${ev.maxRetries})…`
            : `Retrying the model (attempt ${ev.attempt} of ${ev.maxRetries})…`,
      };
    case "compact":
      return { type: "tool_status", label: "Condensing the agent's context…" };
    default:
      // session / rate_limit / result: consumed by the tool itself.
      return null;
  }
}

/** The three image tools whose progress the UI renders as a placeholder box. */
const IMAGE_TOOLS = new Set(["image_generation", "image_edit", "image_blend"]);
function imageOp(name: string): string {
  return name === "image_edit" ? "edit" : name === "image_blend" ? "blend" : "generate";
}

/** Context threaded through a turn (file tools are injected by the route). */
export interface AssistantCtx {
  signal?: AbortSignal;
  userId?: string;
  /** Enables mid-turn interjections (drained between tool rounds). */
  conversationId?: string;
  extendedThinking?: boolean;
  /** Extra tools (e.g. list_files/read_file) offered to the model. */
  tools?: ToolDef[];
  /** Executes one of `tools`; returns the result fed back to the model.
   *  `emit` (wired per-call by the tool loop) receives live run events —
   *  the sandbox exec tools stream console output through it. */
  executeTool?: (
    name: string,
    args: string,
    emit?: (evt: ToolStreamEvent) => void,
  ) => Promise<string | ToolResultPayload>;
}

/** Drain any queued user messages offered mid-turn and inject them as REAL
 *  user turns: persisted (so reloads read correctly — the message sits above
 *  the reply that answers it), appended to the live transcript (providers
 *  merge consecutive user turns; tool_results stay front-sorted), announced
 *  to the UI, and collected for a possible escalation hand-off. */
async function* applyInterjections(
  ctx: AssistantCtx,
  convo: ChatMessage[],
  applied?: ChatMessage[],
): AsyncGenerator<PipelineChunk> {
  if (!ctx.conversationId) return;
  for (const { id, userId, content } of drainInterjections(ctx.conversationId)) {
    // Persisted as the person who typed it (shared chats: the bubble carries
    // their avatar, and the queue drops its copy by this id).
    const row = await db.message.create({
      data: { conversationId: ctx.conversationId, role: "user", content, userId },
    });
    const turn: ChatMessage = { role: "user", content };
    convo.push(turn);
    applied?.push(turn);
    devLog("info", "chat", "interjection applied mid-turn", {
      conversationId: ctx.conversationId,
      userId,
      content: content.slice(0, 200),
    });
    yield { type: "interjected", messageId: row.id, content, id, userId };
  }
}

/** Run one tool call defensively — a tool bug becomes an error STRING the
 *  model can react to, never a dropped stream. */
async function safeExecuteTool(
  ctx: AssistantCtx,
  name: string,
  args: string,
  emit?: (evt: ToolStreamEvent) => void,
): Promise<ToolResultPayload> {
  try {
    const out = await ctx.executeTool!(name, args, emit);
    return typeof out === "string" ? { text: out } : out;
  } catch (e) {
    return { text: `Error: tool ${name} failed: ${e instanceof Error ? e.message : e}` };
  }
}

/** Append a tool's result to the transcript: the tool message, plus — when the
 *  tool produced images — a user turn carrying them so the model can SEE them
 *  next round (providers can't put images in tool-result messages; Anthropic's
 *  mapping merges this into the same user turn to keep roles alternating). */
function pushToolResult(
  convo: ChatMessage[],
  call: { id: string; name: string },
  result: ToolResultPayload,
): void {
  convo.push({
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: result.text,
  });
  if (result.images?.length) {
    convo.push({
      role: "user",
      content: "(Image attached by the tool for your review — the user did not send a new message.)",
      images: result.images,
    });
  }
}

async function* runRole(
  role: RoleConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; tools?: ToolDef[] },
): AsyncGenerator<ChatChunk> {
  const cred = await loadCredential(role.credentialId);
  if (!cred) {
    devLog("error", "llm", `${role.provider}/${role.model}: missing credential`, { credentialId: role.credentialId });
    yield { type: "error", message: "A configured model's credential is missing." };
    return;
  }
  void touchCredential(role.credentialId).catch(() => {});
  // Instance-wide output ceiling (Admin → Models). Applied HERE so every role
  // — conversation, escalation, failover — gets the same budget regardless of
  // provider or reasoning setting; a per-provider default once truncated real
  // turns mid-tool-call (see limits.ts). Clamped to what this model can
  // actually emit when we've cached its advertised limit, since asking for
  // more than a model supports is a 400 rather than a silent cap.
  const limits = await getCachedTokenLimits();
  // The cache is filled by Admin → Models and expires after an hour, so on a
  // cold process the clamp was simply absent (audit 2026-09-05): a model
  // that advertises less than the instance ceiling 400'd on every turn until
  // an admin happened to open that page. Fetch the list once on a miss —
  // one cheap call, cached for the hour.
  let known = getCachedModels(role.credentialId);
  if (!known) {
    try {
      known = (await getModels(cred)).models;
    } catch {
      known = null;
    }
  }
  const modelCeiling = known?.find((m) => m.id === role.model)?.maxOutputTokens;
  const maxOutputTokens = resolveMaxOutputTokens(limits.maxOutputTokens, modelCeiling);
  // LLM request in: summarise the prompt (roles/sizes, tools) + a preview of
  // the messages (content truncated, images/base64 redacted by dev-log).
  devLog("debug", "llm", `→ ${role.provider}/${role.model}`, {
    reasoning: role.reasoning,
    maxOutputTokens,
    tools: opts.tools?.map((t) => t.name) ?? [],
    messages: messages.map((m) => ({
      role: m.role,
      chars: m.content?.length ?? 0,
      images: m.images?.length ?? 0,
      tool: m.toolName,
      preview: m.content?.slice(0, 300),
    })),
  });
  const t0 = Date.now();
  let text = 0, toolCalls = 0, errored: string | null = null;
  for await (const chunk of streamChat(
    {
      model: role.model,
      messages,
      reasoning: role.reasoning,
      tools: opts.tools,
      signal: opts.signal,
      maxTokens: maxOutputTokens,
    },
    cred,
  )) {
    if (chunk.type === "text") text += chunk.delta.length;
    else if (chunk.type === "tool_call") toolCalls++;
    else if (chunk.type === "error") errored = chunk.message;
    else if (chunk.type === "usage") {
      devLog("info", "llm", `← ${role.provider}/${role.model} (${Date.now() - t0}ms)`, {
        in: chunk.usage.inputTokens, out: chunk.usage.outputTokens,
        cacheRead: chunk.usage.cacheReadTokens, textChars: text, toolCalls,
      });
    }
    yield chunk;
  }
  if (errored) {
    devLog("error", "llm", `✖ ${role.provider}/${role.model} error (${Date.now() - t0}ms)`, { error: errored });
  }
}

/** Stream a single role's reply, tagging usage with the role label. */
async function* streamRoleAs(
  role: RoleConfig,
  label: AssistantRole,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<PipelineChunk> {
  try {
    for await (const chunk of runRole(role, messages, { signal })) {
      if (chunk.type === "text") yield { type: "text", delta: chunk.delta };
      else if (chunk.type === "thinking") yield { type: "thinking", delta: chunk.delta };
      else if (chunk.type === "usage")
        yield { type: "usage", role: label, provider: role.provider, model: role.model, usage: chunk.usage };
      else if (chunk.type === "error") yield { type: "error", message: chunk.message };
    }
  } catch (e) {
    if (isAbortError(e, signal)) return;
    yield { type: "error", message: e instanceof Error ? e.message : "Model request failed." };
  }
}

/**
 * Stream a role with the file-tool loop: buffer tool calls, execute them,
 * feed results back, and re-invoke — up to the configured round budget, then one final
 * round with the tools withheld so the model must answer. Used by the
 * escalation hand-off (the conversation role has its own loop with
 * failover/escalation semantics woven in).
 */
async function* streamRoleWithTools(
  config: AssistantConfig,
  role: RoleConfig,
  label: AssistantRole,
  messages: ChatMessage[],
  ctx: AssistantCtx,
): AsyncGenerator<PipelineChunk> {
  const fileTools = ctx.tools ?? [];
  if (fileTools.length === 0 || !ctx.executeTool) {
    yield* streamRoleAs(role, label, messages, ctx.signal);
    return;
  }
  const convo: ChatMessage[] = [...messages];
  const runs = new ToolRunTracker();
  const maxRounds = await toolRoundBudget();
  let producedText = false;
  try {
    for (let round = 0; round <= maxRounds; round++) {
      if (ctx.signal?.aborted) return; // Stop means stop — see the main loop
      if (round > 0) {
        yield* applyInterjections(ctx, convo);
        const cur = await curateOldToolResults(config, convo);
        if (cur.usage) {
          yield { type: "usage", role: "curator", provider: cur.provider ?? "unknown", model: cur.model ?? "frontend", usage: cur.usage };
        }
      }
      const finalRound = round === maxRounds;
      const offer = finalRound ? undefined : fileTools;
      const roundInput = finalRound
        ? [...convo, { role: "user" as const, content: FINAL_ROUND_NOTICE }]
        : convo;
      // Same guard the conversation loop has: only run what was OFFERED this
      // round. On the final round nothing is, and models do imitate the
      // tool_use blocks already in their own transcript — so without this the
      // escalation model could execute a tool that was deliberately withheld,
      // `delete_file` included.
      const offeredNames = new Set((offer ?? []).map((t) => t.name));
      const calls: { id: string; name: string; args: string; signature?: string }[] = [];
      let roundText = "";
      for await (const chunk of runRole(role, roundInput, { signal: ctx.signal, tools: offer })) {
        if (chunk.type === "tool_call") {
          if (offeredNames.has(chunk.name)) {
            calls.push({ id: chunk.id, name: chunk.name, args: chunk.arguments, signature: chunk.signature });
          }
          // Keep consuming either way so usage still lands.
        } else if (chunk.type === "tool_call_delta") {
          // Live code preview: partial args stream as the model writes them.
          for (const e of runs.feedDelta(chunk.callId, chunk.name, chunk.argsDelta)) yield e;
        } else if (chunk.type === "text") {
          producedText = true;
          roundText += chunk.delta;
          yield { type: "text", delta: chunk.delta };
        } else if (chunk.type === "thinking") {
          yield { type: "thinking", delta: chunk.delta };
        } else if (chunk.type === "usage") {
          yield { type: "usage", role: label, provider: role.provider, model: role.model, usage: chunk.usage };
        } else if (chunk.type === "error") {
          yield { type: "error", message: chunk.message };
          return;
        }
      }
      if (ctx.signal?.aborted) return; // Stop means stop — see the main loop
      if (calls.length === 0) break;
      convo.push({
        role: "assistant",
        content: roundText,
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args, signature: c.signature })),
      });
      for (const call of calls) {
        yield* emitToolCall(ctx, convo, call, runs);
      }
    }
  } catch (e) {
    if (isAbortError(e, ctx.signal)) return;
    yield { type: "error", message: e instanceof Error ? e.message : "Model request failed." };
    return;
  }

  if (!producedText) {
    // Same guarantee as the conversation loop: a tool-burning run must still
    // end in words, never an empty reply.
    devLog("warn", "chat", "escalation tool loop produced no text — forcing an answer", {
      model: role.model,
    });
    yield* streamRoleAs(
      role,
      label,
      [...convo, { role: "user", content: FORCED_ANSWER_NOTICE }],
      ctx.signal,
    );
  }
}

/**
 * Execute a tool that emits events WHILE it runs, draining them into the
 * pipeline stream as they happen instead of after the await.
 *
 * Two tools need this and they need it for opposite reasons: the sandbox exec
 * family pushes console output up as it arrives, and `ask_user` raises its
 * question card and then blocks on the answer — in both cases waiting for the
 * result before yielding anything would defeat the whole point. `map` turns a
 * tool event into a pipeline chunk (null = swallow it). The generator's RETURN
 * value is the tool result, so callers use `const r = yield* streamingExecute(…)`.
 */
async function* streamingExecute(
  ctx: AssistantCtx,
  call: { id: string; name: string; args: string },
  map: (evt: ToolStreamEvent) => PipelineChunk | null,
): AsyncGenerator<PipelineChunk, ToolResultPayload> {
  const pending: ToolStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const resultP = safeExecuteTool(ctx, call.name, call.args, (e) => {
    pending.push(e);
    wake?.();
  }).finally(() => {
    settled = true;
    wake?.();
  });
  for (;;) {
    while (pending.length > 0) {
      const chunk = map(pending.shift()!);
      if (chunk) yield chunk;
    }
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  return await resultP;
}

/** Announce a tool call to the UI, execute it, surface its side-events
 *  (image placeholder/result, sources, live run events, question cards), and
 *  append the result to `convo`. Shared by both tool loops. */
async function* emitToolCall(
  ctx: AssistantCtx,
  convo: ChatMessage[],
  call: { id: string; name: string; args: string },
  runs?: ToolRunTracker,
): AsyncGenerator<PipelineChunk> {
  const isImage = IMAGE_TOOLS.has(call.name);
  const isRun = runs?.isRun(call.name) ?? false;
  const isAsk = call.name === "ask_user";
  const isAgent = call.name === AGENT_TOOL;
  if (isImage) {
    // The aspect-ratio placeholder box IS the status for image tools.
    let aspectRatio = "1:1";
    let prompt = "";
    try {
      const a = JSON.parse(call.args || "{}");
      if (typeof a.aspect_ratio === "string") aspectRatio = a.aspect_ratio;
      if (typeof a.prompt === "string") prompt = a.prompt;
    } catch {
      /* defaults */
    }
    yield { type: "image_start", id: call.id, aspectRatio, prompt, operation: imageOp(call.name) };
  } else if (isRun) {
    // The run block IS the status for the sandbox family. Normally its start
    // + code already streamed from the arg deltas; this is the fallback for
    // a call whose deltas never arrived.
    for (const e of runs!.ensureStarted(call.id, call.name, call.args)) yield e;
  } else if (call.name !== "enable_tools" && !isAsk) {
    // enable_tools is plumbing (progressive disclosure) — not user-facing, and
    // the ask_user card is its own, much louder status.
    yield { type: "tool_status", label: toolStatusLabel(call.name, call.args) };
  }

  let result: ToolResultPayload;
  if (isRun) {
    // The exec tools push console chunks up as they happen.
    result = yield* streamingExecute(ctx, call, (e) =>
      e.kind === "exec"
        ? { type: "run_exec", id: call.id, command: e.command }
        : e.kind === "out"
          ? { type: "run_out", id: call.id, delta: e.delta }
          : null,
    );
    yield {
      type: "run_done",
      id: call.id,
      ...(result.runMeta?.diff ? { diff: result.runMeta.diff } : {}),
      ...(result.runMeta?.exec ? { exec: result.runMeta.exec } : {}),
      ...(result.text.startsWith("Error:")
        ? { error: userFacingToolError(result.text).slice(0, 300) }
        : {}),
    };
  } else if (isAsk) {
    // The card goes up mid-execution, then the tool parks on the answer — so
    // the events have to flow before the await, not after it.
    result = yield* streamingExecute(ctx, call, (e) =>
      e.kind === "ask" ? { type: "ask", id: e.id, questions: e.questions } : null,
    );
    if (result.askResult) {
      yield {
        type: "ask_done",
        id: result.askResult.id,
        status: result.askResult.status,
        ...(result.askResult.answers ? { answers: result.askResult.answers } : {}),
        ...(result.askResult.by ? { by: result.askResult.by } : {}),
      };
    }
  } else if (isAgent) {
    // The whole agent run streams up through here: its inner tool uses as
    // run blocks, narration as status lines, hand-overs, usage, and any
    // question card it raises (which parks the run exactly like ask_user).
    result = yield* streamingExecute(ctx, call, (e) =>
      e.kind === "agent"
        ? agentChunk(e.event)
        : e.kind === "ask"
          ? { type: "ask", id: e.id, questions: e.questions }
          : null,
    );
  } else {
    result = await safeExecuteTool(ctx, call.name, call.args);
  }

  if (result.sources?.length) yield { type: "sources", sources: result.sources };
  if (result.presented?.length) yield { type: "files_presented", names: result.presented };
  if (isImage) {
    if (result.artifact) yield { type: "image_done", id: call.id, artifact: result.artifact };
    else yield { type: "image_error", id: call.id, message: userFacingToolError(result.text).slice(0, 200) };
  }
  pushToolResult(convo, call, result);
}

/**
 * Run the assistant for one user turn: the conversation model (offered an
 * `escalate` tool when an escalation model is configured), with failover on an
 * early error and an escalation hand-off when the tool is called.
 */
export async function* runAssistant(
  config: AssistantConfig,
  messages: ChatMessage[],
  ctx: AssistantCtx,
): AsyncGenerator<PipelineChunk> {
  const convoCfg = config.roles.conversation;
  if (!convoCfg) {
    yield { type: "error", message: "The assistant has no conversation model configured." };
    return;
  }
  // The user's "think harder" toggle swaps in the admin-defined extended
  // reasoning level. Server-authoritative — the client only sends a boolean.
  const convo: RoleConfig =
    ctx.extendedThinking && convoCfg.reasoningExtended
      ? { ...convoCfg, reasoning: convoCfg.reasoningExtended }
      : convoCfg;
  const escalation = config.roles.escalation;
  const failover = config.roles.failover;

  // Live reference — enable_tools (progressive disclosure) grows this array
  // mid-turn, so per-round state (offered/names) is recomputed each round.
  const fileTools = ctx.executeTool ? (ctx.tools ?? []) : [];
  // Escalation guidance goes AFTER the caller's leading system blocks, not
  // before them: the first of those is the assistant's identity + the admin's
  // standing instructions (Admin → Customise), and who the assistant IS should
  // open the system prompt rather than trail internal plumbing.
  const convoMessages: ChatMessage[] = [...messages];
  if (escalation) {
    let at = 0;
    while (at < convoMessages.length && convoMessages[at].role === "system") at++;
    convoMessages.splice(at, 0, { role: "system", content: ESCALATE_SYSTEM });
  }

  let producedText = false;
  let escalate = false;
  let escalateReason = "";
  const runs = new ToolRunTracker();
  // User messages injected mid-turn — carried into an escalation hand-off
  // (which replays the ORIGINAL history, not the tool transcript).
  const interjected: ChatMessage[] = [];
  const maxRounds = await toolRoundBudget();

  try {
    // Tool loop: rounds 0..MAX-1 offer the file tools; the final round
    // withholds them (escalate stays available) so the model must answer.
    rounds: for (let round = 0; round <= maxRounds; round++) {
      // A Stop that landed while a tool ran (a Sandbox job, a search) must
      // not buy the model another round — seen in the harness log as a
      // model call 2 ms after "stop requested" (audit 2026-09-05).
      if (ctx.signal?.aborted) return;
      // Between tool rounds: inject any message the user queued while tools
      // ran (course-corrections land BEFORE the next round, not next turn),
      // then compress older bulky tool results once the transcript is heavy.
      if (round > 0) {
        yield* applyInterjections(ctx, convoMessages, interjected);
        const cur = await curateOldToolResults(config, convoMessages);
        if (cur.usage) {
          yield { type: "usage", role: "curator", provider: cur.provider ?? "unknown", model: cur.model ?? "frontend", usage: cur.usage };
        }
      }
      const finalRound = round === maxRounds;
      const offered: ToolDef[] = [
        ...(escalation ? [ESCALATE_TOOL] : []),
        ...(finalRound ? [] : fileTools),
      ];
      const offeredNames = new Set(offered.map((t) => t.name));
      const calls: { id: string; name: string; args: string; signature?: string }[] = [];
      let roundText = "";
      // Final round: tell the model the budget is spent, so it answers
      // instead of attempting tool calls that would be dropped.
      const roundInput = finalRound
        ? [
            ...convoMessages,
            {
              role: "user" as const,
              content: escalation ? FINAL_ROUND_NOTICE_ESCALATE : FINAL_ROUND_NOTICE,
            },
          ]
        : convoMessages;

      for await (const chunk of runRole(convo, roundInput, {
        signal: ctx.signal,
        tools: offered.length ? offered : undefined,
      })) {
        if (chunk.type === "tool_call") {
          if (chunk.name === "escalate" && escalation) {
            escalate = true;
            try {
              escalateReason = String(JSON.parse(chunk.arguments || "{}").reason ?? "");
            } catch {
              /* reason optional */
            }
          } else if (offeredNames.has(chunk.name)) {
            calls.push({ id: chunk.id, name: chunk.name, args: chunk.arguments, signature: chunk.signature });
          }
          // Keep consuming the stream either way so the model's usage (which
          // arrives after the tool call) is still recorded — nothing skipped.
        } else if (chunk.type === "tool_call_delta") {
          // Live code preview: partial args stream as the model writes them.
          if (!escalate && offeredNames.has(chunk.name)) {
            for (const e of runs.feedDelta(chunk.callId, chunk.name, chunk.argsDelta)) yield e;
          }
        } else if (chunk.type === "text") {
          // Once escalating, suppress the conversation model's partial text;
          // the escalation model produces the real answer.
          if (!escalate) {
            producedText = true;
            roundText += chunk.delta;
            yield { type: "text", delta: chunk.delta };
          }
        } else if (chunk.type === "thinking") {
          if (!escalate) yield { type: "thinking", delta: chunk.delta };
        } else if (chunk.type === "usage") {
          // Always recorded — even on an escalated turn (input tokens were spent).
          yield { type: "usage", role: "conversation", provider: convo.provider, model: convo.model, usage: chunk.usage };
        } else if (chunk.type === "error") {
          // Only fail over for transient problems (outage / rate limit). A
          // client error (4xx — bad params, auth, model) is a config bug:
          // surface it so the admin fixes it instead of silently switching.
          if (!producedText && failover && chunk.retryable !== false && !ctx.signal?.aborted) {
            await appLog("warn", "failover", "Conversation model failed; switching to failover.", {
              userId: ctx.userId,
              details: { error: chunk.message, from: convo.model, to: failover.model },
            });
            yield { type: "notice", message: "Switched to the failover model." };
            // Mid-turn interjections ride along (the user already sees them
            // above the reply; escalation carries them the same way).
            yield* streamRoleAs(failover, "failover", [...messages, ...interjected], ctx.signal);
            return;
          }
          if (chunk.retryable === false) {
            await appLog("error", "chat", "Conversation model rejected the request.", {
              userId: ctx.userId,
              details: { error: chunk.message, model: convo.model },
            });
          }
          yield { type: "error", message: chunk.message };
          return;
        }
      }

      // Stop means stop (audit 2026-09-05): the provider swallows the abort
      // and returns normally, so calls buffered before the user pressed Stop
      // would otherwise still run — two image generations billed and counted
      // against the quota after the user gave up on them.
      if (ctx.signal?.aborted) return;
      if (escalate || calls.length === 0) break rounds;

      // Execute the buffered file-tool calls and loop with the results.
      convoMessages.push({
        role: "assistant",
        content: roundText,
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args, signature: c.signature })),
      });
      for (const call of calls) {
        yield* emitToolCall(ctx, convoMessages, call, runs);
      }
    }
  } catch (e) {
    if (isAbortError(e, ctx.signal)) return;
    if (!producedText && failover && isRetryableError(e)) {
      await appLog("warn", "failover", "Conversation model threw; switching to failover.", {
        userId: ctx.userId,
        details: { error: String(e), from: convo.model, to: failover.model },
      });
      yield { type: "notice", message: "Switched to the failover model." };
      yield* streamRoleAs(failover, "failover", messages, ctx.signal);
      return;
    }
    yield { type: "error", message: e instanceof Error ? e.message : "Conversation model failed." };
    return;
  }

  if (escalate && escalation) {
    await appLog("info", "escalation", "Conversation model escalated to a stronger model.", {
      userId: ctx.userId,
      details: { from: convo.model, to: escalation.model },
    });
    yield { type: "notice", message: "Escalated to a more capable model." };
    // The heavyweight gets the file tools too — it answers the real question.
    // Mid-turn interjections ride along (the hand-off replays the original
    // history, which wouldn't contain them). The trailing user-role context
    // note tells it that IT is the escalation (system text would be hoisted
    // to the top and lose salience).
    yield* streamRoleWithTools(
      config,
      escalation,
      "escalation",
      [...messages, ...interjected, { role: "user", content: escalationContext(escalateReason) }],
      ctx,
    );
    return;
  }

  if (!producedText && !ctx.signal?.aborted) {
    // Every round went on tool calls (or on dropped, no-longer-offered ones)
    // and the model never wrote a word — seen live: 6 web searches, then an
    // unoffered 7th attempt in the final round, then silence, and the user got
    // an EMPTY reply. One tool-free pass with an explicit instruction makes an
    // empty turn impossible short of a provider failure.
    devLog("warn", "chat", "tool loop produced no text — forcing an answer", {
      userId: ctx.userId,
      model: convo.model,
    });
    yield* streamRoleAs(
      convo,
      "conversation",
      [...convoMessages, { role: "user", content: FORCED_ANSWER_NOTICE }],
      ctx.signal,
    );
  }
}

/** Run a role to completion (non-streamed) — for titles & follow-ups. */
export async function runCompletion(
  role: RoleConfig,
  messages: ChatMessage[],
  maxTokens?: number,
): Promise<{ text: string; usage: TokenUsage | null }> {
  const cred = await loadCredential(role.credentialId);
  if (!cred) throw new Error("Role credential not found.");
  void touchCredential(role.credentialId).catch(() => {});
  // Same firehose line as runRole. Without it the front-end role's calls
  // (titles, follow-ups, curation summaries) were invisible in dev.log — the
  // one place you look when something is wrong, missing a whole role.
  devLog("debug", "llm", `→ ${role.provider}/${role.model}`, {
    reasoning: role.reasoning,
    maxOutputTokens: maxTokens,
    tools: [],
    messages: messages.map((m) => ({
      role: m.role,
      chars: m.content?.length ?? 0,
      images: m.images?.length ?? 0,
      tool: m.toolName,
      preview: m.content?.slice(0, 300),
    })),
  });
  const t0 = Date.now();
  let text = "";
  let usage: TokenUsage | null = null;
  for await (const chunk of streamChat(
    { model: role.model, messages, reasoning: role.reasoning, maxTokens },
    cred,
  )) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "error") throw new Error(chunk.message);
  }
  devLog("info", "llm", `← ${role.provider}/${role.model} (${Date.now() - t0}ms)`, {
    in: usage?.inputTokens,
    out: usage?.outputTokens,
    textChars: text.length,
  });
  return { text, usage };
}

/** Persist a usage row tagged with the pipeline role. Returns the USD cost
 *  actually charged — $0.00 for a subscription-billed call, whose API-rate
 *  value is kept on the row as `notionalCost` instead (see usage-math.ts). */
export async function recordUsage(opts: {
  userId: string;
  role: UsageRole;
  provider: string;
  model: string;
  usage: TokenUsage;
  billingSource?: BillingSource;
  agentSessionId?: string;
}): Promise<number> {
  const { costEstimate, notionalCost } = usageRowCosts(
    opts.billingSource ?? "api",
    estimateCost(opts.model, opts.usage),
  );
  await db.usageRecord.create({
    data: {
      userId: opts.userId,
      role: opts.role,
      provider: opts.provider,
      model: opts.model,
      inputTokens: opts.usage.inputTokens,
      outputTokens: opts.usage.outputTokens,
      cacheReadTokens: opts.usage.cacheReadTokens,
      cacheWriteTokens: opts.usage.cacheWriteTokens,
      costEstimate,
      billingSource: opts.billingSource ?? "api",
      ...(notionalCost !== null ? { notionalCost } : {}),
      ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
    },
  });
  return costEstimate;
}

const TITLE_SYSTEM =
  "Generate a very short conversation title: 2–5 words in Sentence case, prefixed with ONE relevant emoji and a space. No quotes, no trailing punctuation. Example: 🐈 Story about a cat";

/** Front-end model: a 2–5 word emoji title for a new conversation. */
export async function generateTitle(
  config: AssistantConfig,
  userMessage: string,
  assistantMessage: string,
): Promise<{ title: string; usage: TokenUsage | null; role: RoleConfig } | null> {
  const role = config.roles.frontend ?? config.roles.conversation;
  if (!role) return null;
  const messages: ChatMessage[] = [
    { role: "system", content: TITLE_SYSTEM },
    {
      role: "user",
      content: `User: ${userMessage}\n\nAssistant: ${assistantMessage}`.slice(0, 4000),
    },
  ];
  try {
    // 1000, not 24: the front-end role may be a REASONING model (the owner's
    // dev box runs gpt-5.6-luna there), and reasoning tokens count against
    // max_tokens — at 24 every title came back EMPTY (textChars 0). The
    // prompt still caps the title at 2–5 words; the budget just has to leave
    // room to think first.
    const { text, usage } = await runCompletion(role, messages, 1000);
    const title = text
      .trim()
      .replace(/\n[\s\S]*$/, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .slice(0, 60);
    return title ? { title, usage, role } : null;
  } catch {
    return null;
  }
}

const FOLLOWUP_SYSTEM =
  "Suggest exactly 3 short follow-up messages the user might send next, written in the user's first-person voice (e.g. 'Expand this into a longer story'). Each 3–9 words. Return ONLY a JSON array of 3 strings.";

/** Front-end model: up to 3 follow-up suggestions for an idle conversation. */
export async function generateFollowups(
  config: AssistantConfig,
  history: ChatMessage[],
): Promise<{ suggestions: string[]; usage: TokenUsage | null; role: RoleConfig } | null> {
  const role = config.roles.frontend ?? config.roles.conversation;
  if (!role) return null;
  const convo = history.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-4000);
  const messages: ChatMessage[] = [
    { role: "system", content: FOLLOWUP_SYSTEM },
    { role: "user", content: convo },
  ];
  try {
    // Same reasoning-model headroom as titles (see generateTitle).
    const { text, usage } = await runCompletion(role, messages, 1000);
    const match = text.match(/\[[\s\S]*\]/);
    let suggestions: string[] = [];
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr))
        suggestions = arr.filter((x) => typeof x === "string").slice(0, 3);
    }
    return { suggestions, usage, role };
  } catch {
    return null;
  }
}
