# OPNinfer

Self-hosted, multi-user AI chat portal for organisations — it runs on your own
infrastructure and your conversations never leave it. An **admin**
holds the provider API keys (OpenAI, Anthropic, Google Gemini — encrypted at
rest) and configures a single branded **"[Company] AI Assistant"**; regular
users get a polished chat interface only — no settings, no model picker, no
keys. Every request's token usage and cost is tracked per user and per
pipeline role.

> **v0.6.2** — Next.js 15 (App Router) · React 19 · TypeScript (strict) ·
> Tailwind v4 · PostgreSQL 16 + Prisma · Auth.js v5 · official provider SDKs ·
> Claude Agent SDK (the Sandbox tier).

## Features

- **One assistant, four model roles** — a cheap *frontend* model (emoji chat
  titles, idle follow-up suggestions, background analyses), the *conversation*
  workhorse, a heavyweight *escalation* model the workhorse hands off to via an
  internal tool, and a *failover* model for transient provider outages. All
  admin-bound in **Admin → Models**; a 4xx config error is surfaced honestly,
  never masked by failover.
- **Streaming chat, done properly** — paced word-by-word reveal with
  progressive markdown, live thinking status, **resumable streams** (leave,
  refresh, or close the tab mid-reply — generation continues server-side and
  re-attaches when you return), server-side stop, mid-turn steering (type
  while the assistant is working and it course-corrects between tool rounds),
  scheduled follow-up messages, a completion chime, and per-reply
  copy / retry / listen (TTS) / 👍👎 actions.
- **Clarifying questions** — at a genuine fork in a request the assistant
  raises a multiple-choice card above the composer and its reply *pauses*
  mid-flow until you answer, then continues in the same reply rather than
  charging you for a second turn. Pick an option, type your own, skip, or reply
  normally underneath; the answer is remembered by later turns.
- **Server-authoritative reasoning** — provider-native reasoning levels
  (OpenAI `reasoning_effort`, Anthropic adaptive thinking, Gemini
  `thinking_level`) picked by the admin from dropdowns; users get at most a
  quick/extended **"Think" toggle** (the browser only ever sends a boolean).
- **Files the assistant can actually use** — upload any file into a chat's
  private storage pool. A multi-container pipeline prepares token-efficient
  content: Office/PDF → markdown (MarkItDown, LibreOffice/Gotenberg, Docling
  OCR), spreadsheets/databases → schema + samples (never a raw dump), audio →
  Whisper transcripts, video → ffprobe metadata, images → native model vision.
  Prepared content is inlined into the model's manifest within a token budget;
  the rest is read on demand via tools. Downloads stay owner-only; deleting a
  chat deletes its files from disk.
- **The Sandbox (v0.4)** — for anything substantial the assistant hands the
  job to a full autonomous agent (the Claude Agent SDK, the technology behind
  Claude Code) running in **that chat's own locked-down container**: it writes
  and runs code, checks its results, iterates, and presents the finished files
  — with every step streamed live into the chat as code and console blocks.
  Follow-ups **resume the same agent session** ("now make it blue" edits the
  same files), typing mid-run steers it, Stop ends it in under a second, and
  every chat's agent state is kept apart. Paid for either by the
  organisation's API key (which never enters the container — a credential
  proxy injects it and meters real usage) or by the operator's own Claude
  subscription (signed in through Anthropic's own flow; plan usage shown on
  the admin card). Enabled and configured per instance in **Admin → Tools**.
- **Connected services (MCP, per instance)** — an instance's Sandbox can be
  signed in to MCP servers such as Figma with Claude Code's own commands
  (`./deploy.sh agent-mcp <instance> add figma https://mcp.figma.com/mcp`,
  then `… login figma`); the sign-in lives in that instance's credential
  volume, never in the portal, and other instances on the host are
  unaffected. Admin → Sandbox shows what is connected.
- **An assistant that acts** — web search & page reading (Tavily), SSRF-guarded
  file/repo downloads into the chat, image generation/editing/blending
  (Gemini, per-user weekly quotas), per-user memory, loadable skills, inline
  streamed visualizations, and instance capabilities (e.g. live property
  search) — all toggled per instance in **Admin → Tools**, with progressive
  tool disclosure + context curation keeping token costs down and every model
  call metered.
- **Voice both ways** — mic dictation with a live waveform (Whisper STT) and a
  hover **Listen** button that reads replies aloud (Kokoro TTS, segmented
  streaming for ~2s first audio).
- **Long chats stay affordable (v0.6)** — once a conversation's history
  reaches an admin-set size (default 96k tokens), the older part is condensed
  into a rolling summary by the cheap front-end model and the reply model
  reads that plus the recent turns; the whole chat stays on screen with a
  thin divider where the summary begins. Chats already over the line are
  compacted on the next deploy.
- **Memory that notices (v0.5.1)** — the assistant keeps four short notes per
  person (who they are, how they like replies, their work, rules they've
  given), fills them in itself once a chat has been quiet for 30 minutes, and
  can search a person's own past chats ("what did we decide about…"). People
  read, edit, pause and reset their notes in Settings; sensitive matters are
  never kept unless asked; incognito and shared chats are never read.
- **Shared chats (v0.5)** — share a chat with colleagues and work in it
  together: everyone sees the same reply stream in at the same moment, every
  message shows who wrote it, anyone in the chat can send, attach files,
  answer the assistant's questions, steer a running task or line up a message
  for when the reply finishes (a shared, server-held queue). The owner adds
  and removes people from a People panel; members can leave. Personal memory
  stays out of shared chats.
- **Workspace UX** — resizable/collapsible sidebar, full-text search (⌘K),
  per-chat star/rename/AI-rename/export/multi-select-delete, incognito chats
  (auto-wiped on leave), profile pictures, light/dark themes, edit-and-revert
  on your own messages, chat titles in the browser tab, and a **What's new**
  panel that shows each release's notes once and is reopenable from the account
  menu.
- **Admin area (11 pages)** — API keys (add/verify/rename/replace), Models,
  Users (invite/approve/reset/disable/delete + lifetime tokens), **Chats**
  (read any user's conversation to answer a support request — gated behind
  re-entering your own password, every chat opened is audited, incognito
  chats excluded), a full
  **Usage dashboard** (KPI cards with deltas, throughput + cost charts,
  model/user/role/provider breakdowns, activity feed, CSV), **Feedback**
  (every rated reply with an AI "why" analysis), SMTP (+ **error alerts** —
  email someone whenever the portal logs an error, throttled and rate-capped —
  and a **weekly report**: a scheduled digest of spend, grouped errors and
  system health, at a real local time that survives the clock change),
  Customise (assistant identity, **standing instructions**, portal branding,
  upload limits), **Tools**, **Backups**, and live **Logs** (per-chat and raw
  views).
- **An assistant that sounds like your business** — per-instance standing
  instructions (Admin → Customise) ride every reply as the first system block,
  carried into escalation and failover, so each portal behaves like that
  client's assistant rather than a generic one.
- **Updates that don't cut people off** — a deploy drains the instance first:
  new turns and uploads are declined with a calm "we're updating" notice (your
  typed message is handed back, not lost) while replies already in flight are
  given time to finish before the container is replaced.
- **Backup & restore** — one-click zip of the whole instance (database + stored
  files), scheduled auto-backups with retention, and restore-from-zip.
- **Invite-only access** — an admin invites by email or approves accounts
  manually; no open signup. Argon2id passwords, JWT sessions.
- **Accurate usage & cost** — token usage is normalized across each provider's
  different cache-token conventions, and cost is computed from real pricing.

Providers: **OpenAI**, **Anthropic** (Console API key only), **Google Gemini**.

## Quick start (local dev — Windows or Linux)

Prerequisites: Node ≥ 20, [pnpm](https://pnpm.io) (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env          # then fill AUTH_SECRET + OPNINFER_MASTER_KEY:
                              #   openssl rand -base64 32   (run it twice)
docker compose -f docker-compose.dev.yml up -d   # Postgres + ingestion worker
                                                 # + Gotenberg + sandbox broker
pnpm prisma migrate deploy
pnpm dev                      # or: pnpm dev:https  (mic/LAN needs HTTPS)
```

For local dev, point `DATABASE_URL` at `...@localhost:5432/...` in `.env`.
Open http://localhost:3000 — the first visit lands on **/setup** to create the
initial admin. After that, access is invite-only. Add provider keys in
**Admin → API** (or drop them in `.env` and run `scripts/seed-keys.ts`) and
bind the four model roles in **Admin → Models**.

Heavy engines (Docling OCR, Whisper STT, Kokoro TTS) are opt-in:
`docker compose -f docker-compose.dev.yml --profile heavy up -d`.

Without SMTP configured, invite/reset emails are printed to the server console
and admins can copy invite links directly from the admin panel.

## Deploy (production)

One script handles first-time setup **and** every update, for **every portal
instance on the host**: [`deploy.sh`](deploy.sh). It installs Docker itself if
missing (official `get.docker.com` script), so a fresh Ubuntu box only needs
git access to this (private) repo — either an SSH **deploy key** (recommended
for a server) or the GitHub CLI:

```bash
# Option A — SSH deploy key (read-only, per-repo). Add the server's public key
# under GitHub → repo → Settings → Deploy keys, then clone over SSH:
git clone git@github.com:CoppingEthan/OPNinfer.git

# Option B — GitHub CLI:
gh auth login                       # once, interactively
gh repo clone CoppingEthan/OPNinfer
```

Then, from inside the checkout:

```bash
cd OPNinfer
./deploy.sh
```

**First run** checks/installs Docker, then walks you through creating your
instances — each is a fully isolated portal (own database, own file storage,
own admin, own provider keys, own secrets) defined by one generated env file
in `instances/<name>.env`. For each instance you give a short name, its public
domain, and a local port (auto-suggested: 3001, 3002, …). The script then
builds the images once, starts the **shared engines**, and brings every
instance up. Migrations apply automatically per instance.

**To update all instances**, re-run the same command:

```bash
./deploy.sh                         # git pull + rebuild once + update every instance
./deploy.sh add                     # add another instance later
```

Updates never touch data or regenerate env files — each instance's master key,
sessions, database, and files are preserved.

### How it's laid out

- **One checkout, N instances.** Every instance is its own Docker Compose
  project (`opninfer-<name>`): Postgres + migrator + app + ingestion worker +
  sandbox broker, with its own named volumes (`opninfer-<name>_pgdata`,
  `opninfer-<name>_storage`). Instances can't see each other's data.
- **Shared engines, one copy for all.** Gotenberg (Office→PDF), Docling (OCR),
  Whisper (speech-to-text) and Kokoro (text-to-speech) run **once** in the
  `opninfer-engines` stack — always on, shared safely because they're
  stateless converters that store nothing. Tune via `engines.env`
  (`WHISPER_MODEL`, GPU `TTS_IMAGE`).
- **Your reverse proxy terminates TLS.** There's no bundled TLS server — each
  instance publishes plain HTTP on its port, bound to `0.0.0.0` so a reverse
  proxy elsewhere on the network can reach it. Point each site at
  `http://<host>:<port>`.

### Reverse-proxy requirements (per site)

- Forward the `Host` and `X-Forwarded-Proto` headers (auth redirects depend
  on them; each instance's `AUTH_URL` is its public https domain).
- **Disable response buffering** — chat streams over Server-Sent Events.
- Allow request bodies ≥ the upload limit (default 50 MB).
- Generous read/idle timeouts (replies can stream for minutes).

> **Back up each instance's `OPNINFER_MASTER_KEY`** (in `instances/<name>.env`)
> — without it, that instance's stored provider keys can't be decrypted. Each
> portal is single-process by design (in-memory caches, local storage volume):
> scale **up** (CPU/RAM, `connection_limit`), and add portals side-by-side on
> the same host rather than clustering one portal.

### Backups

**Admin → Backups** snapshots the whole instance — the database plus all stored
files — into a single downloadable zip, on demand or on a schedule (daily/weekly
with a retention count). Restore by uploading a backup zip (replaces all current
data and files). Backups are written under the storage volume
(`<storage>/backups`), so they persist across updates; copy them off-box for
real disaster recovery. Restoring a backup on a **different** instance needs the
**same `OPNINFER_MASTER_KEY`**, or encrypted provider keys won't decrypt (the UI
warns you when the key differs).

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `pnpm dev`        | Start the dev server                         |
| `pnpm dev:https`  | Dev over HTTPS (mic + LAN testing)           |
| `pnpm build`      | Production build (never while dev runs)      |
| `pnpm typecheck`  | `tsc --noEmit`                               |
| `pnpm test`       | Vitest unit tests                            |
| `pnpm e2e`        | Playwright browser suite                     |
| `pnpm db:migrate` | Apply Prisma migrations (dev)                |
| `pnpm db:deploy`  | Apply Prisma migrations (production)         |
| `pnpm db:studio`  | Open Prisma Studio                           |

## Testing

```bash
pnpm typecheck && pnpm test       # type-check + unit tests
```

The **E2E suite** resets a database whose name contains `e2e` (CI uses an
ephemeral Postgres). To run it locally, create `opninfer_e2e`, migrate it, and
point `DATABASE_URL` at it:

```bash
createdb opninfer_e2e
DATABASE_URL=postgresql://.../opninfer_e2e pnpm prisma migrate deploy
DATABASE_URL=postgresql://.../opninfer_e2e pnpm e2e
```

CI (`.github/workflows/ci.yml`) runs typecheck + unit tests + build, and the
Playwright suite against a real Postgres on every push/PR.

### Live harnesses

The 57 `scripts/test-*.ts` harnesses exercise the real provider APIs and the
full chat/tool/file/UI data path against a live database + the running dev
server (some drive a real headless browser). They read keys from `.env` and run
manually (most import `server-only` modules, so use the loader shim):

```bash
node --env-file=.env --import tsx scripts/test-providers.ts
NODE_TLS_REJECT_UNAUTHORIZED=0 node --env-file=.env --import tsx \
  --loader ./scripts/shim-server-only.mjs scripts/test-tools-live.ts
```

A hand-driven, feature-by-feature verification plan lives in
`docs/E2E_TEST_PLAN.md` (with test assets in `test-kit/`).

## Architecture

- **Assistant pipeline** (`src/lib/pipeline.ts` + `src/lib/assistant.ts`) —
  the four admin-bound roles; the conversation model streams with a bounded
  multi-round tool loop, hands off to escalation via an internal tool, and
  fails over only on transient errors.
- **Providers** (`src/lib/providers/`) — one `Provider` interface per file;
  `registry.ts` wires them up. Anthropic runs on a Console API key only
  (subscription OAuth was removed for terms-of-service reasons and must not
  return). Usage is normalized to a single `TokenUsage` shape (uncached input +
  cache-read + cache-write + output) so cost is computed one way (`pricing.ts`).
- **Tools** (`src/lib/tools/` + `sandboxd/`) — a registry of grouped tools with
  progressive disclosure; the sandbox broker is the only holder of the Docker
  socket and runs per-chat isolated containers.
- **Files** (`worker/` + `src/lib/file-tools.ts`) — per-chat storage pools; the
  `files` table doubles as the ingestion queue (`FOR UPDATE SKIP LOCKED`, no
  Redis) for a thin Python router + official engine containers.
- **Data model** (`prisma/schema.prisma`) — two tiers: permanent data (users,
  credentials, `usage_records`, feedback, memories) and ephemeral chat data
  that cascade-deletes with a conversation. Billing records are never
  cascade-deleted (`SET NULL`).
- **Auth** (`src/auth.ts`, `src/middleware.ts`) — Auth.js v5 split config so the
  edge middleware stays Node-free; `/admin` is role-gated.
- **Chat** — `POST /api/chat` streams Server-Sent Events; generation runs
  detached from the request so streams are resumable; every model call writes
  a `usage_records` row with computed cost.

Deeper reading: `CLAUDE.md` (the living reference), `docs/PROJECT_BRIEF.md`
(narrative), `docs/ARCHITECTURE.md` (design rationale),
`docs/V03_AGENTIC_TOOLS.md` (agentic-tools design record).

## Security notes

- Provider keys are org-level, admin-managed, and encrypted at rest
  (AES-256-GCM, `OPNINFER_MASTER_KEY`).
- Model choice and reasoning level are server-authoritative; the browser can
  only send a boolean "Think" toggle.
- Sandboxed code execution sees exactly one chat's files, capped resources,
  and egress-only networking (no route to the app, database, or broker).
- Invite/reset tokens are stored only as SHA-256 hashes.
- Never commit `.env`. Rotate any key shared in plaintext.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get it running, what
"done" looks like here (pure logic in unit tests, source-pinned tests for
failures with no runtime symptom, live harnesses with a negative control), and
the handful of design decisions that are settled and will be declined.

Security problems go through GitHub's private vulnerability reporting, never a
public issue — see [`SECURITY.md`](SECURITY.md).

## What is not in this repository

OPNinfer supports **capabilities**: named tool bundles that ship switched off
and are enabled per instance in Admin → Tools. Capabilities built for one
organisation — against that organisation's own systems and data — are not part
of the product, and live in a private downstream repository instead.

`src/lib/capabilities/local.ts` is the seam. Upstream it is an empty list; a
private deployment replaces that one file and adds its own capability modules
beside it. Nothing else needs to change: the Tools page renders a capability it
has never heard of, including the data-source line the capability declares for
itself. See that file's comment if you want to do the same.

## Licence

**GNU Affero General Public License v3.0** — see [`LICENSE`](LICENSE).

In short: you may run, study, modify and share this software freely. If you
modify it and let other people use your modified version **over a network**,
AGPL requires you to offer them the source of your changes. Running an
unmodified copy for your own organisation carries no such obligation.

Copyright © 2026 Ethan Copping and contributors.
