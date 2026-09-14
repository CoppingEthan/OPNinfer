# OPNinfer v0.4 — The Sandbox agent tier: design record

*Built 2026-08-24 → 2026-09-01 on the `beta` branch, one commit per stage.
This is the survival document for the tier: what was decided with the owner,
why, and what the testing found. Read with `CLAUDE.md` (day-to-day facts and
gotchas). The research notes that started it are summarised in §1.*

## 0. What it is

The old sandbox ran one command at a time in a container. The Sandbox tier
replaces it with a **full autonomous agent per chat** — the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`, the technology behind Claude Code) — that
can work a whole task through many steps: read the chat's files, write code,
run it, fix it, present the result. It is exposed to the conversation model as
**one tool, `sandbox_task`**, so everything already built (the four model
roles, escalation, failover, forced-answer guards, usage tagging, the
interject mailbox, the turn registry) is untouched.

The UI name is **"Sandbox"**. Anthropic's branding rules forbid "Claude Code"
as a feature name; describing it to the *model* as Claude-Code-grade in the
tool description is plain-text territory and fine.

## 1. The four findings that shaped it (from the research)

1. **There is no open-source CLI to embed.** The supported way is the Agent
   SDK, licensed for products serving your own customers under the Commercial
   Terms.
2. **The harness already exists.** The SDK gives a typed event stream with
   token-level deltas, a permission callback, hooks, in-process tools,
   `interrupt()`, and streaming input. Wrapping a PTY would have been strictly
   worse.
3. **`spawnClaudeCodeProcess` is the seam.** The SDK harness runs inside the
   Next server — where the permission checks, audit log and `present_files`
   live — while the `claude` process runs in a sandboxd container. Container
   isolation *and* the full programmatic API, no sidecar protocol.
4. **Subscription auth is fine for your own instance, prohibited for one
   serving other people.** The line is *individual use vs. serving others*,
   not subscription vs. API. So it is an admin toggle on this one capability;
   the four model roles keep their API keys and never touch it.

## 2. Owner decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Name | **Sandbox** — it replaces the old sandbox fully | owner |
| Exposure | a client **capability** (off unless enabled), fully configurable on Admin → Tools | owner |
| Default model / effort | Sonnet 5, high; admin-editable | owner |
| Steering | "~80% of substantive work goes through it"; text is admin-editable so it can be tuned down if rate limits bite | owner |
| Escalate vs delegate | escalate = hard *reasoning* one excellent answer can settle; Sandbox = long work that needs doing, checking, redoing | owner |
| Tool exposure | **live from round 1**, not deferred behind `enable_tools` | a tool the model must reach for constantly cannot sit behind a directory |
| Long runs | the turn's hard stop **stretches to the agent's budget** while it runs, then snaps back | simplest; no new subsystem |
| Narration | the agent's commentary goes to the **activity panel as status lines**, never into the reply prose | the reply stays the conversation model's voice |
| Container lifetime | **per chat, idle TTL** (30 min) | warm filesystem, fast follow-ups, resume works |
| Workspace | the **whole chat pool** at `/workspace` | consistent with what users expect |
| Egress | whatever Claude Code has — general internet | owner |
| Isolation | every chat's agent state kept apart; **work, personal and private never intermingle** | owner |
| Credentials | both paths from the start: org API key (default, client instances) and the operator's subscription | owner |
| Old sandbox | **retired completely** | owner |
| Usage on a subscription | recorded at **$0.00**, its API-rate value kept as "saved", never dragging the average cost down, in the dashboard and the weekly report | owner |
| Plan limits | session and weekly windows shown as bars with reset times, like claude.ai | owner |

## 3. Architecture

```
┌── Next.js server (host) ──────────────────────────────────────────┐
│ chat route → pipeline → tool: sandbox_task (src/lib/tools/)        │
│   query({ ... })  ← @anthropic-ai/claude-agent-sdk                 │
│     ├─ canUseTool     policy.ts: workspace containment, ask routing │
│     ├─ mcpServers     present_files (host-side, after a pool sync)  │
│     ├─ prompt         streaming input, held OPEN (interrupt/steer)  │
│     └─ spawnClaudeCodeProcess ── agent/spawn.ts ─┐                  │
│   bridge.ts: SDK messages → the chat's run-block events             │
│   [api mode] /api/agent-proxy: key injection + real metering        │
└──────────────────────────────────────────────────┼─────────────────┘
                              duplex stdio over one HTTP request (wire.ts)
                                                   ▼
┌── sandboxd (the only Docker-socket holder) ───────────────────────┐
│ POST /sandboxes/:id/agent/attach   → docker exec (hijack, stdin)   │
│ per-chat container `oi-agent-<instance>-<conv>`, image opninfer-agent │
│   /workspace          ← the chat's pool (bind dev / volume subpath) │
│   ~/.claude           ← the chat's OWN state dir (transcripts)      │
│   ~/.claude-shared    ← the instance's login volume (symlinked in)  │
│   read-only rootfs, cap-drop ALL, 2g/2cpu/256pids, egress bridge    │
└───────────────────────────────────────────────────────────────────┘
```

**Files** — `src/lib/agent/`: `config.ts` (schema, bounds, defaults,
steering), `env.ts` (the credential-safety guard), `wire.ts` (attach
protocol), `spawn.ts` (the seam), `bridge.ts` (event translation, tested
against a recorded session), `policy.ts` (permissions + prompt),
`limits.ts` / `limits-store.ts` (plan usage), `proxy-tokens.ts` /
`proxy-usage.ts` (the API-key path). `src/lib/tools/sandbox-task.ts` is the
tool; `src/lib/capabilities/sandbox-agent.ts` the capability;
`src/app/api/agent-proxy/[...path]/route.ts` the proxy; `docker/agent/`
the image; `sandboxd/index.mjs` the broker.

## 4. The two credential paths — where they genuinely diverge

| | Subscription | Organisation API key |
|---|---|---|
| Where the credential lives | **inside the container**, in the instance's login volume, written by Anthropic's `/login` | **never in the container** |
| How it gets there | `./deploy.sh agent-login <instance>` (dev: `docker run -it --rm -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent claude`) | decrypted in the Next server, injected by the proxy per request |
| Model traffic | direct to Anthropic | `ANTHROPIC_BASE_URL` → the proxy, with a per-run bearer |
| Metering | the SDK's `modelUsage` report | **real** counts read off Anthropic's responses |
| Billing rows | `billing_source=subscription`, cost 0, `notional_cost` kept | `billing_source=api`, real cost |

`buildAgentEnv` constructs the subprocess environment explicitly — never
`...process.env` — strips every `ANTHROPIC*`/`CLAUDE*` var (an API key would
silently outrank the login), strips `PWD`/`INIT_CWD` (leaked host paths sent
the agent's file to the repo root), and **throws** in API mode without a
proxy. One unit test asserts no `ANTHROPIC_API_KEY` can ever reach a
container. The admin "Check sign-in" probe runs *inside a container*, never on
the host (it once reported the developer's own login while the container was
signed in as someone else).

## 5. Traps found live, in order (each is pinned by a test or a comment)

- A bare tool name in `allowedTools` **auto-approves that tool for any path**
  before `canUseTool` runs. Path scoping must come from `acceptEdits` plus the
  callback; never the allowlist. With a blanket allow the agent wrote its
  deliverable to `/tmp` — task done, nothing in the pool, no error.
- The SDK silently rejects a generator **function** as a prompt (it needs the
  invoked generator) and shuts the query down as "aborted by user" — an hour
  spent blaming the container seam for a missing pair of parentheses.
- `interrupt()` travels **over stdin**: a one-shot prompt makes the SDK send
  EOF 1 ms later and a Stop can never be delivered. The input stream is held
  open for the whole run (it also carries mid-run steering).
- `cwd` is the path **inside the container**; given the host path the agent
  couldn't find it and wrote to `/tmp`.
- A returned-but-not-awaited handler promise escaped the broker route's
  try/catch and **took the whole broker down**, restarting every sandbox on
  the host, because one agent container had stopped.
- A `--mount` tmpfs home defaults to root-owned 0750, which uid 1000 cannot
  traverse. Mode 1777, and the image pre-creates `~/.claude` owned by
  `sandbox` (a fresh named volume initialises from the image's directory).
- A hand-rolled `{exit,error}` listener table threw on the first event name
  the SDK subscribed to that wasn't anticipated. It is a real `EventEmitter`.
- The CLI keys transcripts by working directory and every container uses
  `/workspace`, so **one shared config dir filed every chat's history under one
  key**. Per-chat state dirs; only the login is shared, by **symlink** (a copy
  would strand a refreshed OAuth token in a container about to be reaped).
- A cross-contamination check shelled out to `cmd.exe` for `ls -R` on Windows
  and **passed vacuously**. Real filesystem walks, and the check fails if a
  tree is empty.
- A Stop before any prose left an **empty assistant row**, which replay drops
  — the next message saw the request with no reply and **restarted the
  stopped 120-second job**. Such rows are flagged and replayed as a note.
- A single-command job went to the old tier's `execute_command`, whose exec
  was not abort-aware — the reason the old tier had to go, not just be hidden.
- Relaying a mid-run user message inside the tool result ("the user also
  said…") made the conversation model treat it as **prompt injection** and
  refuse. The tool now *peeks* the mailbox so the pipeline still appends the
  message as a genuine user turn.
- At zero usage a plan reports **no percentage** — just the window and its
  reset time. The panel says "nothing used yet", not a dash.
- The SDK's session store, with a custom spawner, needs the container's
  `CLAUDE_CONFIG_DIR` to *textually* match the parent's or it drops transcript
  frames — unverifiable on a Windows dev host and, since the per-chat state
  dir already persists, **not built**. Resume across a container recycle is
  pinned by the harness instead.
- **Every run longer than five minutes was cut off, and nothing said so**
  (2026-09-10, nine days into production). A run is ONE HTTP request to the
  broker held open for its whole life — the CLI's stdin rides the request
  body — and Node's http server has closed any request still incomplete
  after five minutes by default since v18 (`requestTimeout`, checked every
  30 s). The running command got SIGKILL (exit 137 in the CLI's own
  transcript), the container was torn down, the conversation model was told
  the run "did not complete" and usually started another, which died the
  same way five minutes later. Found in the owner's own chat (two containers
  at 5m10s and 5m22s, the agent stuck on a browser download that hangs) and
  matched in three other people's cut-off runs that week. Fix:
  `server.requestTimeout = 0` in `sandboxd/index.mjs` (the admin's
  `maxMinutes` is the one budget; `broker-server.test.ts` pins it from the
  source), the agent's prompt now says Chromium is already installed so it
  never tries to download one, and a run that does not complete writes a
  WARN row (`Sandbox run did not complete`) — `devLog` is dev-only, so
  production had no trace at all. `scripts/test-sandbox-long-run.ts` runs a
  six-minute command through the real broker and was verified to FAIL on
  the old one.

## 6. What the harnesses prove (`scripts/`)

- `spike-agent-sdk.ts` — the SDK on the host: deltas, callback, MCP, auth.
- `spike-agent-container.ts` — the same through the broker: 17 checks incl.
  mount, warm reuse, interrupt in ~6 s, isolation between two chats, the
  sign-in linked not copied, out-of-workspace writes refused.
- `test-agent-capability.ts` — the admin card, 20 browser checks incl. a real
  sign-in probe *inside a container*.
- `test-sandbox-task.ts` — the user story, 20 checks: delegation, live run
  blocks, presented file on disk with a row, `$0.00 + notional` usage rows,
  resume **across a container recycle**, Stop in under a second, no restart
  of a stopped job, reload persistence.
- `test-agent-proxy.ts` — the API-key path, 15 checks incl. no key in the
  container env and real metering.
- Re-pointed to the agent and passing: present-files, output-limit,
  tool-rounds, interject, activity-interleave, stream-resume, edit-revert,
  admin-chats, what's-new, deploy-drain, usage-summary, weekly-report.

## 6b. After the cut: design graphics, the fat image, the sign-in sync (2026-09-02)

The owner's first real test ("build me 4 Facebook advert PNGs") went to AI
image generation: quick, but not editable and wrong for real social posts.
Three changes, all live-proven:

- **`skills/design-graphics`** — the assistant asks ONCE per chat (built vs
  quick concept, build recommended) and hands the build to the Sandbox with
  "use your design-graphics skill"; the agent writes HTML/CSS at an exact
  size and renders with `html2png` (Playwright/Chromium, baked into the
  image). The agent sees the skill because `skills-sync.ts` mirrors
  `skills/` into its config dir and the SDK is given
  `settingSources: ["user"]`. Harness: `test-design-graphics.ts` (16).
- **The image bakes the common libraries** (Python data/document/imaging/web
  stack, Node tooling, fonts, Chromium, OCR) and **tracks what it lacks**:
  every install/download the agent attempts is tallied
  (`agent/packages.ts` → `agent_package_uses`) and Admin → Tools shows the
  top ones against the image's own manifest (`/etc/opninfer/packages.json`,
  generated at build, served by sandboxd `GET /packages`).
- **The sign-in is synced back after every run** (`sandboxd/cred-sync.sh`):
  the CLI's token refresh replaced the credentials symlink with a regular
  file in one chat's state dir, the shared copy kept a refresh token
  Anthropic had rotated, and every later chat failed over. Test:
  `test-cred-sync.sh`.

## 6c. Connected services — MCP, per instance (2026-09-03)

Owner ask: one client instance gets the Figma MCP, the others don't,
and the sign-in is done *inside Claude Code*, the way the Claude login is —
a setup command, a login, `/exit` — not a token pasted into a form.

**Design.** The source of truth is Claude Code's own config inside the
instance's credential volume (`opninfer-agent-config-<instance>`):
`./deploy.sh agent-mcp <instance> add <name> <url>` runs `claude mcp add
--transport http -s user` there, `… login <name>` runs `claude mcp login
--no-browser` (a TTY, a printed URL, the redirect URL pasted back). The
server list lands in the volume's `.claude.json`; the OAuth token in
`.credentials.json`, the same file as the Claude sign-in — so the symlink
and `cred-sync.sh` already carry it into every chat and back. OPNinfer
stores nothing and never sees a token. sandboxd's `GET /agent-mcp` reads
the two files out of a throwaway container (volume mounted read-only,
tokens reduced to booleans); the app caches that (stale-while-revalidate,
so a turn never waits) and passes the READY servers through the SDK's
`mcpServers` next to `opninfer`, strict mode still on. The tool description
and the agent's system prompt name the ready services; their tool calls
read "Using Figma: …" in the activity panel.

**The trap.** Claude Code keys a stored token by
`<name>|sha256(JSON.stringify({type, url, headers: headers || {}}))[:16]`;
the server the SDK passes must match those fields exactly or the sign-in
silently reads as absent. `mcp.test.ts` pins the function against a key
observed live (`figma|d39d3b6252bc1ac5`).

**Proof.** `scripts/test-agent-mcp.ts` (17): the real `claude mcp add`
into the real dev volume → broker → app → Admin → Sandbox → "Check
connections" boots the CLI with `--mcp-config` carrying the server and the
CLI reports `needs-auth` → the real `remove`. Figma's server accepted the
headless flow from a container (discovery + dynamic client registration
completed before any browser step). The signed-in half is the owner's
first live login in production — done 2026-09-04: `connected`, 42 Figma tools.

**Two locks (2026-09-04).** A subscription login carries the operator's
claude.ai connectors (Gmail, Calendar showed in `claude mcp list` on
that instance). Strict mode keeps them out of a run (probed live: `mcp_servers:
[figma]`, no `mcp__` tools) and, in case a CLI update ever changes that,
`decideToolUse` refuses any MCP tool whose server is not in the run's
allow-set. And a broken link is noticed by the portal, not by a user: after
every run, and from Check connections, `mcpServerStatus()` is judged and a
signed-in service the CLI could not use becomes an ERROR-level log row —
the alert email — with the fix command in its details, plus a status line
in the chat. Both proven by `test-agent-mcp.ts` (25).

## 7. Known follow-ups (not built)

- Login expiry is detected when a run hits it, not ahead of time. Since
  2026-09-02 a run that finds the sign-in gone (or the plan spent) logs an
  ERROR — which the alert email watches — and fails over to the card's
  Fallback key if one is set (`classifySubscriptionFailure` in `policy.ts`;
  proven by `scripts/test-agent-failover.ts`, which removes the sign-in from
  the volume for real and restores it). The card's "Check sign-in" remains
  the manual check.
- Claude Code tool allow/deny is code (`policy.ts`), not an admin toggle.
- A Pro plan's allowance is shared with the operator's own Claude Code use;
  the panel and the weekly report show the pressure, and the runtime toggle
  to an API key is the relief valve.
- Connected services (MCP) are set up by the operator on the server, never
  from the admin page (by design — the sign-in must be Claude Code's own).
  A per-server on/off switch on Admin → Sandbox is the obvious next step if
  a client ever needs one of several services paused.
