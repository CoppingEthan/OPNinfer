/**
 * The agent attach wire protocol — pure encode/decode, unit-tested.
 *
 * The Agent SDK talks to its CLI subprocess over plain stdio. When the CLI
 * runs inside a sandboxd-managed container, that stdio has to cross one HTTP
 * connection to the broker:
 *
 *   app → broker:  first line = a JSON header {args, env}; every byte after
 *                  it is the CLI's stdin, raw.
 *   broker → app:  NDJSON envelopes — {"o": base64} stdout, {"e": base64}
 *                  stderr, {"exit": code} once, last.
 *
 * Down-stream needs envelopes because a docker exec multiplexes stdout and
 * stderr onto one stream, and the SDK must receive a CLEAN stdout (it parses
 * it as NDJSON control traffic) — stderr bytes interleaved raw would corrupt
 * it. Up-stream needs none: stdin is the only stream going that way, so it
 * flows raw after the header line. Base64 costs a third in size on a stream
 * that is small JSON control messages; simplicity wins.
 */

/** First line of the request body: what to run and with what environment.
 *  The broker runs the container's own `claude` binary — the host-side
 *  command path in SpawnOptions is meaningless inside the container, so only
 *  args and env cross the wire. */
export interface AttachHeader {
  args: string[];
  env: Record<string, string>;
}

export function encodeAttachHeader(header: AttachHeader): string {
  return JSON.stringify(header) + "\n";
}

/** Broker side: parse the header line defensively (bad input = null, and the
 *  caller 400s — never throws into the socket handler). */
export function parseAttachHeader(line: string): AttachHeader | null {
  try {
    const parsed = JSON.parse(line) as { args?: unknown; env?: unknown };
    if (!Array.isArray(parsed.args) || !parsed.args.every((a) => typeof a === "string")) {
      return null;
    }
    const env: Record<string, string> = {};
    if (parsed.env && typeof parsed.env === "object") {
      for (const [k, v] of Object.entries(parsed.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    return { args: parsed.args, env };
  } catch {
    return null;
  }
}

export type WireEvent =
  | { kind: "o"; data: Buffer }
  | { kind: "e"; data: Buffer }
  | { kind: "exit"; code: number };

/** Broker side: one envelope line for a chunk of stdout/stderr. */
export function encodeChunk(kind: "o" | "e", data: Buffer | string): string {
  const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return JSON.stringify({ [kind]: b.toString("base64") }) + "\n";
}

export function encodeExit(code: number): string {
  return JSON.stringify({ exit: code }) + "\n";
}

/**
 * App side: incremental NDJSON envelope parser. Fed arbitrary chunk
 * boundaries (an envelope may arrive split anywhere, including mid-base64);
 * emits complete events in order. Unknown/garbled lines are dropped rather
 * than thrown — a corrupt envelope must not kill the run, and the exit
 * envelope (or the connection ending) still settles things.
 */
export class WireParser {
  private buf = "";

  feed(chunk: Buffer | string): WireEvent[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const events: WireEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { o?: string; e?: string; exit?: number };
        if (typeof obj.o === "string") {
          events.push({ kind: "o", data: Buffer.from(obj.o, "base64") });
        } else if (typeof obj.e === "string") {
          events.push({ kind: "e", data: Buffer.from(obj.e, "base64") });
        } else if (typeof obj.exit === "number") {
          events.push({ kind: "exit", code: obj.exit });
        }
      } catch {
        /* dropped, see above */
      }
    }
    return events;
  }
}
