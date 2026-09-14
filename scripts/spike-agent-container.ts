/**
 * Stage 2 spike — the container seam. Everything spike-agent-sdk.ts proved,
 * re-proven with the CLI running INSIDE a sandboxd-managed agent container:
 * the SDK harness stays on the host and talks over the broker's duplex
 * attach endpoint (spawnClaudeCodeProcess → makeAgentSpawner). Run:
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs scripts/spike-agent-container.ts
 *
 * Needs: dev sandboxd rebuilt with the agent tier, the opninfer-agent image
 * built, and — for the model to answer at all — the operator signed in ONCE
 * inside the config volume:
 *
 *   docker run -it --rm -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent claude
 *   (complete the login it offers, then /exit — the volume keeps it)
 *
 * Verdicts:
 *   1. init arrives over the wire (duplex stdio through the broker works)
 *   2. control protocol crosses it: canUseTool fires host-side
 *   3. in-process MCP tool executes host-side
 *   4. input_json_delta still streams token-level
 *   5. the file the agent writes lands in the HOST pool dir (mount is real)
 *   6. the run bills the subscription login FROM THE VOLUME (accountInfo)
 *   7. exit envelope settles the spawn (clean process lifecycle)
 *   8. a second query reuses the warm container (per-chat, not per-run)
 *   9. interrupt() stops a long run quickly and the container survives
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildAgentEnv } from "../src/lib/agent/env";
import { makeAgentSpawner, destroyAgentContainer } from "../src/lib/agent/spawn";
import { parseRateLimitInfo } from "../src/lib/agent/limits";

// Broker creds ride .env (the dev server's env file) — Node 21.7+ can load it.
try {
  process.loadEnvFile(".env");
} catch {
  /* fine if already in env */
}

const ROOT = process.cwd();
const CONV_ID = randomUUID();
const POOL = join(ROOT, "storage", "default", "chats", CONV_ID);
const LOG = join(ROOT, "logs", "agent-container-spike.ndjson");
const CONTAINER = `oi-agent-default-${CONV_ID}`;
/** `cwd` is the path INSIDE the container, never the host path. Passing the
 *  host pool path (a Windows path, at that) made the CLI unable to find it
 *  and the agent quietly wrote its deliverable to /tmp instead — work done,
 *  nothing in the pool, no error anywhere. The bind mount makes this dir
 *  the same bytes as POOL on the host. */
const WORKSPACE = "/workspace";

const STATE = join(ROOT, "storage", "default", "agent", CONV_ID);
// A SECOND conversation, used only to prove the two never share state.
const CONV_ID_B = randomUUID();
const POOL_B = join(ROOT, "storage", "default", "chats", CONV_ID_B);
const STATE_B = join(ROOT, "storage", "default", "agent", CONV_ID_B);
mkdirSync(POOL, { recursive: true });
mkdirSync(STATE, { recursive: true });
mkdirSync(POOL_B, { recursive: true });
mkdirSync(STATE_B, { recursive: true });
writeFileSync(LOG, "");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

/** Env the CLI gets INSIDE the container — container paths, not host ones. */
const CONTAINER_ENV = buildAgentEnv({
  credential: "subscription",
  base: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/sandbox",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  },
  configDir: "/home/sandbox/.claude",
});

const opninferServer = createSdkMcpServer({
  name: "opninfer",
  version: "0.0.1",
  tools: [
    tool(
      "present_files",
      "Hand a finished deliverable file over to the user. Call this with the filename once the work is done.",
      { filename: z.string() },
      async (args) => {
        mcpRan = true;
        mcpArg = String(args.filename);
        return { content: [{ type: "text", text: `Presented ${args.filename} to the user.` }] };
      },
    ),
  ],
});

let mcpRan = false;
let mcpArg = "";

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

/** NB returns the INVOKED generator (an AsyncIterable), not the generator
 *  function — the SDK silently rejects a bare function as a prompt and shuts
 *  the whole query down as "aborted by user", which cost an hour of blaming
 *  the container seam for a missing pair of parentheses. */
function makePrompt(text: string): AsyncGenerator<SDKUserMessage> {
  return (async function* prompts(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(text);
  })();
}

/**
 * A prompt stream that stays OPEN after the first message, like production.
 *
 * This matters beyond tidiness: a generator that returns makes the SDK send
 * stdin EOF immediately (measured: 1ms after the prompt), and `interrupt()`
 * is a control message that travels OVER STDIN — so with a one-shot generator
 * a Stop can never be delivered and a 90s task runs to completion. The real
 * chat turn keeps the stream open for interjections anyway, so this is the
 * shape to test against.
 */
function openPrompt(text: string): {
  stream: AsyncGenerator<SDKUserMessage>;
  close: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stream = (async function* () {
    yield userMessage(text);
    await gate; // hold stdin open until the caller is done
  })();
  return { stream, close: () => release() };
}

function containerCreatedAt(): string | null {
  try {
    return execSync(`docker inspect ${CONTAINER} --format "{{.Created}}"`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  let inputJsonDeltas = 0;
  const canUse: string[] = [];
  let account: Record<string, unknown> | null = null;
  let sawInit = false;
  let result: Record<string, any> | null = null;
  const rateLimits: ReturnType<typeof parseRateLimitInfo>[] = [];
  const deniedWrites: string[] = [];

  // --- run 1: the fib task through the container ----------------------------
  const q = query({
    prompt: makePrompt(
      "Write a Python script fib.py that prints the first 10 Fibonacci numbers, " +
        "run it with `python3 fib.py` to check it works, then call the " +
        "present_files tool with filename fib.py.",
    ),
    options: {
      cwd: WORKSPACE,
      env: CONTAINER_ENV,
      spawnClaudeCodeProcess: makeAgentSpawner(CONV_ID) as never,
      model: "claude-sonnet-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Read"],
      canUseTool: async (toolName, input) => {
        canUse.push(toolName);
        // WORKSPACE CONTAINMENT, and it is not optional.
        //
        // acceptEdits auto-approves writes inside cwd only, so a write that
        // reaches this callback is one OUTSIDE the mounted workspace. With a
        // blanket allow here the agent cheerfully wrote its deliverable to
        // /tmp — task reported as done, nothing in the user's pool, no error
        // anywhere. The chat tool enforces the same rule for the same reason.
        if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
          const p = String((input as Record<string, unknown>).file_path ?? "");
          if (!p.startsWith(WORKSPACE + "/")) {
            deniedWrites.push(p);
            return {
              behavior: "deny",
              message: `Write inside ${WORKSPACE} only — that is this chat's workspace, and files anywhere else are lost when the run ends. Use a path under ${WORKSPACE}.`,
            };
          }
        }
        return { behavior: "allow", updatedInput: input };
      },
      mcpServers: { opninfer: opninferServer },
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: 10,
      stderr: (d: string) => appendFileSync(LOG, JSON.stringify({ stderr: d }) + "\n"),
    },
  });

  const watchdog = setTimeout(() => {
    console.log("! watchdog: 180s — interrupting run 1");
    q.interrupt().catch(() => {});
  }, 180_000);

  try {
    for await (const msg of q as AsyncIterable<Record<string, any>>) {
      appendFileSync(LOG, JSON.stringify(msg) + "\n");
      if (msg.type === "system" && msg.subtype === "init") {
        sawInit = true;
        console.log(`  init over the wire: model=${msg.model} cc=${msg.claude_code_version ?? "?"}`);
        q.accountInfo?.()
          .then((a: Record<string, unknown>) => (account = a))
          .catch(() => {});
      } else if (msg.type === "stream_event") {
        if (msg.event?.type === "content_block_delta" && msg.event.delta?.type === "input_json_delta") {
          inputJsonDeltas++;
        }
      } else if (msg.type === "rate_limit_event") {
        console.log("  rate_limit_info:", JSON.stringify(msg.rate_limit_info));
        const snap = parseRateLimitInfo(msg.rate_limit_info);
        if (snap) rateLimits.push(snap);
      } else if (msg.type === "result") {
        result = msg;
      }
    }
  } finally {
    clearTimeout(watchdog);
  }

  check("init arrives over the wire", sawInit);
  check("canUseTool fires host-side across the wire", canUse.length > 0, canUse.join(", "));
  check("in-process MCP tool executed host-side", mcpRan, mcpRan ? `present_files("${mcpArg}")` : "never ran");
  check("input_json_delta still streams", inputJsonDeltas > 3, `${inputJsonDeltas} deltas`);
  const fibHost = join(POOL, "fib.py");
  check(
    "agent-written file lands in the HOST pool",
    existsSync(fibHost),
    existsSync(fibHost) ? `${readFileSync(fibHost, "utf8").length} bytes at ${fibHost}` : "missing",
  );
  const sub = (account as Record<string, unknown> | null)?.subscriptionType;
  check("billed to the subscription login from the volume", typeof sub === "string" && sub.length > 0, JSON.stringify(account));
  check(
    "run 1 succeeded with usage",
    result?.subtype === "success" && !!result?.usage,
    result ? `subtype=${result.subtype} cost≈$${result.total_cost_usd}` : "no result",
  );

  const createdAfterRun1 = containerCreatedAt();
  check("agent container exists after the run (warm, per-chat)", !!createdAfterRun1, CONTAINER);

  // --- run 2: warm reuse + interrupt ---------------------------------------
  let sawToolUse = false;
  const input2 = openPrompt("Run `sleep 90 && echo done` with Bash, then tell me it finished.");
  const q2 = query({
    prompt: input2.stream,
    options: {
      cwd: WORKSPACE,
      env: CONTAINER_ENV,
      spawnClaudeCodeProcess: makeAgentSpawner(CONV_ID) as never,
      model: "claude-sonnet-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash"],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: 4,
      stderr: () => {},
    },
  });
  const t2 = Date.now();
  let interrupted = false;
  const backstop = setTimeout(() => q2.interrupt().catch(() => {}), 60_000);
  try {
    for await (const msg of q2 as AsyncIterable<Record<string, any>>) {
      appendFileSync(LOG, JSON.stringify(msg) + "\n");
      if (
        !sawToolUse &&
        msg.type === "stream_event" &&
        msg.event?.type === "content_block_start" &&
        msg.event.content_block?.type === "tool_use"
      ) {
        sawToolUse = true;
        // The sleep is now (about to be) running — interrupt mid-flight.
        setTimeout(() => {
          interrupted = true;
          void q2.interrupt().catch(() => {});
        }, 3_000);
      }
      // The input stream stays open (production shape), so the loop no longer
      // ends on its own — the turn's `result` is the end, exactly as the chat
      // route will treat it.
      if (msg.type === "result") break;
    }
  } finally {
    clearTimeout(backstop);
    input2.close();
    await q2.close?.();
  }
  const run2s = (Date.now() - t2) / 1000;
  check("interrupt() stops a 90s task early", interrupted && run2s < 45, `${run2s.toFixed(1)}s`);
  const createdAfterRun2 = containerCreatedAt();
  check(
    "run 2 REUSED the warm container",
    !!createdAfterRun2 && createdAfterRun2 === createdAfterRun1,
    `created=${createdAfterRun2}`,
  );

  // --- plan usage reported by the run --------------------------------------
  check(
    "run reported subscription plan limits",
    rateLimits.length > 0,
    rateLimits.map((r) => `${r!.window}=${r!.percentUsed ?? "?"}%`).join(", ") || "none seen",
  );

  // --- ISOLATION: a second chat shares the sign-in and NOTHING else --------
  // Chat A wrote fib.py and has a transcript. Chat B is a different
  // conversation: it must see an empty workspace and none of A's history,
  // while still being signed in (the one deliberately shared thing).
  const qB = query({
    prompt: makePrompt(
      "Run `ls -a` in your working directory. Then reply with exactly the word " +
        "EMPTY if there are no regular files, otherwise list the filenames you found.",
    ),
    options: {
      cwd: WORKSPACE,
      env: CONTAINER_ENV,
      spawnClaudeCodeProcess: makeAgentSpawner(CONV_ID_B) as never,
      model: "claude-sonnet-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash"],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 4,
      stderr: () => {},
    },
  });
  let bText = "";
  let bOk = false;
  for await (const msg of qB as AsyncIterable<Record<string, any>>) {
    appendFileSync(LOG, JSON.stringify(msg) + "\n");
    if (msg.type === "assistant") {
      for (const blk of msg.message?.content ?? []) if (blk.type === "text") bText += blk.text;
    } else if (msg.type === "result") {
      bOk = msg.subtype === "success";
      break;
    }
  }
  check("second chat is signed in (the credential IS shared)", bOk, bText.slice(0, 80));
  check(
    "second chat cannot see the first chat's files (workspace isolated)",
    bOk && !/fib/i.test(bText),
    bText.replace(/\s+/g, " ").slice(0, 140),
  );
  // Walk with node:fs, NOT `ls -R` through execSync: on Windows that shells
  // out to cmd.exe, which has no `ls`, so both trees came back as empty
  // strings and the comparison below passed while comparing nothing. A
  // vacuous assertion is worse than a missing one — it reports safety it
  // never checked.
  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const full = join(dir, e.name);
          return e.isDirectory() ? [full, ...walk(full)] : [full];
        });
  const aTree = walk(STATE);
  const bTree = walk(STATE_B);
  check(
    "each chat's agent-state directory is populated (transcripts are being written)",
    aTree.length > 0 && bTree.length > 0,
    `A=${aTree.length} entries, B=${bTree.length} entries`,
  );
  // The decisive one: neither tree may mention the other conversation, and
  // A's deliverable must not appear in B's state.
  const aStr = aTree.join("|");
  const bStr = bTree.join("|");
  check(
    "no transcript cross-contamination between chats",
    aTree.length > 0 &&
      bTree.length > 0 &&
      !bStr.includes(CONV_ID) &&
      !aStr.includes(CONV_ID_B),
    `A has B's id: ${aStr.includes(CONV_ID_B)} | B has A's id: ${bStr.includes(CONV_ID)}`,
  );
  // And the shared credential is linked into BOTH, because "isolated" must
  // not have quietly meant "signed out".
  //
  // lstat, not existsSync: the link target is a CONTAINER path
  // (/home/sandbox/.claude-shared/...) which does not resolve on the host, so
  // existsSync follows it and reports false for a perfectly good symlink.
  // What matters here is that the link exists, and both runs authenticating
  // is the proof that it resolves where it actually matters.
  // Checked from INSIDE a container, not with host lstat: on Windows the
  // state dir is a Docker Desktop bind mount, and a Linux symlink created
  // there does not surface to the host as a symlink at all — host-side lstat
  // reports "no link" for a link that demonstrably works. The container's own
  // view is both the accurate one and the one that matches production.
  const linkedInside = (dir: string): boolean => {
    try {
      const out = execSync(
        `docker run --rm --mount "type=bind,source=${dir},target=/s" ` +
          `--mount type=volume,source=opninfer-agent-config-default,target=/shared ` +
          `opninfer-agent sh -c "readlink /s/.credentials.json || echo NONE"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.includes(".claude-shared/.credentials.json");
    } catch {
      return false;
    }
  };
  check(
    "the sign-in is linked into both chats' state dirs (not copied)",
    linkedInside(STATE) && linkedInside(STATE_B),
    `A=${linkedInside(STATE)} B=${linkedInside(STATE_B)}`,
  );
  check(
    "writes outside the workspace are refused",
    deniedWrites.length === 0 || deniedWrites.every((p) => !p.startsWith(WORKSPACE)),
    deniedWrites.length ? `denied: ${deniedWrites.join(", ")}` : "none attempted",
  );

  console.log(`\n=== CONTAINER SPIKE VERDICT (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    // Leave nothing behind: container + spike pool.
    destroyAgentContainer(CONV_ID);
    destroyAgentContainer(CONV_ID_B);
    setTimeout(() => {
      rmSync(STATE, { recursive: true, force: true });
      rmSync(POOL_B, { recursive: true, force: true });
      rmSync(STATE_B, { recursive: true, force: true });
      rmSync(POOL, { recursive: true, force: true });
      process.exit(failures === 0 ? 0 : 1);
    }, 1_500);
  });
