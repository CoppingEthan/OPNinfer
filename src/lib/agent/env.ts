/**
 * The agent subprocess environment — built EXPLICITLY, never spread from
 * `process.env`. Pure, and the most security-load-bearing few lines of the
 * Sandbox tier, so it has its own test file.
 *
 * Why this exists (see the design notes, §2.4/§3.2):
 *
 *  - The SDK's `Options.env` REPLACES the subprocess environment rather than
 *    merging, and the tempting fix is `{...process.env}` — but the Next
 *    server's environment holds the org's decrypted `ANTHROPIC_API_KEY`, and
 *    in Claude Code's auth precedence an API key outranks the subscription
 *    login. One careless spread would silently bill the API while the
 *    operator believed they were on their plan, or hand the org's key to a
 *    container that runs model-written code.
 *
 *  - The first spike run ALSO proved `PWD`/`INIT_CWD` leakage gives the model
 *    a second idea of where it is (it wrote to the repo root instead of its
 *    workspace), so path-context vars are stripped too.
 *
 * The two credential modes want opposite things and this is where they fork:
 * API mode points the CLI at OPNinfer's credential proxy (base URL + a
 * per-chat bearer minted by us — the real key never appears); subscription
 * mode sets NOTHING auth-shaped by default, because the credential lives in
 * the agent container's own config volume, written there by Anthropic's
 * /login flow.
 *
 * SUBSCRIPTION, THE OTHER WAY (2026-09-07, owner ask: "it's annoying we get
 * signed out all the time"). The volume login is a PAIR — an access token
 * that expires in about eight hours and a refresh token — and every chat
 * container shares one copy of it. At expiry whichever chat runs next
 * refreshes, Anthropic hands back a NEW refresh token and kills the old one,
 * and any container still holding the old one is signed out: a burst of
 * failed runs at every expiry, an alert email each time, then quiet again.
 * A long-lived token (`claude setup-token`, a subscription feature) has no
 * refresh at all, so there is nothing to race over. It arrives as an
 * environment variable, which is why it belongs here: it is the one piece of
 * auth subscription mode may set, and `agentOauthToken()` below is the only
 * place that reads it.
 */

/** Session/auth/telemetry vars that must never leak into the agent: every
 *  ANTHROPIC_* (keys, base URLs), every CLAUDE* (nested-session plumbing when
 *  the server itself runs under Claude Code, config-dir overrides), AI_AGENT. */
const STRIP_PREFIX = /^(ANTHROPIC|CLAUDE|AI_AGENT)/i;
/** Path-context vars that would tell the model about the HOST's cwd. */
const STRIP_EXACT = /^(PWD|OLDPWD|INIT_CWD)$/i;

export interface AgentEnvOpts {
  credential: "api" | "subscription";
  /** Environment to inherit SAFE vars from (PATH, HOME, TMP, locale …).
   *  Typically process.env on the host, or a minimal set for containers. */
  base?: Record<string, string | undefined>;
  /** CLAUDE_CONFIG_DIR — set per-chat in containers so transcripts and state
   *  never share a directory; omit on the host to use the operator's own
   *  ~/.claude (which is where their subscription login lives). */
  configDir?: string;
  /** Subscription mode: a long-lived token from `claude setup-token`, which
   *  REPLACES the refreshing login in the container's config volume. Omit to
   *  use that volume login (the original behaviour). Ignored in API mode,
   *  where the proxy is the only auth the CLI may have. */
  oauthToken?: string;
  /** API mode: OPNinfer's credential proxy. The CLI sends model traffic to
   *  `baseUrl` authenticated by `token` (per-chat, OPNinfer-minted); the proxy
   *  swaps in the real org key server-side. REQUIRED in API mode. */
  proxy?: { baseUrl: string; token: string };
}

export function buildAgentEnv(opts: AgentEnvOpts): Record<string, string | undefined> {
  if (opts.credential === "api" && !opts.proxy) {
    // Refusing outright is the guard: the fallback anyone would reach for is
    // putting the raw org key in the environment, which is the one thing this
    // module exists to make impossible.
    throw new Error(
      "API-key mode requires the credential proxy — the org key itself must never enter an agent environment.",
    );
  }

  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.base ?? {})) {
    if (STRIP_PREFIX.test(k) || STRIP_EXACT.test(k)) continue;
    env[k] = v;
  }

  // Hygiene, unconditional: no telemetry/update traffic from inside the
  // sandbox, no auto-memory (the chat pool is user data, not agent memory),
  // no version drift from the SDK-pinned CLI.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.DISABLE_AUTOUPDATER = "1";
  // Fine-grained tool streaming (owner report 2026-09-02: "the code appears
  // all in one go"). Without it the API buffers a tool call's input and the
  // CLI delivers every input_json_delta in one burst when the block ends —
  // measured: 14.9s of silence, then 612 deltas in 236ms. The CLI's model
  // table only turns eager streaming on by itself for Bedrock/Vertex; for
  // Anthropic direct it is gated on this variable, which the host-env strip
  // above would never let through — so it is set here, explicitly.
  env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = "1";

  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;

  if (opts.credential === "api") {
    env.ANTHROPIC_BASE_URL = opts.proxy!.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = opts.proxy!.token;
  } else if (opts.oauthToken) {
    // Subscription mode with a long-lived token: the CLI prefers this over
    // the credential file it can also see, and never refreshes anything.
    // (The volume stays mounted — connected services’ OAuth lives in the
    // same file, and it is still the fallback when no token is configured.)
    env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
  }
  // Subscription mode with no token sets nothing — the container volume
  // holds the login, and the CLI refreshes it in place.

  return env;
}

/**
 * A Claude long-lived token, as `claude setup-token` mints it. Checked
 * rather than trusted: a value that reached the container mangled must read
 * as "not configured properly", never as a token the CLI will reject at the
 * worst possible moment (the console's operator accounts taught this exact
 * lesson — "a value arriving is not the same as the app understanding it").
 */
export const OAUTH_TOKEN_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * An organisation API key is sk-ant-shaped too, and pasting one here would
 * put a raw key inside a container that runs model-written code — the one
 * thing this module exists to make impossible. An API key belongs in
 * Admin → API, where the proxy keeps it server-side.
 */
export const API_KEY_PREFIX = /^sk-ant-api/i;

export type AgentTokenSource = "none" | "token" | "malformed";

/**
 * Where the instance's subscription auth comes from.
 *
 * Stored BASE64 (`AGENT_OAUTH_TOKEN_B64`) for the reason the console's
 * operator accounts are: docker compose interpolates `$` inside an env_file,
 * so any secret whose alphabet we do not control has to arrive in a form
 * that has no `$` in it. The plain form is read too, for a token set by hand.
 */
export function agentTokenSource(): AgentTokenSource {
  const raw = readConfiguredToken();
  if (!raw) return "none";
  if (API_KEY_PREFIX.test(raw)) return "malformed";
  return OAUTH_TOKEN_SHAPE.test(raw) ? "token" : "malformed";
}

/** The token to hand the CLI, or undefined to fall back to the volume login. */
export function agentOauthToken(): string | undefined {
  return agentTokenSource() === "token" ? readConfiguredToken() : undefined;
}

function readConfiguredToken(): string | undefined {
  const b64 = process.env.AGENT_OAUTH_TOKEN_B64?.trim();
  if (b64) {
    // Buffer.from is lenient with invalid base64 (it skips what it cannot
    // decode) rather than throwing, so the shape check above is what
    // actually decides — decoding "not a token" must not look like success.
    const decoded = Buffer.from(b64, "base64").toString("utf8").trim();
    if (decoded) return decoded;
  }
  return process.env.AGENT_OAUTH_TOKEN?.trim() || undefined;
}
