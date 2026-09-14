# OPNinfer architecture & decisions

Design rationale behind OPNinfer as of **v0.4.0** (2026-09-01). The v0.4 agent tier is recorded in [`V04_AGENT_TIER.md`](V04_AGENT_TIER.md). For day-to-day
commands, conventions, and gotchas see [`CLAUDE.md`](../CLAUDE.md); for the
narrative history see [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md); for the
agentic-tools design record see [`V03_AGENTIC_TOOLS.md`](V03_AGENTIC_TOOLS.md).

## Goals

A private, self-hosted, **centrally-administered** chat portal: one admin holds
the org's provider API keys and configures a single branded assistant; regular
users get the chat interface only — no settings, no model picker, no keys.
Every request is cost-tracked per user and per pipeline role. The assistant
reads files, searches the web, runs code in isolated sandboxes, and generates
images — all server-mediated, all metered.

Product philosophy: single-instance by design (scale up, not out);
server-authoritative everything (the browser can never choose a model or
reasoning level); token efficiency ("give the model the map, not the dump");
graceful degradation (a missing engine or failed step lands on an honest
fallback, never an exception).

## How it got here

- **v0.1** — per-user BYO API keys, a model whitelist, plain text chat.
- **v0.1.1 (the pivot)** — central-admin branded assistant; per-user pickers,
  whitelist, and BYO keys removed; the **four-role pipeline** added
  (frontend / conversation / escalation / failover) with tool-calling;
  Anthropic subscription OAuth built and then **removed the same day** for
  terms-of-service reasons (Console API keys are individual-org supported;
  routing third-party users through Pro/Max OAuth tokens is not) — never
  re-add it.
- **v0.1.2–0.1.3** — workspace/streaming UX layer; full-instance backup &
  restore; concurrency hardening.
- **v0.2.0** — the file layer: per-chat storage pools, the multi-container
  ingestion pipeline, file tools + the tool loop, native vision, STT.
- **v0.3.0** — the agentic layer: tool registry + groups, web tools, memory,
  images, skills, visualizations, the sandbox, capabilities, progressive
  disclosure + curation, reply TTS, resumable streams, file presentation.
- **v0.3.1** — production hardening, cut after the first real deployment: the
  ingestion worker's database connection (it had never once connected in
  production), output truncation at a provider default, admin-configurable
  token limits, per-model pricing gaps, deploy-time health checks, error
  alert emails, the Open WebUI importer, and the Admin → Chats support
  viewer.

## Key decisions

### Provider abstraction

A single `Provider` interface (`src/lib/providers/types.ts`); each provider is
one file (`openai.ts`, `anthropic.ts`, `google.ts`), wired by `registry.ts` —
adding a provider is one new file + a registry entry. `streamChat` yields a
normalized `ChatChunk` stream (`text | thinking | tool_call | usage |
error(retryable?)`). Tool calls, tool results, and images are mapped per
provider (OpenAI `tool_calls`/`image_url`, Anthropic `tool_use`/`tool_result`
blocks, Google `functionCall`/`functionResponse`/`inlineData`). Model
discovery is cache → live list → hardcoded fallback so a provider outage never
blocks configuration.

### Normalized token usage (the central correctness problem)

Each provider reports cache tokens on a different convention:

- **OpenAI** `prompt_tokens` *includes* cached tokens → subtract
  `prompt_tokens_details.cached_tokens`.
- **Anthropic** `input_tokens` *excludes* cached; separate
  `cache_read_input_tokens` and a unique `cache_creation_input_tokens` (write tier).
- **Google** `promptTokenCount` *includes* `cachedContentTokenCount` → subtract;
  `thoughtsTokenCount` counts as output.

Everything is normalized into `TokenUsage` where `inputTokens` is always the
uncached, full-price input, so `pricing.ts` computes cost with one formula. There
is **no token-pricing API** from any provider — rates are maintained from the
official pricing pages.

### The four-role pipeline

The assistant is not one model but four admin-bound roles (`assistant_config`
setting): a cheap **frontend** model (titles, follow-ups, background analyses),
the **conversation** workhorse, an **escalation** heavyweight reached through
an internal `escalate` tool (an explicit user ask is always honored; escalation
is a one-off per turn and auto-reverts), and a **failover** model. Failover
fires **only on retryable errors** (5xx/429/network — `providers/errors.ts`);
a 4xx is a config bug and is surfaced honestly, never masked. Every role that
ran gets its own `usage_records` row.

### Anthropic: Console API key only

Subscription OAuth was fully built (PKCE flow, token refresh) and then removed
after confirming Anthropic prohibits routing third-party users through Pro/Max
OAuth credentials. `anthropic-api` is the only Anthropic provider id. This is a
terms-of-service line, not a technical gap — do not re-add it.

### Reasoning: provider-native, admin-picked, server-applied

Admin-configured per role from **provider-aware dropdowns**
(`providers/reasoning.ts`) — never free text, never client-trusted. OpenAI →
`reasoning_effort`; Anthropic → adaptive thinking + `output_config.effort`
(`budget_tokens` is deprecated; `max_tokens` is raised while thinking);
Google → `thinking_level` on Gemini 3.x (`thinkingBudget` for
off/dynamic/numeric). The conversation role can carry a quick and an extended
level; the composer's "Think" toggle sends only a boolean and the server picks
the level, so users are capped to exactly the two admin-chosen levels.

### Files: pools + the table-as-queue

Every conversation owns a storage pool on disk; the `files` table doubles as
the ingestion queue (`FOR UPDATE SKIP LOCKED` claims, staleness reclaim,
attempt caps — **no Redis**). A thin Python router container detects by magic
bytes and dispatches to embedded MarkItDown, Gotenberg, Docling (OCR,
escalated only when a large PDF yields thin text), Whisper, or honest
metadata-only fallbacks; heavy engines run always-on and shared in
production, opt-in via the compose `heavy` profile in dev. Prepared content is inlined into a budgeted manifest ("the map, not
the dump"); images ride the model natively as vision parts, downscaled first.
The app and the worker never talk directly — they share the database and the
storage volume.

### The sandbox: a broker, not a socket in the app

Code execution goes through `sandboxd` — a tiny separate container that is the
**only** holder of the Docker socket, exposed to the app as a narrow
bearer-token HTTP API. It enforces: image allowlist, exactly one chat pool
mounted at `/workspace`, tmpfs over the artifacts dir, read-only rootfs,
2 GB / 2 CPU / 128-pid caps, cap-drop ALL, kill-on-timeout, warm per-chat
containers with an idle reaper, and an **egress-only network** — internet yes,
the internal compose network (db/app/broker/engines) unreachable. After every
mutating tool, `pool-sync` diffs the pool against the `files` table so new and
changed files flow through ingestion like uploads. Files the assistant creates
are its private workspace until it explicitly **presents** them.

### Token efficiency at the tool layer

Cheap tool groups are offered from round 1; heavy groups (web, image, sandbox,
capabilities) sit behind a "more tools" directory the model activates itself
(**progressive disclosure** — this replaced an earlier frontend-role tool
router that starved the model on ambiguous follow-ups). Long chats are
**curated** on the neutral message array before provider mapping (triggered
by the admin's `maxInputTokens` limit, 128k by default; recent turns kept
whole, summaries for the rest).

### Two-tier data model

Permanent data (users, credentials, usage, settings, audit, app log, feedback
snapshots, user memories) survives chat deletion; ephemeral data
(conversations, messages, files) cascade-deletes with the conversation —
including the pool on disk. `usage_records.user_id` is `ON DELETE SET NULL` so
billing history survives (anonymized) when an account is removed.

### Auth: invite-only

First-run bootstrap creates the first admin; thereafter access is invite-only.
Admins can approve users without email. Dev (no SMTP) auto-verifies and logs
invite/reset links to the console. Auth.js v5 with a split config so the edge
middleware stays Node-free; `/admin` is role-gated.

### Security model

Org provider keys are encrypted at rest with AES-256-GCM
(`OPNINFER_MASTER_KEY`). Single-use invite/reset tokens are stored as SHA-256
hashes. Path-traversal guards on every storage resolve; uploaded names are
sanitized so the artifacts dir can't be shadowed. Downloads and avatars are
auth-gated; branding assets are public (the login page needs the logo) and
SVGs render only via `<img>` under a locked-down CSP. `download_file` is
SSRF-guarded (scheme, hostname, and DNS-resolved private-IP blocking on every
redirect hop).

### Resumable streams

Generation runs **detached** from the HTTP request: the turn publishes SSE
events into an in-process per-conversation buffer and responses merely
subscribe. Leaving/refreshing detaches; returning re-attaches with a replay.
Stop is a server-side abort, deletes abort live turns, and a hard-stop backstop
prevents a hung provider from pinning a conversation.

### Deployment: many isolated portals, one host, shared engines

A host runs **N portal instances from one checkout**, each a separate compose
project (`opninfer-<name>`: Postgres + one-shot `prisma migrate deploy` + the
Next.js standalone server + the ingestion worker + sandboxd) with its own
git-ignored env file, secrets, and volumes — complete data isolation between
clients. The document/speech engines (Gotenberg, Docling OCR, Whisper STT,
Kokoro TTS) are **stateless converters that store no client data**, so one
shared always-on stack (`docker-compose.engines.yml`) serves every instance
over a shared Docker network that only each instance's app + worker join.

TLS is terminated by an external reverse proxy — each instance publishes plain
HTTP on its own port; the proxy must forward Host/X-Forwarded-Proto, disable
response buffering (SSE), and allow bodies up to the upload limit. `deploy.sh`
is both first-run setup (including installing Docker itself) and the
update-everything command; images are built once and shared by all instances.
Each portal stays single-process by design (in-memory model cache, in-process
stream registry, local storage volume): scale up, and add portals side-by-side
rather than clustering one. The standalone build is gated on
`BUILD_STANDALONE=1` because the output uses symlinks that fail on Windows.

## Verification approach

Beyond `pnpm typecheck` / `pnpm test` (212 unit tests) / `pnpm build`, every
subsystem has a **live manual harness** in `scripts/` (57 of them, not part of
the test suite) that exercises the real providers, database, dev server, and —
for UX-critical paths — a real headless browser via Playwright. The convention:
every owner-reported bug gets a harness recreating the exact failing shape
before it's called fixed. The CI E2E suite (`e2e/`) covers the
setup → login → chat → admin → auth-gate journey without provider keys. A
hand-driven full verification plan lives in `E2E_TEST_PLAN.md`.
