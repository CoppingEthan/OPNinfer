import { z } from "zod";

/** Default cap for a JSON API body: the largest legitimate one (a chat turn
 *  of 100k chars plus file ids) is well under this. */
export const JSON_BODY_MAX_BYTES = 512_000;

/**
 * Read and parse a JSON body without buffering an unbounded one first (audit
 * 2026-09-05). `req.json()` reads the WHOLE body before any zod limit can
 * apply, and the middleware body clone allows 256 MB, so each authenticated
 * request could hold that much memory. Throws on an oversize body (declared
 * or streamed) and on invalid JSON — callers already treat a throw as 400.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonBounded(req: Request, maxBytes: number = JSON_BODY_MAX_BYTES): Promise<any> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("Request body too large.");
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Request body too large.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  return text.trim() ? JSON.parse(text) : null;
}

/** Shared input validation (Auth.js authorize has its own minimal schema). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(200, "Password is too long.");

export const setPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });
