# OPNinfer — Complete Project Brief

*Written 2026-07-01, at working-tree state “v0.2.0 (uncommitted)”. This is a
self-contained briefing for an AI or engineer joining the project cold. It
covers what the product is, how it evolved commit by commit, how every
subsystem works, and where it is going next. The living reference that MUST be
kept accurate as code changes is `CLAUDE.md`; this document is the narrative
snapshot.*

> **Historical snapshot — superseded (2026-07-20).** Since this was written:
> v0.2.0 was committed as `04da1f9`, and the "next phase" described in §15 was
> built and **released as v0.3.0** (commit `83b4acb`, 2026-07-20) — the full
> agentic-tools layer (web/memory/images/skills/viz/**sandbox**/capabilities,
> progressive tool disclosure, context curation, reply TTS, file presentation,
> resumable streams, and more). Details that changed since (e.g. the tool loop
> is now 6 rounds, the admin area is 10 pages) are in `CLAUDE.md` and
> `docs/V03_AGENTIC_TOOLS.md`. Read this file for the narrative and the
> pre-0.3 subsystem rationale, not for current state.

---

## 1. What OPNinfer is

OPNinfer is a **private, self-hosted, centrally-administered AI chat portal**
for organisations. One **admin** holds the provider API keys (OpenAI,
Anthropic Console, Google Gemini — encrypted at rest) and configures a single
branded **“[Company] AI Assistant”**. Regular **users** get a polished chat
interface only — no settings, no model picker, no API keys. Access is
**invite-only** (no public signup). Every request’s token usage and cost is
tracked per user and per pipeline role.

The assistant is not one model but **four admin-assigned model roles** working
as a pipeline: a cheap *frontend* model (titles, follow-up suggestions), the
*conversation* workhorse, a heavyweight *escalation* model the workhorse can
hand off to via an internal tool, and a *failover* model for transient
provider outages.

As of 0.2.0, users can upload **any file** into a chat; a multi-container
ingestion pipeline prepares token-efficient content the assistant reads on
demand through tools, images go to vision-capable models natively, and the mic
does live speech-to-text dictation via Whisper.

**Product philosophy:** single-instance by design (scale up, not out); server-
authoritative everything (the browser can never choose a model or reasoning
level); token efficiency (“give the model the map, not the dump”); graceful
degradation (every missing engine or failed step lands on an honest fallback,
never an exception).

---

## 2. History — how the project evolved

Git history (oldest → newest); everything after the last commit is the
uncommitted 0.2.0 working tree.

| Commit | What landed |
|---|---|
| `9914123` Initial commit | Repo bootstrap. |
| `44bc0b5` **v0.1** | The original product: multi-user chat where each user brought their *own* API keys (per-user encrypted credentials), streaming SSE chat, conversations/messages/files schema, Auth.js v5 invite-only auth, argon2id, admin panel (users/invites/SMTP/whitelist/usage CSV/audit), file uploads (storage-only), Docker stack (Postgres+migrator+app+Caddy), Playwright e2e + vitest + CI. Rose-accented UI. |
| `7578da3` **v0.1.1** | The pivot to today’s model: **central-admin branded assistant**. Removed the per-user model picker and whitelist; keys became **org-level** (admin-managed); added the **4-role pipeline** (frontend/conversation/escalation/failover) with the `escalate` tool hand-off and failover-on-transient-error; provider-native **reasoning levels** with the user-facing quick/extended “Think” toggle; live usage line graph; full-text search; branded HTML emails; app-log + live Logs page; Open-WebUI-style visual overhaul (cool neutrals, slate accent); **removed Anthropic subscription OAuth** (ToS – Console API key only, never re-add). |
| `1b9ac1b` **v0.1.2** | Workspace + streaming UX layer: resizable/collapsible sidebar (shared prefs with admin shell), per-chat kebab (star/rename/AI-rename/export JSON/multi-select delete), top-right account menu (theme, profile picture, delete-all-chats), **incognito chats** (auto-wiped on leave), mic recording with live waveform, scheduled follow-up messages, completion chime, **paced word-reveal + progressive markdown** streaming, per-reply **copy/retry/👍👎** actions, per-user token totals in admin, editable API keys, HTTPS dev workflow. |
| `28a52c7`,`92a272f`,`572712e` | CI hardening: pnpm/action-setup vs `packageManager` conflict; root layout made `force-dynamic` (build was prerendering a DB call); e2e stabilisation; recovered the Logs feature that a bare `logs` .gitignore rule had silently kept out of the repo. |
| `85bb94a` | GitHub Actions bumped to Node-24 majors. |
| `30e7b2f` | **Concurrency hardening** for 10+ simultaneous chats: process-level crash guards (`instrumentation`), Prisma pool sizing (`connection_limit=15&pool_timeout=20`), `UV_THREADPOOL_SIZE=8`. |
| `2e29590` | **`deploy.sh`** — one command for first-run interactive production setup *and* every self-update (git pull → compose up --build). |
| `4e70553` **v0.1.3** | **Full-instance backup & restore**: single-zip snapshots (logical DB dump + storage tree), restore-from-zip, auto-backup scheduler, master-key fingerprint mismatch warning. |
| *(uncommitted)* **v0.2.0** | **The file layer** (57 files): per-chat storage pools, streamed uploads, the multi-container ingestion pipeline (worker + Gotenberg + Docling + Whisper), five-group routing, `list_files`/`read_file` tool loop, native image vision, live mic **STT dictation**. Detailed in §6–§8. |

---

## 3. Stack

- **Next.js 15** (App Router) + **React 19**, TypeScript strict
- **Tailwind CSS v4** (CSS-first `@theme` in `globals.css`), next-themes
- **PostgreSQL 16 + Prisma 6**; **Auth.js v5** (Credentials, JWT cookies), argon2id via `@node-rs/argon2` (never bcrypt)
- Provider SDKs: `openai`, `@anthropic-ai/sdk`, `@google/genai` (NOT deprecated `@google/generative-ai`)
- **Python 3.12 worker container** (ingestion): MarkItDown, pandas/pyarrow/openpyxl, python-magic, Pillow, psycopg3, httpx, ffmpeg
- Engine containers: `gotenberg/gotenberg:8`, `quay.io/docling-project/docling-serve-cpu:v1.26.0`, `onerahmet/openai-whisper-asr-webservice:v1.9.1` (faster-whisper)
- Vitest (unit) + Playwright (e2e), pnpm 11 via corepack, Docker + Caddy for prod
- Windows for local dev, Linux containers in production

---

## 4. Architecture at a glance

```
Browser ── SSE ──► Next.js app (Node, single instance)
                     ├─ /api/chat        streaming pipeline (4 roles, tool loop)
                     ├─ /api/files       streamed uploads → per-chat pools
                     ├─ /api/stt         mic dictation → Whisper
                     ├─ admin pages, actions, auth
                     └─ Prisma ──► PostgreSQL  ◄── (same DB is the job queue)
                                     ▲
Storage volume  ◄── shared ──►  Python worker container (router)
 <tenant>/chats/<convId>/…            ├─► gotenberg:3000   (LibreOffice→PDF)
   .opninfer/<fileId>.md             ├─► docling:5001     (OCR, heavy profile)
                                      └─► whisper:9000     (ASR, heavy profile)
```

The app and the worker never talk to each other directly — they share the
database (the `files` table is the queue) and the storage volume.

---

## 5. Core subsystems (pre-0.2.0)

### 5.1 Auth & access model — invite-only
- First run: `/setup` bootstraps the first admin (only while user-count = 0).
- After that: admins invite by email (`createInvite` → 32-byte token, SHA-256
  hash stored, 7-day expiry, raw token only in the emailed link) or create/
  approve users directly. `acceptInvite` creates the verified user
  transactionally.
- Login: Credentials provider → argon2id verify → JWT session cookie (7 days)
  carrying `id`+`role`. Unverified/disabled accounts are blocked at authorize.
- Password reset: `/forgot-password` → generic response (never reveals account
  existence) → 1-hour single-use hashed token → reset also sets
  `emailVerified` (proves mailbox ownership).
- Route protection in `src/middleware.ts` (edge): everything requires a
  session except the auth flows; `/admin` additionally requires the admin
  role. With no SMTP configured (dev), links are logged to the console and
  accounts auto-verify.

### 5.2 Assistant configuration
One `settings` row (`assistant_config`): assistant name + optional logo + four
`RoleConfig`s — each `{ credentialId, provider, model, reasoning?,
reasoningExtended? }`. Only **conversation** is required to go live; only
conversation may carry `reasoningExtended` (powers the user’s “Think” toggle —
the client sends a boolean, the server picks the actual level). Admin →
Models binds each role to (org credential → live-listed model → reasoning
dropdown).

### 5.3 Provider abstraction (`src/lib/providers/`)
One `Provider` interface per file (`openai.ts`, `anthropic.ts`, `google.ts`);
`registry.ts` wires them; adding a provider = one new file + registry entry.
`streamChat` yields normalized `ChatChunk`s: `text | thinking | tool_call |
usage | error(retryable?)`. Key points:

- **TokenUsage is normalized**: `inputTokens` is always the *uncached* full-
  price input; cache read/write tracked separately (each provider reports
  cache tokens on different conventions — mapped per provider).
- **Anthropic**: Console API key only (subscription OAuth removed — ToS; never
  re-add). Prompt caching via `cache_control` breakpoints on the system prompt
  + final message block. Adaptive thinking (`thinking.type:"adaptive"`,
  `display:"summarized"`) + `output_config.effort`; `budget_tokens` is
  deprecated/rejected on current Opus; `max_tokens` is raised when thinking is
  on. Sampling params (temperature) are NOT sent (rejected by Opus 4.7/4.8).
- **OpenAI**: Chat Completions; `max_completion_tokens` (legacy `max_tokens`
  is rejected by gpt-5.x/o-series); `reasoning_effort` only sent when
  configured; no live thinking stream on Chat Completions.
- **Google**: `@google/genai`; roles are user/model; system prompt is
  `systemInstruction`; Gemini 3.x `thinkingLevel` (or `thinkingBudget` for
  off/dynamic/numeric); thoughts stream when `includeThoughts`.
- **errors.ts** `isRetryableError`: 5xx/network/408/409/429 → transient
  (failover-eligible); other 4xx → config bug (surfaced, never masked).
- **model-cache.ts**: per-credential in-memory model list, 1-hour TTL,
  fallback list per provider when live listing fails (in-process — one of the
  reasons the deployment is single-instance).
- **pricing.ts**: hardcoded USD/1M-token rates, longest-prefix model match,
  cost written to `usage_records.cost_estimate` at log time; unknown model →
  cost 0.

### 5.4 The pipeline (`src/lib/pipeline.ts`) — one user turn
`runAssistant(config, messages, ctx)` streams the conversation model, offering
the internal `escalate` tool (when an escalation role exists) plus the file
tools (§7). Semantics:

- **Escalation**: on an `escalate` tool call, the conversation model’s partial
  text is suppressed and the escalation model produces the real answer (it
  gets the file tools too). Its usage is still recorded.
- **Failover**: a *retryable* error before any text was produced → notice +
  switch to the failover role (tool-free — reliability path). A non-retryable
  4xx is surfaced to the user and logged for the admin, never masked.
- **Tool loop** (0.2.0): up to 4 rounds of file-tool execution, then a final
  round with file tools withheld so the model must answer. Tool calls are
  buffered per round, executed server-side, appended as
  `assistant(toolCalls)` + `tool` messages, and the model re-invoked.
- **Usage**: every role that ran gets a `usage_records` row tagged with its
  role — nothing is skipped, even on escalated/failed turns.
- Titles (`generateTitle` — 2–5 words + emoji, from the frontend role) and
  idle follow-up suggestions (`generateFollowups` — 3 JSON strings) run as
  non-streamed completions.

The `/api/chat` route wraps this in SSE (`meta/text/thinking/notice/usage/
title/error/done` events), persists user+assistant messages, threads
`req.signal` into the provider SDK so a client disconnect aborts the upstream
call, and AI-titles any conversation receiving its **first** user turn (which
covers chats created by file-attach). `regenerate: true` deletes trailing
assistant messages and re-runs over the same history (the Retry button).

### 5.5 Chat experience (client)
- **Paced word reveal** (`usePacedReveal` in `message-bubble.tsx`): a rAF loop
  advances a “shown” cursor toward the received length at a speed proportional
  to the backlog (time-constant ≈180ms streaming / ≈70ms draining, ≥45 chars/s
  floor) — so Anthropic’s bursty chunks render as smooth word-by-word flow
  that still tracks the true token rate. Words fade in via `oi-token-in`
  (opacity only); the trailing partial word is held back so words appear
  whole; no fake caret.
- **Progressive markdown** (`StreamingMarkdown`): completed blocks (up to the
  last blank line, never splitting an open ``` fence) render as real markdown
  immediately; the block still being typed stays as fading plain text.
- **Reply actions**: Copy (markdown source), Retry (last reply), 👍👎 rating →
  `messages.meta.rating` + audit. A Claude-Code-style status (spinning sparkle
  + shimmering random gerund from `thinking-words.ts`) shows while thinking.
- **Workspace**: resizable/collapsible sidebar (localStorage prefs shared with
  the admin shell), date-grouped conversations with optimistic client store
  (`conversations-store.tsx`: upsert/bump/patch/remove), ⌘K full-text search,
  incognito chats (created flagged, wiped via `pagehide` → sendBeacon →
  `/api/chat/incognito-cleanup`), completion chime (Web-Audio two-note ding
  when a reply finishes in a hidden tab), queued “send when reply finishes”
  messages, stick-to-bottom auto-scroll that yields when the user scrolls up.

### 5.6 Admin area — 8 pages
`AdminShell` (same resizable nav + account menu as chat) over: **API** (org
provider keys — add/verify/rename/replace, encrypted), **Models** (the four
role bindings), **Users** (list/edit/invite/approve/reset-password/disable/
delete + lifetime token totals), **Usage** (totals, live token-throughput line
graph with hour→year ranges, by-role/model/user breakdowns, CSV export),
**SMTP** (config + test-send), **Customise** (assistant identity, portal
branding logo + light/dark accent, usage-stats visibility, **max upload
size**), **Backups** (§5.8), **Logs** (live SSE app-log feed).

### 5.7 Usage, audit, logging
Every model call writes a `usage_records` row (user, role, provider, model,
normalized tokens, cost). `audit_log` records admin/user actions;
`app_log` is the structured application log, persisted AND fanned out
in-memory to the live Logs SSE stream. `usage_records.user_id` is
ON DELETE SET NULL — billing history survives account deletion.

### 5.8 Backup & restore (`src/lib/backup.ts`)
A backup is a single zip: `manifest.json` (versions, row counts, **fingerprint
of `OPNINFER_MASTER_KEY`**), `database.json` (portable **logical** dump of
every table — type-aware: Bytes→base64, BigInt/Decimal→string, DateTime→ISO),
and `storage/<tenant>/…`. Backups live in `<storageRoot>/backups` (outside the
tenant tree). Restore decodes everything *before* wiping, then in one
transaction empties children→parents and repopulates parents→children via
chunked `createMany`, then raw-UPDATEs `updated_at` back (Prisma would
re-stamp `@updatedAt`). The migration table is never touched — a backup
restores into the *current* schema. Master-key mismatch is flagged (encrypted
provider keys won’t decrypt). Auto-backups: in-process scheduler
(`instrumentation-node.ts`), `backup_config` setting, 10-minute tick,
retention pruning, default off.

---

## 6. The file layer (0.2.0) — storage pools

**Every conversation owns a storage pool**: `<root>/<tenant>/chats/<convId>/`.
Files keep **human-readable names** (`usersheet.xlsx`, deduped as
`usersheet (2).xlsx` via exclusive-create retry) because the model addresses
them by name. A hidden `.opninfer/` subdir holds the worker’s prepared
artifacts (`<fileId>.md`) — never listed, never re-ingested. All DB storage
paths are **POSIX-style** even when written on Windows dev (the Linux worker
reads them).

- **Uploads stream to disk** (busboy parses the multipart body; a Transform
  meter enforces the admin-set size limit mid-flight → 413 + partial-file
  cleanup; nothing ever buffers in RAM). Params ride the query string
  (`/api/files?conversationId=…&incognito=1`) because multipart field order
  can’t be trusted while streaming.
- **Create-on-attach**: attaching in a brand-new chat creates the conversation
  server-side (incognito-aware) and the client adopts it; a failed first
  upload rolls the conversation back.
- **Downloads** (`/api/files/[id]`) are owner-scoped + signed-in only.
- **Deletion is complete**: single delete, bulk delete, delete-all-my-chats,
  incognito wipe, and admin account-deletion all capture paths first, delete
  DB rows, then remove pool dirs + legacy paths + avatar from disk. (Before
  0.2.0 chat deletion leaked files on disk — fixed.)
- **Admin knob**: Customise → Uploads → max MB per file (`max_upload_bytes`
  setting, ceiling 2 GB, env default 50 MB).
- Retention is infinite until the user deletes the chat or an admin deletes
  the account. Backups include the pools (full-instance fidelity).

---

## 7. The ingestion pipeline (0.2.0)

**Goal: token efficiency.** Every file gets a metadata block no matter what;
“supported” files also get a prepared content artifact. The model receives a
compact manifest and pulls content on demand — the map first, content only
when needed, never a blind dump.

**Topology**: a thin Python **router/worker** (our container) + official
engine images. No broker: the `files` table IS the queue. The worker claims
rows with `FOR UPDATE SKIP LOCKED` (N threads, default 2), marks
`processing`, re-claims stale claims after 15 min, gives up after 3 attempts.
Statuses: `pending → processing → ready | unsupported (stored, metadata only)
| failed`. Chips in the composer poll `/api/files/status` and show a spinner →
ready/red-dot live.

**Routing** (`detect.py`): magic bytes via python-magic (extensions lie) +
extension intent, mapped to groups:

| Group | Handler | Formats | Output |
|---|---|---|---|
| markitdown | embedded MarkItDown lib | docx pptx pdf-with-text html xml epub msg eml zip ipynb md | full markdown content |
| libreoffice | Gotenberg → PDF → MarkItDown | doc ppt odt odp rtf pages key | markdown content |
| docling | docling-serve (OCR) | scanned/complex PDFs — **escalated** from markitdown when a PDF >50 KB yields <200 chars (thin text alone ≠ scanned; small short PDFs are legit) | markdown content |
| spreadsheet | openpyxl/pandas/pyarrow | xlsx xlsm xls ods csv tsv parquet orc | **schema**: sheets, rows×cols, headers, dtypes, 5 sample rows; full dump only ≤100 rows |
| database | sqlite3 introspection (read-only immutable) | db sqlite sqlite3 (mdb/accdb → metadata) | tables, columns, types, FKs, row counts — never data |
| audio | whisper-asr-webservice | mp3 wav m4a flac ogg … webm | transcript artifact + language/duration meta |
| video | ffprobe (in-worker CLI) | mp4 mov mkv … | metadata only (duration, resolution, codecs, fps, audio-present) |
| image | Pillow | png jpg gif webp heic … | dimensions/EXIF meta; content handled by **native vision** at chat time |
| passthrough | UTF-8 sweep | the entire long tail of code/config/text | file content verbatim |
| metadata | graceful floor | everything else (binaries, unknown) | metadata block only, never an exception |

Artifacts are capped (~400k chars, truncation flagged); `token_estimate` =
len/4. Docling + Whisper are **opt-in** (`COMPOSE_PROFILES=heavy`) — without
them their routes degrade to honest metadata-only notes.

---

## 8. Chat integration of files + vision + STT (0.2.0)

- **Manifest**: when a chat has files, `/api/chat` prepends a system block —
  one compact line per file (name · group/type · size · one-line meta ·
  ~token estimate · readability note) — and offers two tools.
- **Tools** (`src/lib/file-tools.ts`): `list_files` (refresh the manifest) and
  `read_file {name, page?}` (paged at 12k chars, returns prepared content or
  honest metadata). Executed server-side, ownership enforced via the
  conversation id. `read_file` emits a user-visible “Read <name>” notice.
- **Tool loop**: see §5.4 — bounded rounds in `runAssistant`; the message
  shape (`ChatMessage`) gained `role:"tool"`, `toolCalls`, `toolCallId`,
  `toolName`, `images`, mapped per provider (OpenAI `tool_calls`/`tool` role/
  `image_url` data-URIs; Anthropic `tool_use`/`tool_result` blocks — parallel
  results merged into one user turn — and base64 `image` blocks with the
  cache breakpoint preserved on the final block; Google `functionCall`/
  `functionResponse` (matched by *name*) / `inlineData` parts).
- **Native vision**: images attached to the current turn ride the user message
  as image parts (≤6/turn, ≤8 MB each, png/jpeg/gif/webp). No separate vision
  model.
- **STT dictation** (`POST /api/stt`): the composer mic records → the blob
  posts to the route → forwarded to Whisper (`WHISPER_URL`) → the transcript
  lands in the input box (appended, refocused). If the engine is off or
  unreachable → clean 503 → the client falls back to attaching the recording
  as a stored audio file (which the async pipeline then transcribes anyway).
  Capped at 25 MB. In dev, whisper publishes `127.0.0.1:9000` so the
  host-side dev app can reach it; in prod the app container gets
  `WHISPER_URL=http://whisper:9000`.

**Verified live** (manual harnesses in `scripts/`, ~66 checks total): pools/
dedupe/ownership/413/wipe (`test-files-http.ts`), Group 1 + fallback
(`test-ingestion-http.ts`), specialist handlers (`test-ingestion-c-http.ts`),
OCR escalation + transcription (`test-ingestion-d-http.ts`), and the finale —
a real configured model calling `read_file` to answer with a value that exists
only inside an uploaded CSV, and reading a word off an uploaded PNG via vision
(`test-chat-files-http.ts`), plus STT round-trip in 3.8s (`test-stt-http.ts`).

---

## 9. Data model (`prisma/schema.prisma`)

Two tiers. **Permanent** (survives chat deletion): `users`, `invites`,
`password_reset_tokens`, `provider_credentials` (org-level; `user_id` nullable
SET NULL), `usage_records` (SET NULL — billing survives account deletion),
`audit_log`, `app_log`, `settings` (key-value JSON). **Ephemeral** (cascades
with the conversation): `conversations` (`pinned`, `incognito`), `messages`
(`meta` Json holds the reply rating), `files`.

`files` doubles as the **ingestion queue**: `kind` (upload|generated), `status`
(FileStatus enum), `detected_mime`, `processor_group`, `content_path`, `meta`
Json, `token_estimate`, `attempts`, `claimed_at`, indexed on `status`.

Well-known `settings` keys: `assistant_config`, `branding`, `smtp`,
`usage_visibility`, `backup_config`, `max_upload_bytes`.

---

## 10. Security model

- Provider keys AES-256-GCM encrypted at rest (`OPNINFER_MASTER_KEY`, 32-byte
  base64; layout `[12B IV | 16B tag | ciphertext]`). Losing the key only loses
  the stored provider keys (re-enter them); everything else is plaintext or
  hashed. Backups embed only a *fingerprint* of the key.
- Passwords argon2id; invite/reset tokens stored as SHA-256 hashes only.
- Server-authoritative model/reasoning selection; client sends only a boolean
  extended-thinking toggle.
- Path-traversal guards on every storage resolve (pools, artifacts, branding,
  avatars, backups); pool dir names must be UUIDs; uploaded names sanitized
  (control chars + reserved punctuation; leading dots stripped so `.opninfer`
  can’t be shadowed).
- Downloads/avatars owner-or-auth-gated; branding images public (login page).
- Never commit `.env`; never accept API keys pasted into chat.

---

## 11. Concurrency & scale

Single instance by design (in-memory model cache + log-listener set + local
storage volume). Safe at 10+ simultaneous chats because: the pipeline is
per-request async generators (no shared mutable state); Prisma connections are
held per *query*, never for the stream (pool sized via
`connection_limit=15&pool_timeout=20` on `DATABASE_URL` — the main throughput
knob); process-level `unhandledRejection`/`uncaughtException` guards in
`instrumentation-node.ts` keep one bad request from dropping every SSE stream;
`UV_THREADPOOL_SIZE=8` so argon2 logins + file I/O don’t queue; SSE routes
abort upstream calls on client disconnect. Worker concurrency is its own knob
(`WORKER_CONCURRENCY`, default 2). Upstream provider limits are the real
ceiling; 429s fail over.

---

## 12. Deployment & operations

`deploy.sh` is the single entry point: first run (no `.env`) prompts for the
domain, generates all secrets, writes `.env` (chmod 600), and brings up the
stack; every later run does `git pull --ff-only` + `docker compose up -d
--build` (migrations auto-apply via the one-shot migrator). `.env` is never
regenerated. The stack: Postgres · migrator · Next.js standalone app · **worker**
· **gotenberg** · Caddy (auto-TLS) — plus **docling** and **whisper** when
`COMPOSE_PROFILES=heavy` is set in `.env` (they load ML models; budget RAM).
Private repo → the host needs an SSH deploy key or `gh auth`. Back up
`OPNINFER_MASTER_KEY`.

Local dev: `pnpm dev` (or `dev:https` for mic/LAN — secure-context APIs);
`docker compose -f docker-compose.dev.yml up -d` runs Postgres + worker +
Gotenberg (`--profile heavy` adds Docling/Whisper; whisper publishes
`127.0.0.1:9000` for the host-side STT route).

---

## 13. Testing & CI

- **Unit** (vitest): provider helpers (chat-model filter, enum mapping, model
  cache TTL). `pnpm test`, 7 tests.
- **E2E** (Playwright, serial): setup→admin login→chat shell→admin nav→auth
  redirects. Global setup truncates the DB — refuses to run unless the DB name
  contains `e2e` or CI is set.
- **Manual harnesses** (`scripts/*.ts`, NOT in the suite — they hit live
  services/keys): provider smoke, chat flow, backup round-trip + HTTP, and the
  six file-layer/STT harnesses (§8). Run with
  `node --env-file=.env --import tsx …` (+ `--loader ./scripts/shim-server-only.mjs`
  for `server-only` modules; `--experimental-sqlite` where used).
- **CI** (GitHub Actions): `checks` job (install → prisma generate → typecheck
  → vitest → build with dummy env) + `e2e` job (Postgres service → migrate →
  build → Playwright chromium). Actions pinned to Node-24 majors; pass no pnpm
  `version:` input (comes from `packageManager`).

---

## 14. Conventions & sharp edges (the ones that bite)

1. **Never run `pnpm build` while `pnpm dev` runs** (shared `.next` → every
   route 500s; recovery: stop dev, delete `.next`). Verify with
   `pnpm typecheck` instead.
2. **`instrumentation.ts` is compiled for Edge too** — Node-only imports go in
   `instrumentation-node.ts` behind the *positive*
   `if (NEXT_RUNTIME === "nodejs") await import(...)` guard (the inverted
   form is not tree-shaken). `archiver` is in `serverExternalPackages`.
3. **Root layout is `force-dynamic`** (reads branding from DB) — keeps builds
   from prerendering against the dummy DB.
4. Storage paths in the DB are **always forward-slash**; the worker tolerates
   legacy backslash rows.
5. Prisma `Bytes` writes need `new Uint8Array(buffer)`.
6. `.gitignore`: never a bare `logs`/`build`/`dist` (a bare `logs` once hid
   the whole Logs feature).
7. Secure-context APIs (`crypto.randomUUID`, `getUserMedia`) don’t exist on
   plain-HTTP LAN IPs — `src/lib/uid.ts` fallback + `pnpm dev:https`.
8. Leave `AUTH_URL` unset in dev (set = login redirects hijacked to that
   host); set it only in production.
9. pnpm 11: native build allowlist lives in `pnpm-workspace.yaml`
   `allowBuilds:`, not package.json.
10. PowerShell wraps stderr banners as fake “NativeCommandError”s — trust exit
    codes.

---

## 15. Current state & what’s next

**State (as written, 2026-07-01):** working tree = v0.2.0, complete and
live-verified but not yet committed. *(Outcome: committed as `04da1f9`;
everything below shipped as v0.3.0 on 2026-07-20.)* Two known deferred
niceties, still open today: no readers for Access/.numbers/avro (honest
metadata-only), and old `unsupported` rows aren’t re-queued when heavy
engines come online later.

**Next phase (the reason this brief exists): “let the AI iterate like Claude
Code.”** The vision from the product owner: the assistant should be able to
*act* on the storage pool, not just read it — e.g. take `usersheet.xlsx`, run
code against it, and write `usersheet-edited.xlsx` back into the pool; crop an
uploaded image into ad sizes; generate new files — iterating with tools the
way coding agents do. Groundwork already in place:

- Pools are per-conversation directories a sandbox can mount in isolation.
- `files.kind = "generated"` exists for assistant-produced files; generated
  files flow through the same ingestion/manifest/download machinery.
- `saveBufferToPool()` writes assistant output into a pool safely.
- The tool loop in `runAssistant` is generic — new tools are “add a ToolDef +
  an executor”, and every provider already round-trips tool calls/results.
- The worker container pattern shows how to add an execution sidecar.

Design questions still open for that phase: sandbox technology (container-
per-execution vs pooled jail), resource/time limits, which runtimes to offer
(Python first, with pandas/Pillow/openpyxl to match the ingestion stack),
how results/errors stream back into the loop, how many iterations to allow,
and how generated files surface in the UI (chips on the reply). The safety
bar: the sandbox must see exactly one chat’s pool, no network by default, and
hard CPU/memory/time caps.
