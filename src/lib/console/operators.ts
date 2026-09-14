/**
 * Who may sign in to the operator console.
 *
 * The console has NO DATABASE of its own (owner decision, 2026-09-07): it is a
 * read-only window onto every portal, used by one or two people, so a whole
 * Postgres container — plus invites, verification and password resets — would
 * be machinery for nothing on a box that is already tight on RAM. Accounts
 * live in the console's generated env file instead, as
 *
 *     CONSOLE_OPERATORS_B64="<base64 of "you@example.com:$argon2id$v=19$...">"
 *
 * one `email:hash` pair per entry, separated by `;` or a newline. The hash is
 * the SAME argon2id encoding the portals store (`hashPassword`), written by
 * `./deploy.sh console-password` — a plaintext password never appears in the
 * file, and this app never sees one except at the moment of verification.
 *
 * BASE64, because DOCKER COMPOSE INTERPOLATES `$` IN AN env_file. An argon2
 * encoding is `$argon2id$v=19$m=19456,t=2,p=1$salt$hash`, and compose
 * substituted `$argon2id`, `$v`, `$m` and `$p` as undefined variables — 147
 * bytes in the file arrived as 88 in the container, with the algorithm name
 * gone. It read as "no operator accounts are configured", which is exactly
 * what a missing account looks like (found live, 2026-09-07). Escaping as
 * `$$` would break the other way the day compose changes its mind; base64
 * has no `$` to eat and cannot be misread by either behaviour.
 *
 * `CONSOLE_OPERATORS` is still accepted, plain, for a hand-set account and
 * for tests that pass the environment directly with no compose in the way.
 *
 * Splitting on the FIRST colon is safe by construction: an argon2 encoded hash
 * is `$argon2id$v=…$m=…,t=…,p=…$<b64 salt>$<b64 hash>`, and standard base64
 * contains no `:`, `;` or newline.
 *
 * This module is PURE (env in, records out) so the parsing rules can be tested
 * without a container; verification lives in `verifyOperator` next door, which
 * is the only part that needs argon2.
 */

export interface Operator {
  /** Lower-cased, trimmed — the form used to match a sign-in attempt. */
  email: string;
  /** argon2id encoded hash. */
  hash: string;
}

/**
 * Parse the configured operators. Malformed entries are DROPPED rather than
 * throwing: a stray line in an env file must not take the whole console down
 * and lock the operator out of their own overview — `parseOperators` returning
 * an empty list is surfaced on the sign-in screen as "no operators
 * configured", which says what to do about it.
 */
export function parseOperators(raw: string | undefined | null): Operator[] {
  if (!raw) return [];
  const out: Operator[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[;\n]/)) {
    const line = entry.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const email = line.slice(0, at).trim().toLowerCase();
    const hash = line.slice(at + 1).trim();
    // An argon2 hash is the only thing we accept — a plaintext password left
    // in the file by hand must never silently become a working credential.
    if (!email.includes("@") || !hash.startsWith("$argon2")) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, hash });
  }
  return out;
}

/**
 * Decode the base64 form, tolerantly.
 *
 * Anything unusable is treated as "not configured" rather than throwing: the
 * sign-in screen then tells the operator to run the command again, which is
 * the only useful thing to say.
 */
function decodeB64(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw.trim(), "base64").toString("utf8");
    return text.includes(":") ? text : null;
  } catch {
    return null;
  }
}

/** The operators configured for this container. */
export function configuredOperators(): Operator[] {
  const decoded = decodeB64(process.env.CONSOLE_OPERATORS_B64);
  // The plain form is the fallback, not the default — see the note above.
  return parseOperators(decoded ?? process.env.CONSOLE_OPERATORS);
}

/**
 * The stable user id for an operator.
 *
 * Sessions are JWTs and there is no user table, so the id only has to be
 * stable and recognisable — it shows up in nothing but the session itself.
 */
export function operatorId(email: string): string {
  return `operator:${email.toLowerCase().trim()}`;
}
