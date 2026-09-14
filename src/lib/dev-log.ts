import "server-only";
import { appendFile, stat, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Verbose file-based DEV log — a firehose of everything the server does
 * (requests in/out, every LLM call, every tool call + result, all errors) to
 * one greppable file so failures are diagnosable after the fact (the recurring
 * pain: "X is broken" with nothing to look at). Separate from `appLog` (which
 * is the curated, DB-backed Admin → Logs feed); `appLog` tees INTO here so the
 * dev log is a strict superset.
 *
 * DEV ONLY. Enabled when `DEV_LOG` is unset+non-production, or `DEV_LOG=1`;
 * disabled entirely with `DEV_LOG=0` (and always off in production unless
 * explicitly forced). Never throws into the request path. Redacts secrets and
 * hard-truncates huge blobs (base64 images) so the file stays readable.
 */

export type DevLogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "dev.log");
const ROTATE_BYTES = 20 * 1024 * 1024; // roll the file past ~20 MB
const MAX_STRING = 800; // truncate individual strings past this
const MAX_DETAILS = 12_000; // cap one line's serialized details

function enabled(): boolean {
  const flag = process.env.DEV_LOG;
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  return process.env.NODE_ENV !== "production";
}

const REDACT = /(secret|password|passwd|token|api[-_]?key|authorization|cookie|master[-_]?key)/i;
/** Keys whose values are huge base64/binary blobs — keep only a size hint. */
const BLOB_KEYS = /(dataBase64|data_base64|inlineData|base64|imageData)/i;

/** Recursively sanitize details: redact secrets, shrink blobs, truncate
 *  strings. Exported for unit testing (redaction is security-relevant). */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (depth > 6) return "[…deep]";
  if (Array.isArray(value)) {
    const arr = value.slice(0, 40).map((v) => sanitize(v, depth + 1));
    if (value.length > 40) arr.push(`…(+${value.length - 40} more)`);
    return arr;
  }
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, MAX_STRING) };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT.test(k)) out[k] = "[redacted]";
      else if (BLOB_KEYS.test(k) && typeof v === "string") out[k] = `[blob ${v.length} chars]`;
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function serializeDetails(details: unknown): string {
  if (details === undefined) return "";
  let s: string;
  try {
    s = JSON.stringify(sanitize(details));
  } catch {
    s = String(details);
  }
  if (s.length > MAX_DETAILS) s = `${s.slice(0, MAX_DETAILS)}…(truncated)`;
  return " " + s;
}

let rotateChecked = false;
async function rotateIfBig(): Promise<void> {
  if (rotateChecked) return;
  rotateChecked = true; // only check once per process (at first write)
  try {
    const s = await stat(LOG_FILE);
    if (s.size > ROTATE_BYTES) await rename(LOG_FILE, join(LOG_DIR, "dev.log.1")).catch(() => {});
  } catch {
    /* no file yet */
  }
}

const PAD: Record<DevLogLevel, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

// Serial write queue: the line is BUILT synchronously (so timestamp + order
// match the call order and `details` can't mutate underneath us), and the
// actual appends are chained FIFO so concurrent requests never interleave or
// reorder lines in the file.
let writeChain: Promise<void> = Promise.resolve();

/** Append one structured line. Non-blocking (queued); never throws. */
export function devLog(
  level: DevLogLevel,
  category: string,
  message: string,
  details?: unknown,
): void {
  if (!enabled()) return;
  const line = `${new Date().toISOString()} ${PAD[level]} [${category}] ${message}${serializeDetails(details)}\n`;
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await rotateIfBig();
      await appendFile(LOG_FILE, line, "utf8");
    } catch {
      /* logging must never break anything */
    }
  });
}

/** A crisp start-of-session marker so the latest run is easy to find. */
export function devLogBoot(info: Record<string, unknown> = {}): void {
  devLog("info", "boot", "──────── server start ────────", { pid: process.pid, ...info });
}

export function devLogEnabled(): boolean {
  return enabled();
}
