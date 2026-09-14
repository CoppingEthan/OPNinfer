import { EventEmitter } from "node:events";
import { request } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { devLog } from "@/lib/dev-log";
import { WireParser, encodeAttachHeader } from "./wire";

/**
 * The container seam: an Agent SDK `spawnClaudeCodeProcess` implementation
 * that runs the CLI inside the chat's sandboxd-managed agent container
 * instead of on the host.
 *
 * The SDK hands us {command, args, env, signal} and needs back something
 * shaped like a child process — {stdin, stdout, kill, on('exit'|'error')}.
 * We open ONE streaming HTTP request to the broker: the attach header + the
 * CLI's stdin flow up as the request body; enveloped stdout/stderr/exit flow
 * back as the response (see wire.ts for why stdout must arrive enveloped).
 * `command` (the host path of the SDK's bundled cli.js) is deliberately
 * dropped — the container runs its own pinned `claude`; only args and env
 * cross the wire.
 *
 * Raw node:http, not fetch: the whole point is writing the request body WHILE
 * reading the response body on one connection, which undici's fetch does not
 * guarantee and node's http client plainly does.
 */

/** Structural mirror of the SDK's SpawnOptions/SpawnedProcess (sdk.d.ts) —
 *  declared here so this module doesn't import SDK types at runtime. */
export interface AgentSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface AgentSpawnedProcess {
  stdin: Writable;
  stdout: PassThrough;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (...args: unknown[]) => void): void;
  off(event: "error", listener: (...args: unknown[]) => void): void;
}

function brokerBase(): { url: URL; token: string } {
  const base = process.env.SANDBOX_BROKER_URL;
  const token = process.env.SANDBOX_BROKER_TOKEN;
  if (!base || !token) {
    throw new Error("Sandbox broker is not configured (SANDBOX_BROKER_URL / SANDBOX_BROKER_TOKEN).");
  }
  return { url: new URL(base), token };
}

/** Fire-and-forget broker call (signal / teardown). */
function brokerSide(path: string, method: string, body?: unknown): void {
  try {
    const { url, token } = brokerBase();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: url.hostname,
        port: url.port || 80,
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => res.resume(),
    );
    req.on("error", () => {});
    req.end(payload);
  } catch {
    /* best-effort */
  }
}

/** Tear the chat's agent container down entirely (delete paths, recycling). */
export function destroyAgentContainer(conversationId: string): void {
  brokerSide(`/sandboxes/${conversationId}/agent`, "DELETE");
}

/**
 * Build the spawner for one conversation. Passed to the SDK as
 * `Options.spawnClaudeCodeProcess`; called once per query.
 */
export function makeAgentSpawner(
  conversationId: string,
): (options: AgentSpawnOptions) => AgentSpawnedProcess {
  return (options) => {
    const { url, token } = brokerBase();
    devLog("debug", "agent", `spawn (${conversationId})`, {
      args: options.args,
      envKeys: Object.keys(options.env),
      cwd: options.cwd,
    });
    const stdout = new PassThrough();
    // A REAL EventEmitter, not a hand-rolled {exit,error} listener table: the
    // SDK subscribes to more events than the SpawnedProcess interface names
    // (a ChildProcess emits 'spawn' among others), and the hand-rolled
    // version THREW on the first unknown event name — synchronously, inside
    // the SDK's setup, which it caught and turned into an instant silent
    // abort. Cost half a day: the CLI "exited 0 having been told nothing".
    const emitter = new EventEmitter();
    let exitCode: number | null = null;
    let killed = false;
    let settled = false;
    const stderrTail: string[] = [];
    // A ChildProcess emits 'spawn' once the process exists; the remote attach
    // is morally spawned once the request is on its way.
    setImmediate(() => emitter.emit("spawn"));

    const settle = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      exitCode = code;
      devLog("debug", "agent", `spawn settled (${conversationId})`, {
        code,
        error: err?.message,
        killed,
      });
      stdout.end();
      // Guard: EventEmitter throws on 'error' with no listeners.
      if (err && emitter.listenerCount("error") > 0) emitter.emit("error", err);
      emitter.emit("exit", code, null);
      if (stderrTail.length) {
        devLog("debug", "agent", `agent stderr tail (${conversationId})`, {
          stderr: stderrTail.join("").slice(-4_000),
        });
      }
    };

    const httpReq = request({
      host: url.hostname,
      port: url.port || 80,
      path: `/sandboxes/${conversationId}/agent/attach`,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-ndjson",
        "transfer-encoding": "chunked",
      },
    });

    httpReq.on("response", (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          settle(null, new Error(`agent attach failed (${res.statusCode}): ${body.slice(0, 300)}`)),
        );
        return;
      }
      const parser = new WireParser();
      res.on("data", (chunk: Buffer) => {
        for (const ev of parser.feed(chunk)) {
          if (ev.kind === "o") stdout.write(ev.data);
          else if (ev.kind === "e") {
            stderrTail.push(ev.data.toString("utf8"));
            if (stderrTail.length > 200) stderrTail.shift();
          } else settle(ev.code);
        }
      });
      res.on("end", () => settle(exitCode ?? -1));
      res.on("error", (e) => settle(null, e));
    });
    httpReq.on("error", (e) => settle(null, e as Error));

    // Header first; everything the SDK writes after is raw stdin.
    const envClean: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) if (typeof v === "string") envClean[k] = v;
    httpReq.write(encodeAttachHeader({ args: options.args, env: envClean }));

    const stdin = new Writable({
      write(chunk, _enc, cb) {
        devLog("debug", "agent", `stdin → (${conversationId})`, {
          preview: String(chunk).slice(0, 160),
          bytes: (chunk as Buffer).length,
        });
        httpReq.write(chunk, cb);
      },
      final(cb) {
        // SDK graceful shutdown: stdin EOF → the broker half-closes → the CLI
        // winds down. The response (and exit envelope) still flows back.
        devLog("debug", "agent", `stdin EOF (${conversationId})`, {});
        httpReq.end(cb);
      },
    });

    // The SDK's forwarded signal fires AFTER its stdin-EOF grace window — by
    // then a healthy CLI has exited; a stuck one gets torn down hard.
    options.signal.addEventListener(
      "abort",
      () => {
        if (!settled) {
          killed = true;
          destroyAgentContainer(conversationId);
          settle(exitCode ?? 143);
        }
      },
      { once: true },
    );

    // The emitter IS the process object — every EventEmitter method rides
    // along, so any event the SDK subscribes to is simply accepted.
    const proc = emitter as unknown as AgentSpawnedProcess & EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      killed: boolean;
      exitCode: number | null;
      kill(signal: NodeJS.Signals): boolean;
    };
    Object.defineProperties(proc, {
      stdin: { value: stdin, enumerable: true },
      stdout: { value: stdout, enumerable: true },
      killed: { get: () => killed, enumerable: true },
      exitCode: { get: () => exitCode, enumerable: true },
      kill: {
        value: (signal: NodeJS.Signals) => {
          killed = true;
          if (signal === "SIGKILL") destroyAgentContainer(conversationId);
          else
            brokerSide(`/sandboxes/${conversationId}/agent/signal`, "POST", {
              signal: String(signal).replace(/^SIG/, ""),
            });
          return true;
        },
        enumerable: true,
      },
    });
    return proc;
  };
}
