# OPNinfer — project guide for Claude Code

Private, self-hosted, multi-user AI chat portal for OpenAI, Anthropic, and Google
models. This file is auto-loaded by Claude Code; keep it accurate as the project
evolves. **Never put secrets here** (API keys live in `.env`, which is git-ignored).

## Working agreement (Claude Code — read first)

- **The repo is the ONLY durable memory. Do NOT use Claude Code's auto-memory
  directory for this project.** The memory dir lives outside the repo
  (`~/.claude/projects/...`) and does NOT travel with git push/pull, so anything
  saved there is lost when the owner switches machines (which happens — dev
  already moved once). Write every durable fact — decisions, gotchas, working
  preferences, history — into the repo instead. All previous memories were
  folded in and deleted on 2026-07-20 (owner instruction).
- **If asked to "remember" something, two files can take it, and which one
  matters.** THIS file holds facts about the PRODUCT: architecture, decisions,
  conventions, gotchas, anything that would bite whoever runs OPNinfer next.
  A private deployment additionally keeps an **`OPERATIONS.md`** beside it for
  facts about ITSELF: which instances exist, what happened in production, what
  it cost, who the clients are. **If this checkout has one, read it too** — it
  is the first thing to open when something is wrong in production.
  Most incidents teach both things at once. Split them: the lesson goes here
  with the client details filed off ("on one live portal"), the incident goes
  there with the names. Never put a client, a person, a domain, a host address
  or a money figure in this file.
- **Splitting this product: generic work goes UPSTREAM.** The public OPNinfer
  repository is the home of the product; a private deployment is a downstream
  clone that pulls from it and adds only NEW files — its client capabilities
  (through `src/lib/capabilities/local.ts`, the one seam file it replaces), its
  `OPERATIONS.md`, its own `instances/`. That is what keeps `git pull upstream`
  boring: new files never conflict. So before changing a file that exists
  upstream, ask whether the change is about the product or about one client. If
  it is about the product — and nearly everything is — make it upstream and
  pull it down, even when the bug was found on a client's portal.
  **In practice that is a branch, not a second checkout.** A deployment keeps
  ONE clone with two remotes (`origin` private, `upstream` public), and generic
  work is done on a branch taken from `upstream/main`:

      git fetch upstream
      git switch -c fix/<thing> upstream/main   # no client layer on this branch
      …fix it, add the regression, pnpm test…
      git push upstream HEAD:main               # or open a PR
      git switch main && git pull upstream main

  Nothing is done twice: the work happens once, on the branch, and the merge
  brings it back. Branching from `upstream/main` also means the tree you are
  testing IS the public product — `local.ts` is the empty stub there, so a
  change that only worked because a client capability happened to be loaded
  cannot pass unnoticed. Client-specific work is the exception and is committed
  straight to `main`, never pushed upstream.
  `./scripts/split-public.sh check` is the backstop: it fails if `main` has
  edited a file that belongs upstream, which is the mistake that would
  otherwise make every future pull painful.
- **Owner-testing working mode:** the owner tests feature-by-feature and
  reports UX feedback or a broken-chat URL/id. Diagnose from the DB +
  `logs/dev.log` FIRST (don't guess), fix, add a **live-harness regression**
  in `scripts/` recreating the exact chat shape, tick
  `docs/FEATURE_TESTING_CHECKLIST.md`, update this file. **No push until told.**
- **dev.log: analyze the LAST 60 MINUTES ONLY.** The log spans days of testing
  and accumulates errors that were already root-caused and fixed — sweeping the
  whole file sends you chasing ghosts (happened 2026-07-05: flagged two
  already-patched errors as current). Compute the cutoff from the current time
  before reading; timestamps are UTC (`Z`), local dev is BST (+1). Only widen
  the window if the owner asks about something historical.
- **Behavioral bugs are STEERING gaps.** When the model refuses, denies its own
  work, asks permission instead of acting, or misuses a tool, the fix is prompt/
  description text (pipeline steering blocks, tool descriptions) — then PROVE it
  with a live harness recreating the owner's exact chat shape.
- **Communication style:** the owner wants simple, jargon-light explanations and
  one question at a time for approvals. The owner drives UI decisions — check in
  on visual/UX choices rather than assuming.
- **Session hygiene:** restart `pnpm dev` after any Prisma migration (stale
  client → `db.<newModel>` undefined → 500s); never `pnpm build` while dev runs
  (see gotchas); when dev UI misbehaves in a long-lived tab, fresh tab + hard
  refresh first.
- **Docs map:** `README.md` (the public front page — short by design; keep its
  version badge and feature list in step with this file),
  `docs/DEPLOYMENT.md` (running it in production: the script, the proxy
  requirements, sizing, backups, the Sandbox's credentials),
  `docs/ARCHITECTURE.md` (design rationale; header still says v0.3.1),
  `docs/PROJECT_BRIEF.md` (2026-07-01 narrative snapshot — carries a
  "superseded" banner; read for history, not current state),
  `docs/V03_AGENTIC_TOOLS.md` (v0.3 design record, closed out),
  `docs/V04_AGENT_TIER.md` (v0.4 Sandbox agent tier — decisions, architecture,
  every trap found live),
  `docs/V05_SHARED_CHATS.md` (v0.5 shared chats — the owner-confirmed spec:
  rules, the sixteen decisions, the feature-by-feature table, the appendix of
  every owner check that was swept),
  `docs/V051_MEMORY.md` (v0.5.1 memory v2 — the research and the design),
  `docs/V06_CONSOLE.md` (the OPERATOR CONSOLE — decisions, traps, proof),
  `docs/V07_CONTEXT_COMPACTION.md` (v0.6 conversation compaction — the
  investigation, the research and the design),
  `docs/FEATURE_TESTING_CHECKLIST.md`, `docs/E2E_TEST_PLAN.md`, `test-kit/`.
  `CHANGELOG.md` is what USERS see (its own preamble carries the rules for
  writing it); `OPERATIONS.md`, where it exists, is this deployment's own log
  and is never pushed upstream.
  When shipping a release, keep README's version banner + feature list in step
  with this file.

## What it is

- A self-hosted, **centrally-administered** chat portal. An **admin** holds the
  provider API keys (org-level, encrypted at rest) and configures a single
  branded **"[Company] AI Assistant"**; regular **users** get the chat interface
  only (no settings, no model picker). Usage/cost is tracked per request, tagged
  by pipeline role.
- The assistant is backed by **four admin-assigned model roles** (see *Assistant
  pipeline*). Scope is chat plus an internal `escalate` tool and the **file
  tools** (`list_files`/`read_file` — see *File ingestion*; no MCP/RAG). Users
  can upload **any file** (incl. voice recordings); a multi-container ingestion
  pipeline prepares token-efficient content/metadata the model pulls on demand,
  and images go to vision-capable models natively.
- Rich chat **workspace UX** (see *Chat workspace*): a resizable/collapsible
  sidebar, per-chat kebab actions + multi-select, a top-right account menu with
  per-user settings (theme, profile picture, delete-all-chats), **incognito**
  chats, mic recording with a live waveform, a completion chime, scheduled
  follow-up messages, and fade-in streaming.
- Providers: **OpenAI**, **Anthropic** (Console API key only — subscription OAuth
  was removed, see *Provider abstraction*), **Google Gemini**.
- **Version 0.6.2** (2026-09-14 — **installable on a phone**: a per-instance
  web manifest, icons rendered from the admin's logo, and a service worker that
  deliberately caches nothing; see *Chat workspace → Installable on a phone*).
  Before it, **0.6.1** (2026-09-10 — the Sandbox's five-minute cut-off; see the
  `requestTimeout` gotcha in *Conventions*). Same day, **0.6.0** —
  **conversation compaction** + the imported-chat
  ordering fix; see *Conversation compaction*). Before it, **0.5.2**
  (2026-09-07/09: temporary passwords, the login-screen recovery password,
  the operator console's stuck-reset banner). Before that,
  **0.5.1** (2026-09-04 — **memory v2**: four editable notes per
  person, filled in by a pass that reads a chat once it has been quiet for
  30 minutes, plus a search-my-past-chats tool; see *Agentic tools → Memory
  v2* and `docs/V051_MEMORY.md`. Same day as **0.5.0** — **shared chats**:
  several people in one live chat with the assistant; see *Chat workspace →
  Shared chats* and `docs/V05_SHARED_CHATS.md`. Both built and harness-proven
  on the dev box; **deployed only after the owner's own visual test** — owner
  rule for both). Before them, **0.4.1** (0.4.0 was cut on 2026-09-01 but never deployed; 0.4.1,
  2026-09-02, is the first deployed cut of the agent tier and folds in the
  same-day fixes — design graphics, folded steps, live code, image refresh,
  the sign-in sync, failover, the Sandbox admin page) — shown in the
  empty-chat footer, sourced from `package.json`
  via `src/lib/version.ts` (bump `package.json` to update the GUI; it is ALSO
  what the What's new panel stamps and compares against, so `CHANGELOG.md`'s
  top heading must name the same version or the notes never appear). The
  **Sandbox agent tier** shipped in **0.4.0** (2026-09-01, branch `beta`):
  the old one-command sandbox was replaced by a full Claude Agent SDK agent
  per chat — see *Sandbox agent tier* below and `docs/V04_AGENT_TIER.md`.
  Workspace UX
  + paced streaming shipped in **0.1.2**; backup & restore in **0.1.3**;
  per-chat storage pools + the file-ingestion pipeline + native vision in
  **0.2.0**; the whole **agentic tools phase** (web/memory/images/skills/viz/
  sandbox/capabilities + progressive disclosure/curation — see *Agentic
  tools*) plus reply TTS, edit-and-revert, live tool-run feedback, file
  presentation, and interleaved reply timelines in **0.3.0** (cut
  2026-07-20 after the full owner-testing checklist — every item ticked
  except §16 client capabilities, deferred pending a live endpoint);
  production hardening in **0.3.1**; per-instance assistant instructions, the
  weekly report email and the graceful deploy drain in **0.3.2**; clarifying
  questions, the What's new panel, chat titles in browser tabs, the first client
  capability and admin-set tool rounds in **0.3.3**.

## Stack

- Next.js 15 (App Router) + React 19, TypeScript (strict)
- Tailwind CSS v4 (CSS-first `@theme` in `src/app/globals.css`), next-themes
- PostgreSQL + Prisma
- Auth.js v5 (Credentials provider, JWT sessions) — passwords hashed with
  **argon2id** via `@node-rs/argon2` (never bcrypt)
- Provider SDKs: `openai`, `@anthropic-ai/sdk`, `@google/genai` (NOT the
  deprecated `@google/generative-ai`)
- Vitest (unit) + Playwright (E2E)
- pnpm (via corepack), Docker for production
- Windows for local dev, Linux for the Docker production image

## Commands

```bash
pnpm dev            # next dev (http://localhost:3000)
pnpm dev:https      # next dev over HTTPS (needed for mic/secure-context APIs on a LAN)
pnpm build          # production build (see gotcha below — don't run while dev is up)
pnpm typecheck      # tsc --noEmit — use this to verify while dev is running
pnpm test           # vitest (unit)
pnpm e2e            # playwright (needs a DB whose name contains "e2e"; see below)
pnpm db:migrate     # prisma migrate dev
pnpm db:deploy      # prisma migrate deploy (production)
pnpm db:studio      # prisma studio
```

Local services: `docker compose -f docker-compose.dev.yml up -d` (Postgres +
ingestion worker + Gotenberg + sandboxd; add `--profile heavy` for Docling OCR +
Whisper STT + Kokoro TTS).
After changing `worker/`, rebuild with `docker compose -f docker-compose.dev.yml
build worker`.
Copy `.env.example` → `.env` and fill in `AUTH_SECRET` + `OPNINFER_MASTER_KEY`
(`openssl rand -base64 32` each). For local testing, provider keys can be dropped
in `.env` and loaded with `scripts/seed-keys.ts`.

## Architecture

```
src/
  app/
    api/
      auth/[...nextauth]/   Auth.js handler
      chat/                 SSE streaming chat (POST) — the core route
      followups/            POST — front-end model's idle follow-up suggestions
      search/               GET ?q= — full-text search over titles + message bodies
      files/                streamed upload (POST, busboy) + signed download (GET /[id])
      files/status/         GET ?ids= — ingestion status the composer polls
      stt/                  POST — mic dictation → Whisper → transcript for the composer
      tts/                  GET ?messageId= — reply read aloud via Kokoro (segmented MP3)
      memory/               GET list · POST memory-chat turn · DELETE ?id= — the
                            settings-panel "what the assistant knows about you"
      branding/             POST upload (admin) + GET /[name] (PUBLIC) for logo/icons
      avatar/               POST upload (self) + GET /[name] — per-user profile pics (auth-gated)
      conversations/[id]/export/  GET — download a chat as JSON (kebab → Download)
      chat/incognito-cleanup/     POST (sendBeacon) — delete an incognito chat on leave
      chat/interject/       POST — offer a message for MID-TURN injection into a
                            running tool loop (accepted:false → client queues it)
      chat/stream/          GET ?conversationId= — RE-ATTACH to a running turn
                            (replay + live; 204 = nothing to resume)
      chat/stop/            POST — stop the running turn server-side (partial saved)
      chat/answer/          POST — answer a waiting ask_user card, un-pausing the
                            reply parked on it (see Clarifying questions)
      chat/queue/           POST/DELETE — the SERVER-HELD scheduled queue (v0.5):
                            a message sent mid-reply is offered as a steer AND
                            lined up to run when the reply ends; cancel own/any
      chat/live/            GET ?viewing=&client= — the per-tab live feed (SSE):
                            others' messages, "reply started", queue, people,
                            presence, sidebar events (see Shared chats)
      chat/thread/          GET ?conversationId= — the chat as JSON, for a
                            screen to reload itself after an edit elsewhere
      agent-proxy/[...path]/ POST — the Sandbox's credential proxy (org-API-key
                            path): per-run bearer in, real key injected, SSE
                            passed through, REAL usage metered. Bearer-authed
                            by a container — EXCLUDED from the middleware matcher
      pwa/icon/             GET ?size=&maskable= — a home-screen icon rendered
                            from the admin's logo (PUBLIC, and it must be: a
                            browser fetches manifest icons with credentials
                            OMITTED — see the PWA gotcha in *Conventions*)
      admin/usage/          usage ledger CSV export
      admin/usage/series/   GET ?range= — bucketed token series (kept for harness/back-compat)
      admin/usage/summary/  GET ?range= — EVERYTHING the usage dashboard renders, one window
      admin/logs/stream/    SSE — live app-log feed
      admin/backup/         GET /[name] download zip · POST /restore (upload zip)
      admin/import/owui/    POST — OWUI-migration import (upload webui.db; streamed;
                            EXCLUDED from the middleware matcher — body-clone cap)
    manifest.webmanifest/   the installable-app manifest, built per instance
                            from the assistant's name + logo (PUBLIC)
    chat/                   chat workspace (layout = sidebar shell, page, [id])
    admin/                  11 admin-only pages (see Admin)
    console/                the OPERATOR CONSOLE — one read-only overview across
                            EVERY portal on the host (overview · usage ·
                            activity · users · feedback · sandbox · logs).
                            Served by this same image with OPNINFER_MODE=console
                            on its own port; 404s on a portal, and a portal's
                            own routes 404 there (see Operator console)
    login|setup|invite|forgot-password|reset-password/   auth flows
  lib/
    providers/              provider abstraction (one file per provider id)
      types.ts              Provider/ChatRequest/ChatChunk/TokenUsage interfaces
      openai.ts anthropic.ts google.ts   per-provider streamChat + listModels
      reasoning.ts          per-provider reasoning-level option lists (dropdowns)
      errors.ts             isRetryableError — 4xx surface vs 5xx/network failover
      registry.ts index.ts pricing.ts user-models.ts
      credentials.ts model-cache.ts mapping.ts labels.ts
    assistant.ts            assistant config: name+logo + 4 RoleConfig roles
    pipeline.ts             runAssistant (conversation→escalate→failover) + titles/followups
    prefs.ts                usage-stats visibility (everyone | admins | off)
    limits.ts               instance token ceilings (64k out / 128k in by
                            default, Admin→Models) + per-model clamp
    applog.ts emails.ts     DB log event bus (Admin→Logs); branded HTML emails
    alerts.ts               error-alert emails (appLog error → throttled mail)
    dev-log.ts              verbose file firehose → logs/dev.log (dev only)
    version.ts welcome.ts thinking-words.ts   app version + pageTitle(); greetings; gerund words
    pwa.ts                  installable-app metadata, PURE: the manifest shape,
                            the home-screen label rule, the icon URLs (tested)
    changelog.ts            release-notes parsing + the "should this interrupt
                            the user" rules (pure, tested; What's new panel)
    uid.ts                  client-safe UUID (crypto.randomUUID needs a secure context)
    sudo.ts                 admin re-auth grant (Admin→Chats; own password, not
                            the master key; encrypted /admin-scoped cookie)
    crypto.ts hash.ts tokens.ts mailer.ts settings.ts audit.ts auth-helpers.ts
    storage.ts branding.ts db.ts format.ts validation.ts app-url.ts
    backup.ts               full-instance backup/restore (zip: DB JSON + storage) + auto-backup scheduler
    file-tools.ts           file manifest + list_files/read_file (+raw) + vision image loading
    pool-sync.ts            pool↔files-table reconciliation after sandbox/file-tool mutations
    message-files.ts        attachFilesToMessages — re-associate files to their message (pure, tested)
    image-vision.ts         sharp downscaling: vision inlining + image_edit/blend source tiers
    interject.ts            mid-turn steering mailbox (globalThis-anchored; see Chat workspace)
    ask.ts                  ask_user pure core: question/answer types, arg
                            validation, model-facing result text (client-safe)
    ask-mailbox.ts          the WAITING half — a running turn parks on the
                            user's answer (globalThis-anchored, abort-aware)
    memory-chat.ts          settings-panel memory adjustment chat (frontend role, memory tools only)
    memory-topics.ts        memory v2 PURE core (0.5.1): the four notes, the size
                            rule, the block, the idle-pass prompt + parser (tested)
    memory-pass.ts          the idle-chat memory pass + its 5-min scheduler: a
                            chat quiet for 30 min is read ONCE by the front-end
                            role and the notes rewritten (owner: silent, not per reply)
    tools/chat-search.ts    search_my_chats — Postgres full-text over the
                            person's own past chats, dated snippets + links
    feedback.ts             thumbs-rating → message_feedback snapshot + AI "why" analysis
    provenance.ts           LLM-side source notes appended to replayed assistant turns
    tts.ts                  speakableText + splitSpeech segment ramp + ID3 strip (reply TTS)
    tool-run.ts             ToolArgTap (incremental tool-arg JSON) + run tracker + line diff
    owui-import.ts          Open WebUI → OPNinfer migration (webui.db → users/chats/memories)
    reply-timeline.ts       segmentReply — interleaved prose/activity slots (pure, tested)
    file-card.ts            presented-file card titles/categories (pure, tested)
    viz-stream.ts           streaming @@@VIZ marker parser (pure, ordered events)
    turn-stream.ts          resumable turn registry (globalThis): per-conversation
                            event buffer + subscribers; generation runs DETACHED
                            from the HTTP request (leave/refresh → re-attach)
    chat-turn.ts            startChatTurn — ONE assistant turn start to finish
                            (the old inline body of POST /api/chat); the route
                            and the scheduled queue both start turns through it
    thread-order.ts         orderThreadRows — THE order a thread is read in
                            (time, then user before assistant, then id; pure).
                            Every loader uses it — see the tie gotcha
    compaction-core.ts      conversation compaction, PURE: where to cut, how
                            to chunk, the summariser prompt, the replay shape
    compaction.ts           the server half: loadCompaction / compactConversation
                            / the boot sweep (docs/V07_CONTEXT_COMPACTION.md)
    chat-rules.ts           shared chats, PURE: roles, who may do what, the
                            edit rule, memory-off, names (tested, client-safe)
    chat-access.ts          the DB half: chatWhereFor / fileWhereFor /
                            messageWhereFor / chatAccess — every old "is this
                            the owner" check goes through here
    chat-items.ts chat-view.ts   sidebar rows (per-person star/unread) and the
                            whole chat screen, built once for page + reload
    sharing.ts              invite / remove / leave / people + the live events
    live.ts                 the live-feed registry (globalThis): per-tab subs,
                            publishToChat / publishToUsers, presence
    chat-queue.ts           the server-held scheduled-message queue (globalThis)
    tools/                  v0.3 tool registry + all tool modules: registry.ts
                            (registerTool + async buildToolset), types.ts,
                            date-time.ts, tavily.ts web.ts web-helpers.ts,
                            memory.ts, view-image.ts, images.ts, skills.ts,
                            visualize.ts, sandbox.ts, present.ts (present_files),
                            ask.ts (ask_user), disclosure.ts, tool-status.ts,
                            curation.ts
    capabilities/           instance-enabled client tool bundles: types.ts,
                            registry.ts, types.ts, local.ts (THE SEAM: empty
                            here, and where a private deployment names the
                            capabilities it adds — see the note in that file),
                            sandbox-agent.ts (the Sandbox capability: toolsFor()
                            builds `sandbox_task` per turn with live steering)
    agent/                  the Sandbox agent tier (0.4.0 — docs/V04_AGENT_TIER.md):
                            config.ts (pure: schema/bounds/defaults/steering),
                            env.ts (the credential-safety guard — never
                            `...process.env`; throws in API mode without a proxy),
                            wire.ts (attach protocol, pure), spawn.ts
                            (spawnClaudeCodeProcess over sandboxd), bridge.ts
                            (SDK messages → the chat's run-block events, tested
                            against bridge-fixture.ndjson — a RECORDED real
                            session), policy.ts (permissions + prompt, pure),
                            limits.ts/limits-store.ts (plan usage + rate-limit
                            waits), proxy-tokens.ts/proxy-usage.ts (API-key path),
                            mcp.ts (pure: connected services — validation,
                            sign-in state, the exact SDK shape, status labels),
                            mcp-store.ts (cached broker read), broker.ts (GET
                            client for sandboxd's read endpoints)
    tools/sandbox-task.ts   THE tool: one outer call, a whole agent run inside
    usage-math.ts           pure accounting rules (subscription = $0 + notional;
                            averages over billable requests only)
    usage-summary.ts        buildUsageSummary — EVERYTHING the usage dashboard
                            renders, for ONE database, on one bucket grid.
                            Takes its Prisma client as an argument, so the
                            console runs it against every portal and merges
    mode.ts                 IS_CONSOLE — portal or operator console. Env-only
                            and import-free: MIDDLEWARE imports it
    console/                the operator console's read layer (docs/V06_CONSOLE.md):
                            operators.ts (email:argon2 accounts from the env
                            file, pure) + auth.ts (verify) + guard.ts (API gate),
                            instances.ts (which portals, from env, pure),
                            db.ts (a Prisma client per portal + fanOut — never
                            rejects; a portal that is down is an error ROW),
                            overview.ts people.ts feedback.ts logs.ts sandbox.ts
                            activity.ts usage.ts (the per-page reads),
                            merge.ts (summing portals, pure + tested),
                            labels.ts (status lines → countable buckets, pure)
    login-guard.ts          failed-sign-in backoff (in-process; per-account)
  components/
    chat/                   chat-shell, sidebar + sidebar-resize (useSidebarPrefs),
                            user-menu, user-settings-modal, avatar, mic-recorder,
                            chime, chat-window, message-bubble, search-modal,
                            file-chip, conversations-store, follow-ups,
                            generated-image, generated-files, tool-run, viz-frame,
                            ask-card (the clarifying-question card),
                            whats-new (the release-notes panel),
                            compaction-divider (the "earlier messages
                            summarised" line, shared with the admin viewer)
    admin/                  admin-shell (resizable nav), admin-nav, page-header,
                            user-table, invite-manager, backup-config-form,
                            backup-manager, usage-dashboard, usage-line-chart,
                            usage-cost-chart, tools-forms, live-logs, smtp-form,
                            branding-form, model-roles-form, assistant-identity-form,
                            usage-visibility-form, upload-limit-form,
                            sudo-gate, chat-transcript, ui.tsx
    console/                console-shell (its own nav — NOT AdminShell, which
                            needs a portal database), overview-view, portal-spend,
                            people-table, logs-view, ui.tsx
    pwa-register.tsx        registers public/sw.js (secure context only, like
                            the mic — undefined over a plain-http LAN address)
    settings/ ui/ + auth-card.tsx branding.tsx logo.tsx theme-toggle.tsx
  auth.ts auth.config.ts middleware.ts
  instrumentation.ts        server-startup hook (register) — delegates to instrumentation-node
  instrumentation-node.ts   Node-only boot: crash guards + auto-backup scheduler start
prisma/schema.prisma        data model + migrations
CHANGELOG.md                release notes, shown in-app by the What's new panel
                            (MUST be COPYed in the Dockerfile — see gotchas)
scripts/                    manual live-test + seed harnesses (NOT in the test
                            suite; the ones named in this file are the load-bearing
                            regressions, not an exhaustive list)
deploy.sh                   production init/update for ALL instances on the host
                            (docker auto-install, instance wizard, shared engines)
docker-compose.yml          ONE instance stack (db/migrate/app/worker/sandboxd)
docker-compose.engines.yml  SHARED engines stack (gotenberg/docling/whisper/kokoro)
docker-compose.console.yml  the OPERATOR CONSOLE (the same app image, mode=console)
worker/                     Python ingestion worker (own container — see File ingestion)
  Dockerfile requirements.txt
  app/main.py               claim loop (SKIP LOCKED) → detect → dispatch → artifact
  app/detect.py             magic-byte + extension routing (the five-group map)
  app/handlers/             markitdown_ · passthrough · metadata (incl. images) ·
                            spreadsheet · database · video · gotenberg_ · docling ·
                            whisper_
sandboxd/                   sandbox broker ("guard hut" — the ONLY Docker-socket
                            holder; see Agentic tools): index.mjs + Dockerfile
docker/sandbox/Dockerfile   fat sandbox toolchain image (opninfer-sandbox)
docker/agent/Dockerfile     opninfer-agent: Claude Code PINNED on top of it — the
                            ARG must equal the SDK's bundled CLI version
                            (src/lib/agent/version-pin.test.ts reads both)
public/sw.js                the service worker. CACHES NOTHING, on purpose —
                            an offline fallback page and nothing else, which is
                            also what makes Chrome offer to install the app
skills/                     SKILL.md playbooks (anthropics/skills format) + assets:
                            email-drafting · meeting-notes · visualize
```

### Assistant pipeline (`src/lib/assistant.ts` + `src/lib/pipeline.ts`)

The assistant config is one `settings` row (`assistant_config`): a name, an
optional logo, the admin's **standing instructions** (`systemPrompt` — Admin →
Customise), and four `RoleConfig`s — each = (org credential id, provider,
model id, `reasoning`; the **conversation** role also has `reasoningExtended`).

- **frontend** — cheap model: generates the emoji conversation title (2–5 words)
  and the 3 idle follow-up suggestions.
- **conversation** — the workhorse the user talks to (**required** to go live).
- **escalation** — heavyweight; the conversation model is given an `escalate`
  tool and hands off when it's stuck.
- **failover** — ideally a different provider; used when the conversation model
  hits a **transient** error before producing text.

**The standing system block** (`buildAssistantSystemBlock`, pure + tested) is
the FIRST message of every user-facing turn: one always-present identity line
("You are <name>, the AI assistant for this organisation's private portal")
plus the admin's instructions. The chat route injects it ahead of
memory/files/viz/tools, and because escalation and failover replay the same
`messages` array, both inherit it — while the front-end role (titles,
follow-ups) builds its own prompts and never sees it. `runAssistant` therefore
splices ESCALATE_SYSTEM *after* the caller's leading system blocks, so identity
opens the prompt rather than internal plumbing. Regression:
`scripts/test-system-prompt.ts` (11 checks against a real model, including
reading back the prompt that was actually sent, from dev.log).

`runAssistant` streams the conversation model (offered the `escalate` tool when
an escalation model is configured). On `tool_call` it suppresses the partial
answer and hands off to escalation; on a **retryable** error (5xx / network /
429 — see `providers/errors.ts`) it fails over; a **4xx** (bad params, auth,
model) is surfaced to the user + logged, NOT masked by failover. Usage is
recorded for every role that ran (no token skipped, even on an escalated turn).

**Reasoning** is provider-native and admin-picked from a dropdown
(`providers/reasoning.ts`), never free text or client-trusted:
- OpenAI → `reasoning_effort` (none/minimal/low/medium/high/xhigh).
- Anthropic → adaptive thinking (`thinking.type:"adaptive"`, `display:"summarized"`)
  + `output_config.effort` (low/medium/high/xhigh/max), or "off". `budget_tokens`
  is deprecated. When thinking is on, `max_tokens` is raised (thinking counts
  against it).
- Google → `thinking_level` on Gemini 3.x (minimal/low/medium/high); off → budget 0;
  numeric → `thinkingBudget`.

The **conversation** role can carry two levels — a quick default (`reasoning`)
and an extended one (`reasoningExtended`). When the extended level is set, the
chat composer shows a **"Think" toggle**; the browser sends only a boolean and
the chat route picks the level server-side, so users are capped to exactly the
two admin-chosen levels. Anthropic & Google stream a live thinking summary;
OpenAI Chat Completions does not. The UI shows a Claude-Code-style animated
status (spinning sparkle + a shimmering random gerund) instead of a thinking
panel.

### Conversation compaction (0.6.0, 2026-09-10) — `src/lib/compaction-core.ts` + `compaction.ts`

Owner ask, after one production chat cost **US$41.86 in 72 messages**: "a real
fix … a retroactive fix for all conversations that are over a limit …
compaction … between 96–128k tokens … a GUI option to change the ranges …
use the front end model for it." The investigation, the research and the
design record are in **`docs/V07_CONTEXT_COMPACTION.md`**; the facts that
matter here:

- **Nothing shortened a conversation before this.** The "context curation"
  in `tools/curation.ts` trims large TOOL RESULTS only (`role === "tool"`)
  and only runs between tool rounds; replayed history never contains a tool
  row (`toChatMessages` replays user/assistant/system), so a prose chat never
  reached even its estimate. Zero `curator` usage rows ever existed on any
  portal, and `maxInputTokens` was only that curation's trigger, never a cap:
  a 633-message imported chat was re-sent whole — 525k tokens — on every
  message.
- **What it does now.** At the start of a turn, once the replayed history
  reaches `compactAtTokens`, everything but the most recent
  `compactKeepTokens` worth of WHOLE turns (a reply never loses its question)
  is summarised by the front-end role into ONE rolling summary (the previous
  summary rides in as "summary so far"; a later compaction rewrites it), read
  in chunks of ≤48k tokens so any model's window and any single giant message
  (1.78 MB ones exist in production) work. The reply model is sent the summary as one
  user message + a short assistant acknowledgement (Anthropic's own
  recommended client-side shape; roles keep alternating on every provider),
  then the kept rows verbatim. The user sees a phase line ("Summarising
  earlier messages…"); a failure is a WARN row and the full history goes —
  tidying never blocks a reply. Billed as usage role **`compaction`** on the
  front-end model (~$0.03 a time at gpt-5.6-luna rates), charged to the
  sender (the owner for the sweep). Chosen over Anthropic's server-side
  compaction beta because it is provider-agnostic, retroactive, admin-tunable
  and summarised by the cheap model; over truncation because that chat IS
  its email template — section 3 of the prompt keeps reusable content
  verbatim, and the harness proves five facts planted in the summarised part
  are still recalled.
- **Storage and the ONE invalidation rule.** `conversation_compactions`
  (migration `20260910140000`; cascades with the chat; in the backup table
  list) holds `summary`, `boundaryMessageId` = the LAST message the summary
  covers, before/after token counts, model. `messages` is never changed. The
  newest row is used IF its boundary message still exists; an edit/revert
  from before the boundary deletes that row, so the compaction is void and
  the full history is sent until the next turn re-compacts. Retry only
  deletes the trailing reply, so it survives. No other bookkeeping exists.
- **The retroactive fix is the deploy.** `startCompactionSweep()`
  (`instrumentation-node.ts`, portal mode only, 90 s after boot) compacts
  every chat over the trigger — newest activity first, never a chat with a
  live turn (the turn will do it), never incognito, ≤50 per boot — writing
  only to its own table, so no `updated_at` moves (the memory-pass lesson).
  Logged as `chat` / "Conversation compacted" per chat and "Compaction sweep
  finished" once. A live turn and the sweep share an in-flight map, so a
  chat is never compacted twice at once.
- **What the user sees.** Every message stays on screen; `CompactionDivider`
  ("Earlier messages summarised for the assistant") is drawn after the
  boundary message, on the chat page (from `ChatThread.compactedThroughId`,
  updated live by the `compacted` SSE event and on thread reload) and in the
  admin viewer, which also shows the summary itself in a `<details>` — a
  support reader needs to know what the model could and could not see.
- **Also found and fixed on the way — the thing that made that chat cost
  $2 a message rather than $0.20 (see the tie gotcha in *Conventions*):**
  imported chats replayed in a DIFFERENT order every turn, so the prompt
  cache never matched. `thread-order.ts` fixes the order everywhere; the
  importer no longer writes ties; migration `20260910120000` nudges existing
  tied rows apart by a millisecond, user first.
- **Two things measured, not assumed** (`scripts/_probe-cache.ts`, session
  scratch, ~$1.50): prompt caching works through our mapping (full hit on
  the next turn at 76k AND at 267k — the >200k path is fine, and Anthropic
  no longer doubles prices above 200k); and the **Think toggle invalidates
  the whole cache on Sonnet 5**, system prompt included (Anthropic renders the
  thinking config ahead of it) — each switch is one full re-write, ≤$0.36
  after compaction, noted and left alone. A probe that used random word
  salad as filler got `stop_reason: refusal`, zero output and no cache entry
  from every call — realistic prose is required for a caching experiment to
  mean anything.
- **Proof:** `compaction-core.test.ts` (14), `thread-order.test.ts` (8),
  `limits.test.ts`, `backup.test.ts` (the table is in the list), and the live
  `scripts/test-compaction.ts` (see *Status* for the count) — real front-end
  and conversation models, its own dev server, the trigger lowered to
  30k/6k for the run.

### Chat workspace (UX layer)

The chat shell (`components/chat/chat-shell.tsx`) wraps a **resizable + collapsible
sidebar** and a slim **top bar**. Sidebar width + collapsed state are persisted in
`localStorage` via `useSidebarPrefs` (`sidebar-resize.tsx`); the **admin shell**
(`components/admin/admin-shell.tsx`) reads the SAME keys, so both panels always
match. Collapsed → an icon rail (logo, new chat, search, admin, avatar).

- **Sidebar** (`sidebar.tsx`): nav icons animate on hover (`.group:hover .oi-icon-*`
  keyframes in `globals.css`); Admin sits under Search (admins only, a sliders
  "control panel" icon — kept visually distinct from the personal settings gear
  in the top-right account menu).
  Each chat has a **kebab menu** (Star, Rename, **Rename with AI**, Download JSON,
  Select, Delete). **Select** enters multi-select with a bulk-delete bar. Optimistic
  updates go through `conversations-store` (`patch`/`remove`); server actions live in
  `app/actions/conversations.ts` (`deleteConversations`, `deleteAllMyChats`,
  `renameConversationWithAI`).
- **Top-right account menu** (`user-menu.tsx`): a settings gear opens the per-user
  **settings modal** (`user-settings-modal.tsx` — light/dark, profile-picture
  upload via `/api/avatar`, **assistant memory**, **delete all my chats**) and
  the avatar drops down to **Sign out**. The **memory section** shows every
  saved memory (hover × to forget one) plus a mini **adjustment chat** — one
  bounded turn of the FRONTEND role scoped to exactly the four memory tools
  (`src/lib/memory-chat.ts` → `/api/memory`; the fresh list rides back on the
  same response). Note: `runMemoryChat` deliberately passes NO `reasoning` —
  OpenAI 400s on tools+reasoning_effort for nano models on chat completions.
  Live regression: `scripts/test-memory-settings.ts` (13 checks).
- **Incognito** (§10): the top-bar button opens `/chat?incognito=1`. The created
  conversation is flagged `incognito` (hidden from the sidebar) and **auto-deleted**
  when the user leaves (unmount) or closes the tab (`pagehide` → `sendBeacon` →
  `/api/chat/incognito-cleanup`). Billing/audit logs survive, like any delete.
- **Voice / dictation** (§6): `mic-recorder.tsx` captures audio (MediaRecorder +
  a live AnalyserNode waveform); on stop the blob goes to **`POST /api/stt`**,
  which forwards to the Whisper container (`WHISPER_URL`; `heavy` profile) and
  the transcript lands in the composer input. If STT is off/unreachable the
  recording falls back to a normal stored attachment (which the ingestion
  worker then transcribes asynchronously). **Requires a secure context** (see
  gotchas). In dev, whisper publishes `127.0.0.1:9000` so the host app can
  reach it (`WHISPER_URL=http://localhost:9000` in `.env`).
- **Scheduled messages** (§14) + **mid-turn steering**: submitting while a
  reply streams queues the message (`queuedRef`) AND offers it to
  `POST /api/chat/interject` (no attachments only). If the assistant is mid
  TOOL LOOP, the pipeline **injects it between rounds** as a real, persisted
  user turn (`src/lib/interject.ts` in-memory mailbox — single-instance by
  design; `applyInterjections` in both loops; carried into escalation
  hand-offs) and streams an `interjected` SSE event — the UI moves the bubble
  above the streaming reply and drops the queued fallback. Plain prose replies
  have no seam: the offer is dropped at stream end and the queue auto-sends as
  today. The composer chip shows which path the message took — "Steering the
  task:" once the offer is accepted vs "Scheduled:" (owner testing gotcha:
  typing during the PACED REVEAL is already after the turn ended server-side —
  it sends as a normal new turn). While streaming, the action button is STOP
  only when the input is EMPTY — with text typed it becomes SEND (submits the
  queue/steer path; clicking must never abort the running reply). GOTCHA: the
  mailbox Map MUST be anchored on `globalThis` — Next instantiates modules per
  route bundle, so the chat route and interject route otherwise get separate
  maps and every offer is refused (same reason db.ts globals Prisma; found
  live). Regressions: `scripts/test-interject.ts` (12 checks, API-level) +
  `scripts/test-interject-ui.ts` (12 checks — REAL browser: type mid-run,
  button swap, chip flip, bubble, single steered reply).
- **Resumable streams** (`src/lib/turn-stream.ts`): generation is DETACHED
  from the HTTP request — the turn publishes every SSE event into a
  globalThis-anchored per-conversation buffer and the response merely
  subscribes, so leaving the page (other chat, refresh, tab close) only
  detaches and the reply runs to completion. Re-entering the chat re-attaches
  via `GET /api/chat/stream` (replays the missed events — a fast paced
  wash-in — then follows live); a finished turn stays resumable for a 45s
  grace window (`done` dedupes against the loaded row by messageId). One turn
  per conversation (duplicate POST → 409). STOP is now server-side
  (`POST /api/chat/stop` aborts the TURN's AbortController; partial reply
  saved) — aborting the fetch would merely detach. Delete paths
  (incognito-cleanup, deleteConversations) abort live turns first; a
  15-min hard-stop backstop means a hung provider can't hold a conversation
  "active" (which would 409 every later message). Regressions:
  `turn-stream.test.ts` (10) + `scripts/test-stream-resume.ts` (17, API) +
  `test-stream-resume-ui.ts` (11 — real browser: leave mid-reply, return,
  content still growing, refresh mid-stream, one bubble, no dupes).
- **Clarifying questions** (`ask_user`, 2026-08-17 owner ask — modelled on
  Claude Code's own question card): at a genuine fork in a request the
  assistant raises a multiple-choice card and **its reply PAUSES mid-flow**
  until the answer arrives, then continues in the SAME turn. One call carries
  up to 4 questions and the card steps through them ("1 of 3"), submitting the
  whole set at the end — the reply resumes once, not once per question. Each
  question offers 2–4 options plus a typed "Something else" and Skip; the
  composer stays live underneath for "Or reply directly…", which answers
  whichever question is showing and skips the rest.
  Three owner decisions: it **blocks** (the model keeps its half-built train of
  thought instead of paying for a second turn), the card sits **above the
  composer** (can't be scrolled away from), and the answer becomes **the user's
  own message** — that last one is load-bearing, not cosmetic: only
  user/assistant rows are replayed by `toChatMessages`, so without it the
  assistant forgets its own question's answer on the very next message (the
  same class of bug as it disowning its web-sourced replies).
  Shape: `src/lib/ask.ts` is the pure core (arg validation, answer
  normalisation, model-facing result text) and `ask-mailbox.ts` is the waiting
  half — a globalThis-anchored request/RESPONSE sibling of `interject.ts` (that
  one is fire-and-forget; this one holds a promise open). `tools/ask.ts`
  registers the pending ask, raises the card through `ToolCtx.emitEvent`, then
  awaits; the pipeline's `streamingExecute` (generalised out of the sandbox
  run-block bridge — same "emit while running, result at the end" need) carries
  the card up as an `ask` chunk and the settlement back as `ask_done`.
  **The wait MUST honour the turn's abort signal** (`ToolCtx.signal`, threaded
  from `turn.abort` in the chat route): Stop aborts the provider call, but this
  is an ordinary promise that knows nothing about it, so without the signal a
  stopped turn sat on an unanswerable card for the full 5-minute timeout —
  and every later message in that conversation would 409. The 5-minute cap is
  deliberately well under the 15-min per-turn hard stop, so an ignored card
  still produces a default-driven answer rather than a dead stream.
  Persistence mirrors `meta.toolRuns`: the card lands in `meta.asks` and is
  positioned in `meta.activity`, so a reload shows what was asked beside the
  answer given (a card the turn died on reads as dismissed). Its own `ask`
  tool group → Admin → Tools can switch it off; deliberately NOT deferred
  (`disclosure.ts`) since the model must reach for it the instant it's unsure.
  Ordering (fixed 2026-08-21): like an interjection, the answer row is created
  mid-turn while the reply saves at the end, so it sorts ABOVE the reply that
  used it — which put the user's answer above the question that prompted it.
  The fix is NOT to fiddle with timestamps but to stop drawing that bubble at
  all: the card already shows the chosen answer inline, in the position it was
  asked, so a separate bubble is redundant as well as misplaced. The row is
  marked **`meta.askAnswer = true`** when the answer route creates it and is
  hidden in BOTH render paths — `buildChatThread` filters it out of the loaded
  thread (so the user's page and the admin viewer agree), and the `ask_answer`
  branch in `chat-window.tsx` no longer splices a bubble, though it MUST still
  clear `queuedRef`/`setQueued` or the queued-message fallback fires and sends
  the answer again as a fresh turn. **The row itself must keep existing**:
  `toChatMessages` replays only user/assistant rows, so without it the
  assistant forgets its own question's answer on the very next message — the
  same class of bug as it disowning its web-sourced replies. Covered by
  `chat-thread.test.ts` (4) and three checks in `scripts/test-ask-user.ts`
  (the row is present and flagged; no bubble live; still none after reload).
  Steering matters here more than usual — the tool description explicitly
  forbids using it to ask permission, since the MORE TOOLS directory already
  says never ask before acting and a question tool is exactly the loophole that
  would leak through. Tests: `ask.test.ts` (23) + `ask-mailbox.test.ts` (11) +
  `scripts/test-ask-user.ts` (42 live browser checks against a real model:
  card appears, reply provably parked with no row saved, the card survives a
  MID-QUESTION reload and is still answerable, answering resumes ONE reply that
  honours the choice, the 1-of-3 stepper advances, a typed answer is recorded as
  free text, reload persistence, a LATER turn still knows the answer, and Stop
  retires a waiting card in ~150ms leaving the conversation able to accept a new
  turn). Harness-writing note: an early version asserted the chosen branch by
  looking for the word "haiku" in the reply and failed on a perfectly correct
  haiku that never used it — the prompt now asks for the form in square
  brackets, so the check is a fact about which branch ran rather than a guess
  from the output's shape.
- **What's new panel** (2026-08-21): release notes live in **`CHANGELOG.md`** at
  the repo root and pop over the chat once per person after an update.
  `src/lib/changelog.ts` is the pure core — `parseChangelog` (`## <version> —
  <date>` headings; a heading with no parsable version, e.g. `## Unreleased`,
  is ignored so work in progress can sit in the file), `compareVersions`,
  `releasesSince`, `shouldShowWhatsNew` — so the "should this interrupt the
  user" rules are unit-tested rather than trusted. Two of those rules matter:
  a release NEWER than the running app is never shown (notes are written
  before the deploy that ships them), and a user with no stamp at all gets
  ONLY the latest release, not the whole history.
  `src/app/actions/changelog.ts` reads the file from `process.cwd()`, caches
  the parse in memory (re-read only when the file's mtime/size changes, so a
  dev edit needs no restart), and stamps dismissal with the **server's**
  `APP_VERSION` — never a client-supplied value, or a browser could claim to
  have seen a version that doesn't exist and suppress the next real release.
  State is the nullable **`users.lastSeenVersion`** column, deliberately not
  browser storage: reading the notes on a laptop must not re-show them on a
  phone, and NULL = "never seen", so every existing account gets the panel
  once — which is how people discover it. `components/chat/whats-new.tsx`
  mounts ONCE in the chat shell (so it survives navigation and can't pop
  twice), is marked seen on **dismissal, not display** (closing the tab unread
  means you see it next time), and is reopened from the account menu via a
  `window` CustomEvent (`WHATS_NEW_EVENT`) so the menu needs none of this
  logic — a hand-opened panel shows the full history and does NOT re-stamp.
  **Writing the notes (owner rules, 2026-08-22 — the file's own preamble
  repeats them):** they are read by CLIENTS, so keep them SHORT and plain, one
  line per item in the words a user would use, with no internals (no tool,
  model or file names, no mechanism). And **never mention a client-specific
  capability** — CHANGELOG.md ships inside the SHARED app image, so a feature
  built for one client would appear on every other client's screen. The first
  cut of 0.3.3 broke both rules (it announced one client's bespoke search to
  everyone, in implementation detail) and was rewritten. **And nothing
  admin-only** (owner rule, 2026-09-02): the first cut of 0.4.0 listed the
  Sandbox admin card and the subscription cost reporting — every USER sees
  the panel, and admin settings read as noise or as things they can't find. If a per-client note
  is ever genuinely wanted, it needs a per-instance mechanism — not a line in
  this file.
  **And ONE LINE for everything behind the scenes** (owner rule, 2026-09-07,
  after 0.5.2's notes itemised the audit): only what a user can SEE AND USE
  earns a line — hardening, bug fixes, performance and infrastructure all
  collapse into *"General security, feature and UX updates."* Three reasons,
  and they are the owner's: a list of fixes reads as "this was unreliable",
  which is not what anyone wants to learn about a tool they depend on; a list
  of security work tells every reader where the locks are; and no user needs
  to know which feature was broken. Note what this costs — 0.5.2's genuinely
  user-facing "change your password in Settings" went too, because a password
  is a security thing; if a change like that is ever worth keeping, it is
  worth ASKING rather than assuming, since the rule is deliberately blunt.
  Tests: `changelog.test.ts` (18, incl. the Dockerfile COPY assertion — see
  gotchas) + `scripts/test-whats-new.ts` (15 live browser checks, no provider
  keys needed).
- **Chat titles in browser tabs** (2026-08-21): the root layout already defines
  the `"%s · OPNinfer"` template, so only the conversation's own half was
  missing, and THREE paths keep it current: `generateMetadata` on
  `chat/[id]/page.tsx` (navigation + reload — it re-checks OWNERSHIP rather
  than trusting the id in the URL, because generateMetadata runs independently
  of the page and a title is small but still someone else's, and returns `{}`
  on any failure so a tab title can never break the page); the `title` SSE
  handler in `chat-window.tsx` (a brand-new chat renames its tab the moment
  the front-end model titles it, instead of sitting as the bare app name until
  the next page load — skipped for incognito, same reasoning as keeping it out
  of the sidebar); and the conversations store's `patch()`, matched against
  `usePathname()`, which covers manual rename AND rename-with-AI in one place
  rather than at each call site. `pageTitle()` in `lib/version.ts` is the one
  place that knows the separator. Covered by `scripts/test-whats-new.ts`.
- **Folded working steps + positioned deliverables** (2026-09-02, owner
  feedback on the first Sandbox design run). Two changes to the reply
  timeline, both in `ReplyTimeline` (`message-bubble.tsx`):
  (1) **Images and files render WHERE they were presented.** `meta.activity`
  gained `{kind:"image", id}` / `{kind:"files", ids}` items with the usual
  `at` offset — the route logs one on `image_start` (re-keyed from the start
  id to the FILE id on `image_done`, since a reload joins by file id) and on
  the `files` send, and stamps `at` on both SSE events; the loader
  (`chat-thread.ts`) rebuilds them; `ToolActivity` renders them inline
  (`data-activity="image"|"files"`). Images/files with no timeline item —
  rows from before this change — keep the old above/below placement
  (`looseImages`/`looseFiles`).
  (2) **The working steps fold once the reply is finished.** While
  streaming everything shows (that is the point of it); when `streaming`
  flips off, status lines, run blocks, question records and any narration
  between them collapse into one "Worked through N steps" row
  (`data-activity-collapsed`, click to expand, `data-activity-expanded` to
  fold again); deliverables and the FINAL prose slot stay visible, in
  order. A loaded reply starts folded. Nothing new is persisted — it is a
  render-time fold of the same activity log, so the admin chat viewer gets
  it for free. Live proof `scripts/test-agent-run-ux.ts` (13 checks, one
  real Sandbox job with a MutationObserver planted before the turn: the
  code preview grows LIVE and over seconds — 12 updates in 2.3s, 8 in 8.2s
  — activity expanded mid-run, folded after with `collapsed › image ›
  prose`, expand shows the runs with the image at the present point,
  reload the same). The owner's "code arrives all at once" report was
  checked by that same probe and NOT reproduced on this box; if it recurs,
  Docker Desktop's port relay coalescing the broker stream (see the TTS
  note) is the first suspect — production has no relay.
- **Presented-file cards look like Claude.ai's** (2026-09-02, owner ask,
  screenshot-driven): `generated-files.tsx` renders each presented non-image
  file as a row with a coloured type tile (gradient + icon per category), a
  HUMANISED title ("pr-property-email-signature.html" → "Pr property email
  signature"), a "Kind · EXT" line, a split Download button whose caret opens
  Download / Open in new tab / View contents (+ the real filename), and a
  "Download all" for several; a staggered entrance (`.oi-file-in`) and a hover
  lift (`.oi-file-card`). Images stay INLINE (owner: "still show images
  themselves"). `src/lib/file-card.ts` is the pure core (title + category +
  subtitle; `file-card.test.ts`). Two things learned: the entrance animation
  must be `fill-mode: backwards`, not `both` — a transform left on every card
  gives each its own stacking layer and the open menu painted BEHIND the next
  card (the open card also gets `relative z-30`); and harnesses read the
  filename from `data-file-card`, not the visible title, since the title is
  no longer the filename. `scripts/shot-file-cards.ts` seeds a reply with
  five files and screenshots the bubble light/dark (+ menu, + a hover frame)
  for eyeballing. Second pass (owner feedback): cards a touch shorter, a
  subtle left-to-right wash of the tile colour across the card (`TINT`,
  `from-<colour>/10`), and instead of the tile scaling, each icon has its
  OWN hover animation (`oi-fc-*` sub-elements in `CategoryIcon`, keyframes
  in globals.css): the archive lid lifts, braces/brackets move apart, the
  document's lines wipe out and back, the grid draws in, notes bounce, the
  play button nudges, the globe turns. Sub-elements need
  `transform-box: fill-box` or SVG transforms pivot on the page origin.
- **Shared chats** (v0.5, 2026-09-04 — owner ask: "share a chat with another
  user, a joint session with the AI, everyone sees the output live, everyone
  can schedule, the creator keeps delete"; full spec + the sixteen confirmed
  decisions in `docs/V05_SHARED_CHATS.md`). The load-bearing facts:
  **Model.** One owner (`conversations.user_id`, unchanged) + member rows
  (owner included once shared). ONE access rule — `chat-rules.ts` (pure) +
  `chat-access.ts` (Prisma fragments) — replaced ~40 `where: {id, userId}`
  checks; the trap was FILES, which followed the UPLOADER (`files.user_id`)
  rather than the chat, so a colleague's attachment (or what the assistant
  made during their turn) 404'd for everyone else; they follow the chat now.
  **Live.** One SSE per tab (`GET /api/chat/live?viewing=`, `live.ts`
  registry, `live-provider.tsx` on the client): another person's message,
  `turn_started` (the tab then attaches to the SAME turn-stream buffer every
  other tab reads — "everyone sees the reply at the same moment" is literally
  one buffer fanned out), the queue, people, presence, and sidebar events
  (`chat_added` with a toast, `chat_item`, `chat_removed`, `chat_deleted`,
  `title`, `activity` → bump + unread). The sending tab passes `X-OI-Client`
  so its own echoes are skipped. `thread_changed` (edit/retry elsewhere)
  and a reconnect make the screen reload itself from `GET /api/chat/thread`.
  **Queue.** The scheduled message moved SERVER-SIDE (`chat-queue.ts`,
  `POST/DELETE /api/chat/queue`): offered to the running turn as a steer
  (mailbox entries now carry `{id, userId}` so the spliced bubble is the
  right person's and the queue drops its copy on consumption) and otherwise
  run in arrival order when the turn ends, each as its author, from
  `chat-turn.ts`'s finally (`runNextQueued`) — so `POST /api/chat`'s body
  became `startChatTurn()` in `src/lib/chat-turn.ts`, which the route and
  the queue both call. Solo chats got the same queue, so a scheduled message
  now survives a refresh. **Rules.** Owner: invite/remove/delete; member:
  leave; everyone: send/attach/answer/steer/schedule/rename/retry/rate/
  export; edit only your OWN message and only while nobody else wrote after
  it (`canEditMessage`, enforced server-side → 403). Memory is OFF while
  shared (`memoryAllowed`); usage is charged to the sender of each turn; the
  model gets a "SHARED chat, this message is from X" system line. Ratings are
  per person; the ask card records `answeredBy` (server → `ask_done.by` →
  the client's handler — the first cut forgot the client side and the
  harness caught it). **UI.** Sidebar "Shared" section (owner decision:
  separate, both directions) with the owner's avatar on chats shared WITH
  you, an unread dot, a member kebab that says Leave; the top-bar
  People/Share button (`chat-shell.tsx`) opens `people-panel.tsx` (list,
  online dots, add by name/email — direct, no accept step — remove, leave);
  author label = first name + avatar over every human bubble (own included)
  once shared; removed/deleted → an in-place "no longer have access" card.
  Admin → Chats lists "shared with N" and the viewer labels authors.
  **Proof:** `scripts/test-shared-chat.ts` — 50 checks, two real users in two
  browser sessions against a real model (share → live sidebar + toast → live
  bubbles with names → identical streamed reply on both screens → two
  scheduled messages from two people run in order, attributed and charged →
  a member's file read by the model and downloadable by the owner → the
  question card answered by the other person with "Answered by" → 👍/👎 per
  person → 403 on editing another's message, Leave-not-Delete, live rename,
  search, export with authors → unread dot set and cleared → remove bounces
  the member, every route 404s, the chat is private again, the file stays →
  re-share, delete bounces everyone). Unit: `chat-rules.test.ts` (10),
  `live.test.ts` (3), `chat-queue.test.ts` (4), `interject.test.ts` (5).
  Two traps found live: (1) the conversations store re-synced from the
  server list on every `pathname` change, which wiped the optimistic row a
  brand-new chat had just added (and the People button with it) — the
  "chat on screen is never unread" override reads the pathname through a
  ref instead; (2) the layout's sidebar query runs in parallel with the page,
  before the live feed connects and marks the chat read, so the server row
  can say "unread" for the very chat on screen — the store and the provider
  both force `unread:false` for the viewed chat.
- **Installable on a phone (PWA)** (0.6.2, 2026-09-14 — owner ask: "is PWA
  set up… does it provide a good mobile experience?"). It was not: no manifest,
  no service worker, no home-screen icon of any size, so a phone got a
  responsive *website* that always opened in browser chrome. Now it installs.
  **The manifest is a ROUTE, not a file** (`src/app/manifest.webmanifest`),
  because one image serves four differently-branded portals — a committed
  `public/manifest.json` would put "OPNinfer" on a client's home screen beside
  their own apps, which is the CHANGELOG rule ("never another client's brand")
  except permanent and on the phone. It carries the ASSISTANT's name
  (`shortAppName` drops whole words to fit the dozen characters a launcher
  shows: "Acme AI Assistant" → "Acme AI", never a mid-word ellipsis), and
  `display: standalone`, `start_url: /chat`, a stable `id` so a later rename
  is not a second app.
  **Icons are rendered, not committed** (`/api/pwa/icon?size=&maskable=&v=`),
  from the admin's uploaded logo with the default mark as the fallback — the
  same fallback the rest of the app makes. sharp fits the art onto an opaque
  tile; the maskable copy is inset 10% because Android crops to the launcher's
  shape, and iOS composites transparency onto BLACK, so nothing is left
  transparent. `size` is an allowlist (180/192/512), or the route is an
  arbitrary image resizer; the manifest and the route read that list from the
  same constant, so the manifest can never advertise a size the route refuses.
  `v` is the logo's filename, which changes on upload, so a new logo is not
  stuck behind a year-long cache.
  **All three assets are PUBLIC** — the sharpest trap here, see *Conventions*.
  **The service worker caches NOTHING** (`public/sw.js`). Every page is behind
  auth and rendered per request, so a cached document is one person's chat in
  another person's browser on a shared phone — and a worker outlives the
  session that installed it. There is also nothing worth caching: the app is a
  client for a server it cannot work without. Its whole job is to answer a
  failed NAVIGATION with a self-contained offline page (inline in the worker,
  so there is no precache to fail and nothing branded captured from a portal
  the device later leaves), which is also the fetch handler Chrome wants before
  it will offer Install. Non-GET, cross-origin, `/api/*` (the SSE stream,
  uploads, downloads) and Next's own RSC fetches are passed through untouched.
  **To remove it from devices already carrying it**, deploy a worker whose
  activate handler calls `self.registration.unregister()`; deleting the file
  does nothing, since the browser keeps the last copy it fetched.
  **Standalone fills the screen**, so `viewport-fit=cover` plus `.oi-safe-b`
  (`max(1rem, env(safe-area-inset-bottom))`) keeps the composer off the iOS
  home indicator; the inset is 0 everywhere else, so nothing changes off a
  notched phone. `statusBarStyle: "default"` leaves iOS drawing the status bar
  above the page, so the top inset needs no handling.
  Proof: `pwa.test.ts` (25 — the pure rules, plus source pins for every part
  with no runtime symptom: the middleware exclusions, the force-dynamic
  manifest, the Dockerfile's `public/` COPY, and that the worker never opens a
  cache, never touches `/api/`, and answers navigations only) and
  `scripts/test-pwa.ts` (32 live browser checks on its own dev server — the
  manifest fetched cookie-less as a browser really fetches it, renamed and
  watched to follow, every advertised icon decoded at the size it claims with
  the maskable one proven opaque, a refused size, the head tags, the worker
  registering/activating/taking control, an offline navigation showing our page
  WITH a negative control that removes the worker and checks the page is gone,
  the API still answering from the server underneath a live worker, and a
  390px viewport with no sideways overflow).
- **Completion chime** (§13, `chime.ts`): a synthesised two-note Web-Audio ding plays
  when a reply finishes while the tab is hidden/unfocused (`isTabInactive()`).
- **Paced word reveal** (§15): the SSE stream (Anthropic lands in big multi-word
  bursts) is decoupled from the display. `usePacedReveal` (`message-bubble.tsx`)
  runs a rAF loop that advances a "shown" cursor toward the received length at a
  speed **proportional to the backlog**, so words wash in one-at-a-time at a rate
  that tracks the true token rate (fast models drain quickly, slow ones trickle),
  and keeps draining for ~700ms after the stream ends before the message
  re-renders as full markdown. **Markdown formats progressively**
  (`StreamingMarkdown` + `splitStreamMarkdown`): completed blocks (before the last
  blank line, never splitting an open ``` fence) render as real markdown the
  moment they finish, while the block still being typed stays as fading plain
  text. Each word eases in via `.oi-token-in` (opacity only, subtle); the trailing
  partial word is trimmed so words appear whole. No fake caret. The thread
  auto-follows the reveal via a **velocity-matched easing rAF loop** (`followRef`
  in `chat-window.tsx`): each frame it scrolls by that frame's content growth +
  25% of the remaining gap, so the page never jumps AND never falls behind fast
  streams. Any upward scroll **releases** the follow instantly (a `wheel`
  deltaY<0 listener wins the race the old pin-every-frame loop always lost —
  users were trapped at the bottom); scrolling back down to the bottom re-arms
  it, and while released a **floating ↓ button** (sticky INSIDE the scroller so
  wheel events over it still chain to the thread) glides back down and resumes
  following. User vs programmatic scrolls are told apart via `selfScrollRef`
  (the last scrollTop we wrote). Live regression:
  `scripts/test-scroll-follow.ts` (headless Playwright, 18 checks). Scroll
  regions use the slim `.oi-scroll` themed scrollbar.
- **Reply actions**: finished assistant replies show a `MessageActions` row —
  **Copy** (writes the markdown source so formatting survives a paste), **Retry**
  (last reply only → `regenerate()` re-streams over the same user turn; the chat
  route deletes the trailing assistant message(s) and re-runs with `regenerate:
  true`, no duplicate user message), and **thumbs up/down** rating. The stream's
  `done` event carries the saved `messageId` so the reply can be rated;
  `rateMessage` (`app/actions/messages.ts`) stores it on `messages.meta.rating`
  (optimistic in the UI) and mirrors it to the audit log (`message.rate`).

### Provider abstraction (`src/lib/providers`)

One `Provider` interface; adding a provider is a single new file + registry
entry. `streamChat` yields a normalized `ChatChunk` stream
(`text` | `thinking` | `tool_call` | `usage` | `error`; the `error` chunk carries
a `retryable` flag). **Token usage is normalized** into `TokenUsage` where
`inputTokens` is always the uncached, full-price input (each provider reports
cache tokens differently — see comments in `types.ts`). Tool calling is mapped
per provider (OpenAI `tool_calls`, Anthropic `tool_use` blocks, Google
`functionCall` parts). Anthropic prompt caching uses `cache_control` breakpoints
on the system prompt + last message.

`ProviderId = "openai" | "anthropic-api" | "google"`. **Anthropic subscription
OAuth was removed** — routing third-party users through Pro/Max OAuth tokens
breaches Anthropic's terms; the Console API key (`anthropic-api`) is the only
supported path. Do NOT re-add it.

### Data model (`prisma/schema.prisma`)

Two tiers:
- **Permanent** (survives chat deletion): `users`, `provider_credentials`,
  `usage_records`, `settings`, `audit_log`, `app_log`, `message_feedback`
  (thumbs-rating exchange snapshots — plain-column ids, userId SET NULL),
  `user_memories` (model `UserMemory` — the assistant's per-user memory;
  cascades with the account), plus `invites` + `password_reset_tokens`.
- **Ephemeral** (cascade-deletes with the conversation): `conversations`,
  `messages`, `files`.
- `usage_records.user_id` is **ON DELETE SET NULL** — billing history survives
  account deletion (anonymized, tagged with the pipeline `role`). `role` is a
  plain string column; the `UsageRole` union is a TS type in `assistant.ts`,
  not a Prisma enum.

**Shared chats (v0.5)** added `conversation_members` (a row per person in a
shared chat, the OWNER INCLUDED — created with the first invite, gone with the
last leave, so "shared" = "has rows"; carries the member's own star and
`last_read_at`; cascades with chat and user) and `messages.user_id` (the
author of a user turn, SET NULL on account deletion, BACK-FILLED to the
chat's owner for every existing row by the migration so NULL means "author
gone", never "unknown"). `message_feedback`'s unique moved from `message_id`
to `(message_id, user_id)` — ratings are per person, kept in `meta.ratings`
with the legacy `meta.rating` mirrored for the owner. `files.user_id` is
still the uploader, but ACCESS follows the chat (`fileWhereFor`), and a
leaver's uploads are re-stamped to the owner so their account deletion can't
cascade files out of someone else's chat.

Notable columns: `users.must_change_password` (an admin set this password;
every route leads to /change-password until they pick their own — see *Auth
model*); `users.last_seen_version` (release notes seen — NULL = never,
so every existing account is shown the What's new panel once);
`users.name` + `users.last_active_at` + `users.image` (profile-pic
asset name, served via `/api/avatar/[name]`); `provider_credentials.user_id` is
**nullable** (org-level / admin-managed); `usage_records.role`; `messages.meta`
(Json — holds the reply's `rating` "up"/"down" among other markers);
`conversations.incognito` (ephemeral chats, auto-deleted on leave). `files` is
also the **ingestion queue**: `kind` (upload/generated), `status` (FileStatus
enum), `detected_mime`, `processor_group`, `content_path`, `meta`,
`token_estimate`, `attempts`, `claimed_at` (+ an index on `status`).
`enum Provider { openai; anthropic_api; google }` (no OAuth value). Well-known
`settings` keys live in `SETTING_KEYS` (`assistant_config`, `usage_visibility`,
`branding`, `smtp`, `backup_config`, …).

### Auth model — invite-only

**Temporary passwords, set by hand (2026-09-07, owner ask).** Reset emails are
being DELIVERED to the recipient's mail system and blocked there, so people
never get them. Admin → Users → kebab now offers **"Set a password"** (no
email) and **"Email a new password"**; both generate one, mark it temporary,
and **show it to the admin** with a Copy button. It used to be shown only when
the email FAILED — which is exactly the case that never happens here. Whoever
can reset an account can already read every chat in it, so withholding the
string protected nothing and cost support time.

Temporary means `users.must_change_password`: the person signs in with it and
middleware sends every route to **`/change-password`** until they choose their
own (the flag rides the session token, because middleware runs at the edge
with no database, and is RE-READ by the 60-second recheck so it lands on an
already-open session and releases just as fast). Changing it clears the flag,
stamps `passwordChangedAt` — which ends every other session — and signs them
out to `/login?reset=1`, where the screen already says "Password updated".
The current password is required even on the forced screen (an unlocked
laptop must not be two clicks from locking its owner out), and an admin
setting their OWN password is not flagged. Users can also change their
password any time from **Settings → Security**, with no email involved.

**And the login screen now issues one by itself** (2026-09-09, owner ask:
"clients keep emailing me saying I can't log in, when they could just use the
fucking reset button"). After **three** failed attempts on an account whose
password has **never worked here**, `authenticate` issues the same temporary
password Admin → Users does and says so, naming spam and quarantine as where
to look. It is a temporary PASSWORD rather than a reset LINK for a reason the
data gave up: every unused reset link on the estate had **expired** — the
links live an hour and these emails sit in a quarantine folder for longer, so
by the time anyone found one it was dead. A password does not expire.
**The load-bearing guard is `users.lastSignInAt`**, added the same day and
stamped ONLY by a successful sign-in here. `lastActiveAt` cannot do this job:
the OWUI importer carries the old system's value across, so a dormant migrated
account still shows a date. Nor can `passwordChangedAt` — it only exists since
2026-09-05, so 8 of one portal's 11 daily users have none, and keying on it would
have reset the password of people who use the portal every day (caught by
checking against production, not by reasoning). Issuing a temporary password
REPLACES the current one, so firing for somebody who merely mistyped would
turn a typo into a lockout: hence "never signed in", a 3-failure threshold, a
30-minute per-account cooldown, and silence on every other path (a login
screen must not become a way to test which addresses exist). Measured before
shipping: 25 accounts across the estate could ever qualify — 23 of them
migrated accounts that had never sent a message — and **none**
of the ~20 people who failed a sign-in in the preceding fortnight, because
every one of them had signed in successfully within days. It is a safety net
for dormant migrated accounts, not a fix for everyday fumbling.
`issueTemporaryPassword` (`lib/temp-password.ts`) is now the ONE
implementation, shared with the admin action, and it **catches a failing
send**: the password is already replaced by then, so a throwing transport must
not lose that fact — the caller gets `emailed: false` and every screen says
"we couldn't send it, ask your administrator". Proof:
`scripts/test-never-signed-in.ts` (13 live browser checks, SMTP disabled for
the run so no mail leaves a test box) whose most important checks are the
NEGATIVE ones — a returning user is never offered it however often they fail,
their password is byte-identical afterwards, and they can still sign in with
it — plus `recovery.test.ts` (12), `recovery-copy.test.ts` (6, pinning the
spam/quarantine line, which is the entire point of the notice).
Two traps, both found by the harness: the form must be a **form action**, not
an intercepted `onSubmit` — a click landing before hydration made the browser
submit natively as a GET and put `?current=…&password=…` in the address bar,
the history and the server log; and the password row must not widen the users
table (`w-0 min-w-full`), because opening the row menu scrolls that
already-overflowing container sideways and clipped the very message telling
the admin to copy the password. Proof: `scripts/test-temp-password.ts` (26
live checks, including "no password ever appeared in a URL" with a negative
control) + `password-gate.test.ts` (7, source-pinned).

No self-service signup. First run bootstraps the first admin at `/setup`; after
that, access is **invite-only** (admin invites by email, or adds/approves/deletes
a user in the admin panel). Admins can approve/verify with no email sent. With no
SMTP configured (dev), new accounts auto-verify and invite/reset links are logged
to the server console; production enforces email verification. Route protection
is in `src/middleware.ts` (`/admin` requires the admin role).

### Admin — central keys, no whitelist

There is **no per-user model picker and no whitelist** (both removed). The admin
area is an `AdminShell` (same resizable/collapsible nav + top-right account menu
as the chat shell) over **12 pages** (API, Models, Users, Chats, Usage, Feedback,
SMTP, Customise, Tools, **Sandbox** — shown only while that capability is
enabled — Backups, Logs):
- **API** — org provider keys (encrypted; reuses `components/settings/credential-*`).
  Keys can be **renamed and/or replaced** in place (`updateCredential`); a
  replacement is re-verified against the provider before it's re-encrypted.
- **Models** — the four role bindings (key + model + reasoning dropdowns; the
  conversation role adds the extended-thinking level), plus **Limits**
  (`src/lib/limits.ts`, setting key `token_limits`): instance-wide
  `maxOutputTokens` (default **64,000**) and `maxInputTokens` (default
  **128,000**), applied in `runRole` so EVERY role, provider, model and
  reasoning setting gets the same budget — never a per-provider default
  again (see the truncation gotcha below). Clamped per model via
  `resolveMaxOutputTokens` + the cached `Model.maxOutputTokens` (asking for
  more than a model supports is a 400). `maxInputTokens` drives the
  curation trigger (`CURATION_TRIGGER_TOKENS` env still overrides).
  **`maxToolRounds`** (default **6**, bounds 1–40, added 2026-08-03 on owner
  ask) is the per-turn tool budget the pipeline used to hard-code: long jobs
  kept exhausting it and users had to keep typing "continue". ROUNDS, not
  calls — one round can batch several — and progressive disclosure usually
  spends round 1 on `enable_tools`, so the working budget is about one less
  than the number set. Read per turn via the same 30s cache, so a change
  takes effect within half a minute with no restart; every extra round is
  another model call over the whole transcript, so it costs more (the 15-min
  per-turn hard stop is still the backstop). Live harness
  `scripts/test-tool-rounds.ts` (6 checks — proves a budget of 2 stops the
  loop early and 5 genuinely runs further on the same sequential prompt,
  counting BILLED conversation-role calls rather than trusting the loop).
  **`compactAtTokens`** (default **96,000**, 20k–400k, never above
  `maxInputTokens`) and **`compactKeepTokens`** (default **20,000**, 4k–100k,
  at most half the trigger) — the two compaction numbers (0.6.0, see
  *Conversation compaction*): the size of replayed history at which the older
  part is summarised, and how much of the recent conversation is always sent
  verbatim. `compactionLimits()` clamps them to each other; the action
  refuses an inconsistent pair with a message rather than clamping silently.
- **Users** — list/edit/invite/approve/reset-password/disable/delete (a kebab
  menu per row; delete hidden for admins + self). Shows **lifetime tokens
  (in · out) per user** (aggregated from `usage_records`). The kebab also has
  **View chats** → the Chats page filtered to that person.
- **Chats** (2026-07-29, owner ask) — read ANY user's conversation for support
  ("this chat didn't work, can you look?"). Gated behind **sudo mode**
  (`src/lib/sudo.ts`): the admin re-enters **their OWN password**, not the
  master key. That was a deliberate call — the master key decrypts every
  stored provider credential, is shared between admins (so it identifies
  nobody), and can only be revoked by re-encrypting every credential on every
  instance; a per-admin password is revocable, already argon2-hashed, and
  makes the audit trail name a person. The grant is an AES-GCM-sealed,
  httpOnly, `/admin`-scoped cookie carrying `{adminId, exp}`, valid 15 min,
  bound to the account that created it; 5 wrong tries locks that admin out for
  5 min (in-process, single-instance by design). **Every chat opened writes
  `admin.view_chat`** (admin + owner + conversation id) and every unlock
  writes `admin.chats_unlock`; failures go to `appLog` as warnings.
  **Incognito chats are excluded entirely** — the user was promised they're
  private, and listing them would break that. The viewer renders with the
  **REAL `MessageBubble`** (owner ask: "see exactly how the user sees it, and
  only ever update one place"), so an admin gets the identical view — same
  bubbles, tool-run chips, generated images, viz frames, attachments, sources.
  Two pieces make that safe: the loader was extracted to
  **`src/lib/chat-thread.ts` (`buildChatThread`)** and is now shared by the
  user's `chat/[id]` page AND the admin viewer, so the two can't drift; and
  **read-only falls out of the component's own contract** rather than a flag —
  `MessageBubble` gates Retry on `onRetry`, Edit on `onEdit` and (changed
  here) the rating buttons on `onRate`, so passing no handlers leaves nothing
  that can mutate the chat. `components/admin/chat-transcript.tsx` is now just
  the thread container the chat window would otherwise supply. NB the per-turn
  model badge is deliberately gone (it isn't part of the user's view) — model
  per reply lives in Admin → Logs. `GET /api/files/[id]` gained ONE exception
  so attachments and images aren't broken in that view — an admin holding a
  live sudo grant can read another user's file, audited as `admin.view_file`.
  Live regression: `scripts/test-admin-chats.ts` (23 browser checks: locked by
  default, no titles leak, wrong password refused, unlock, both sides
  rendered with the chat component, no composer/rating/retry/edit but Copy
  kept, audit rows, incognito hidden, lock-now, non-admin bounced).
- **Feedback** — every thumbs-rated reply. Rating (`rateMessage`) now also
  snapshots the exchange into the permanent **`message_feedback`** table
  (plain-column ids — survives chat deletion; userId SET NULL like
  usage_records) via `src/lib/feedback.ts`, and the FRONTEND role writes a
  2–4 sentence **"why" analysis** of the conversation in the background
  (usage recorded as role=frontend). Page shows a health strip (total, %
  positive, 7-day counts), All/👍/👎 filters, and per-entry cards: AI
  analysis + expandable exchange snapshot. Live regression:
  `scripts/test-feedback.ts` (11 checks incl. a real browser 👎 click).
- **Usage** — a full dashboard (`usage-dashboard.tsx`, client): ONE shared range
  selector (hour→year + all) drives everything, fed by a single
  `GET /api/admin/usage/summary?range=` fetch (silently re-polled every 60s).
  Six KPI cards (cost / requests+users / in / out / cache-hit-rate / avg
  cost-per-request) with **vs-previous-window deltas**, the token-throughput
  line chart + cost bar chart (`usage-line-chart.tsx` / `usage-cost-chart.tsx`,
  now purely presentational, props-driven), breakdown tables by
  **model / user / role / provider** (req · in · out · cached · cost · %-share
  bar), a **recent-activity feed** (last 25 calls: time, user, role, model,
  tokens, cost), and CSV export. Series+totals+breakdowns come from the same
  bucket-aligned window so every number on the page agrees (asserted by
  `scripts/test-usage-summary.ts`).
- **SMTP** — outbound email config, plus **Error alerts** (`src/lib/alerts.ts`,
  setting key `alerts`): tick "Email me when an error occurs", give an address
  and a repeat window, and every `appLog("error", …)` mails that address. Three
  guards keep it sane — per-error THROTTLE (same category+message once per
  window; repeats counted and reported on the next alert that escapes), a hard
  cap of 12 mails/hour, and it NEVER calls `appLog` itself (an alert failure
  logging an error would try to alert about it, forever — console only). The
  subscription starts in `instrumentation-node.ts` and is globalThis-anchored
  (Next instantiates modules per route bundle). **That anchoring was only
  the idempotency FLAG** (found in production 2026-09-04): `applog.ts` kept
  its subscriber Set module-local, so the subscription registered from the
  instrumentation bundle heard only events logged from that bundle — never
  the chat route's. Twenty "Sandbox signed out" errors in a day, alerts on,
  SMTP working (the weekly report went out that afternoon), and not one
  email; the test button worked because it calls `sendMail` directly. The
  Set lives on `globalThis.__opninferLogListeners` now (`applog.test.ts`
  pins it), every sent alert leaves a `[alerts] sent "<key>" to <addr>`
  line in the container log so `docker logs` can answer "did it go out?",
  and the Admin → Logs live feed — same Set — now sees other bundles' events
  (live-proven on the dev box: the feed opened from the logs route received
  an error logged by a server action). Process crash guards
  (`unhandledRejection`/`uncaughtException`) now go through `appLog`, not just
  `devLog` — devLog is dev-only, so in production a crash previously left no
  trace an admin could see and nothing to alert on. Unit tests:
  `alerts.test.ts` (11 — throttle/cap/grouping).
  Also hosts the **Weekly report** (`src/lib/weekly-report.ts`, setting key
  `weekly_report`, 2026-07-30 owner ask): a Friday-17:00 digest of **spend**
  (week total, vs the previous week, by person and by model), **errors**
  (grouped by the same category+message key the alert throttle uses, with
  counts) and **health** (ingestion queue — pending / stuck-mid-processing /
  failed — plus live probes of Whisper, Kokoro and sandboxd). Chosen over hard
  spend caps by the owner: with ~£200/month across four instances a cap that
  cuts someone off mid-conversation is worse than a weekly email. Costs are
  **USD** (that's what `usage_records.cost_estimate` stores).
  **The schedule is real LOCAL time, not a stored UTC hour** — the backup
  scheduler's `hourUtc` would land at 17:00 in winter and 18:00 in summer;
  `localParts`/`isReportDue` read wall-clock fields through `Intl` in the
  configured zone (default Europe/London) so 5pm stays 5pm across the clock
  change, and one send per local date stops the 5-minute tick re-sending all
  evening. `lastRunLocalDate` is stamped BEFORE sending, so a broken relay
  can't retry every tick; failures go to console + devLog only (routing them
  through `appLog("error")` would make a broken report email about itself —
  same rule as alerts.ts). Folds in the health-endpoint idea rather than
  adding one: no new infrastructure, and it's what would have caught the
  8-day dead worker. Unit tests `weekly-report.test.ts` (13, incl. BST/GMT);
  live harness `scripts/test-weekly-report.ts` (14 — real DB, renders the
  email to `logs/weekly-report-preview.html`, checks a hostile display name
  is escaped, and sends NO mail unless `REPORT_LIVE_SEND=<address>`).
- **Customise** — assistant identity (name + logo), **assistant instructions**
  (the standing system prompt — see *Assistant pipeline*; 8k chars, live from
  the next message, no restart), portal branding (logo + light/dark accent),
  the in-chat usage-stats visibility setting, and the max-upload-size setting.
- **Tools** (0.3.0) — per-group tool toggles (server-enforced; incl.
  "Clarifying questions" = the `ask` group), Tavily key (verify-then-encrypt),
  image weekly quotas, the **User memory** card (0.5.1: pause learning for
  everyone, note size, chat search — on/off is the group toggle), sandbox
  status, client-capability cards (see *Agentic tools*).
- **Sandbox** (2026-09-02, owner ask — "quite a lot of info, could do with
  its own panel") — everything about the agent tier except the switch:
  service status (broker + what the image ships), the configuration form
  (credential mode, fallback key, Check sign-in, plan usage, model/effort/
  limits/steering), **Connected services (MCP)** (2026-09-03 — see *Sandbox
  agent tier*) and "What the agent reaches for". The ENABLE switch
  stays on Tools with the other client capabilities (`SandboxEnableCard`,
  which re-submits the stored config untouched — the generic toggle card
  saves `{}` and would reset it), and the savings strip stays on Usage.
  The nav tab exists only while the capability is on: `admin/layout.tsx`
  reads the state once per render and threads `sandbox` through
  `AdminShell` → `AdminNav`; the page itself redirects to Tools when off.
  Browser regression: `scripts/test-admin-sandbox-page.ts` (18 checks, no
  model calls).
- **Backups** — full-instance snapshot/restore + auto-backup schedule (see
  *Backup & restore*).
- **Logs** — live application log (SSE), TWO views (2026-07-19): **Chats**
  (default — one row per assistant reply: user avatar+name, when, model,
  in/cached/out tokens, cost, duration, tool count, escalated/failover
  badge; fed by the enriched per-turn `chat` appLog details) and **Raw**
  (every event as recorded — level/category/user/message, click a row to
  expand the full details JSON).

Shared admin UI primitives are in `components/admin/ui.tsx` (`Card`, `Field`,
`fieldCls`) so the admin area matches the chat look.

### Operator console (2026-09-07) — `src/app/console/` + `src/lib/console/`

One read-only overview across EVERY portal on the host, on its own port
(3000 — `next_free_port` has always started portals at 3001). Owner ask:
"an admin dashboard for all client portals… never need to write from this
admin dashboard, just read please, and also doesn't need anything like smtp
as that is all managed per client portal." Full design record, every trap and
the proof: **`docs/V06_CONSOLE.md`**. The load-bearing facts:

- **The same image, run twice.** `OPNINFER_MODE=console` (`src/lib/mode.ts`)
  makes middleware serve only `/console` + `/api/console` and 404 every portal
  route; a portal 404s the console tree. The root layout skips `getBranding()`
  (no DB here) and `instrumentation-node.ts` starts NO scheduler. Rejected: a
  second Next project — it would double the image build on every deploy and
  let the two drift. As built, the usage page renders the PORTALS' OWN
  `UsageDashboard` component against `/api/console/usage`, so they cannot
  disagree. `mode.test.ts` pins the gating from SOURCE (middleware, the API
  guard, the layout, `auth.ts`) — a portal quietly serving `/console` would
  have no symptom you would go looking for.
- **No database of its own** (owner decision). Accounts are `email:argon2`
  pairs, **base64-encoded** (`CONSOLE_OPERATORS_B64` — compose eats a bare
  `$`, see *Conventions*), in `instances/console/console.env`, written by
  **`./deploy.sh console-password`** (the password is hashed inside the app image, on STDIN,
  never in argv). Sessions are the existing Auth.js JWTs; `authorize` and the
  60-second recheck both branch on `IS_CONSOLE`. No invites, no resets, no
  SMTP, no `/setup`. Cookies are already namespaced per instance, so the
  console runs as `OPNINFER_INSTANCE=console` and can be held open beside all
  four portals.
- **It reads as a role that CANNOT write.** deploy.sh creates `console_ro` in
  every portal's database with SELECT and nothing else, plus `ALTER DEFAULT
  PRIVILEGES` so future migrations' tables are covered without anyone
  re-granting. Read-only is a property of the DATABASE, not of our query
  layer — `test-console.ts` proves it by attempting an INSERT and asserting
  Postgres refuses (42501). Connections go to the **container** name
  (`opninfer-<name>-db-1`): every project has a `db` alias and this container
  is on all their networks at once. Pools are capped at 2 per portal — those
  connections come out of the same `max_connections` a client's chats need.
- **"Waiting" and "failed" are different problems** (2026-09-07, first real
  read of the page). The overview added `pending + failed` and called the sum
  "files stuck in ingestion" — on one portal that was four PDFs that failed Docling
  OCR between 31 July and 14 August (two 504 timeouts, two while the engine
  was down). Nothing was stuck: the queue was empty and those rows would have
  sat on the page for ever, reading as a live outage. A PENDING file is a
  queue that is not draining and deserves amber; a FAILED one is history.
- **A portal that cannot be read is SHOWN as such.** `fanOut` never rejects;
  a portal that is down or mid-deploy is an error row with an amber banner
  naming it, and the rest still renders. Errors are scrubbed first — Prisma
  quotes the whole datasource URL, password included, and this text reaches a
  browser.
- **The console's env files must NOT match `instances/*.env`** (the bug that
  reached production, 2026-09-07). deploy.sh treats that glob as the PORTAL
  list — it picks the first match as the env file for the image BUILD, loops
  over them to deploy, and scans them for free ports. With the console's two
  files in there, `console-portals.env` sorted first and the build died on
  "required variable SANDBOX_BROKER_TOKEN is missing a value" — on the SECOND
  deploy, once the first had created them, so the change that caused it had
  already been declared a success. They live in `instances/console/` now, and
  `migrate_console_env` moves an old layout across BEFORE anything globs (by
  the time `deploy_console` runs, the build has already failed). Silver
  lining: the build is the safe end of a deploy — nothing is drained or
  recreated yet — so all four portals were untouched.
- **Adding a portal needs no second step.** deploy.sh regenerates
  `instances/console/portals.env` every run from `instances/*.env` (creating
  the role as it goes) and attaches the container to each
  `opninfer-<name>_default` network after `up`; the console's own secrets live
  in a separate file that is written once. `OPNINFER_SKIP_CONSOLE=1` opts out.
- **Tool names are not logged anywhere queryable** — `app_log` records only a
  COUNT. So the Activity page reports two qualities of evidence and says which
  is which: exact counts from what a reply persists for its own re-rendering
  (`meta.toolRuns[].tool`, `meta.images`, `meta.sources`, `meta.viz`,
  `meta.asks`, `meta.fileIds`), and the status lines bucketed by `labels.ts`.
  It does NOT claim to recover a name it cannot: `read_file` and a single-URL
  `web_scrape` both render "Reading X", so they share one honestly-named row.
  **The Sandbox agent's NARRATION lands in that same log** (`bridge.ts` makes
  each text block a `{kind:"status", label}`) and swamped the first version of
  the table; it is separated by SHAPE — no label this app emits reaches 60
  characters, runs to eight words, contains a sentence break, or ends in a
  full stop.
- **The graphs are split by portal** (owner ask, 2026-09-07). The cost chart
  draws each bar as BANDS, one per portal — the bar's total height still
  answers "what did we spend" and the colour answers "on whom", so nothing
  was lost to gain the split (the owner chose this over small multiples or
  overlaid lines). Additive by construction: `CostBarChart` gained an
  optional `stack` and `CostPoint` an optional `by`, and a portal's OWN
  Admin → Usage sends neither, so it renders exactly the chart it always did.
  The colour is keyed by portal NAME, not by position — portals are listed by
  spend, so a positional palette would swap two clients' colours the day one
  outspent the other, and a colour that means something different each visit
  is worse than none; the bands are ordered alphabetically for the same
  reason. `stackCostByPortal` (pure, 6 tests) joins each portal's series to
  the merged one BY INDEX, which is only safe because `commonWindow` already
  asks every portal for the same bucket grid. **The overview page carries the
  same two graphs** (`console/spend-chart.tsx`), fed by the SAME
  `/api/console/usage` the Usage page uses rather than by widening the
  overview's own read: the two pages then cannot disagree, and a page already
  fanning out to four databases does not pay for a second series it is about
  to fetch anyway. It follows the overview's range selector rather than
  owning one — two range controls on one screen, each governing half of it,
  gets misread once and distrusted thereafter.
  Proof: 6 unit tests + 4 live in `test-console.ts` (a two-portal payload is
  INJECTED with `page.route`, because the dev console has one portal and one
  portal has nothing to split — the arithmetic is proven against real
  summaries in `merge.test.ts`, and the browser check proves the chart draws
  what it is handed: 48 bands, both portals named, and the overview page
  showing both graphs). Eyeballed light and dark via `shot-console.ts`.
  **Harness gotcha:** both console scripts need `--env-file=.env` (they read
  `DATABASE_URL` to derive the read-only URL), and a crashed run leaves a
  `next dev` holding port 3011/3012 — the next run then dies with "console
  never started" and, worse, `shot-console.ts` leaves the PREVIOUS run's
  screenshots in place, so it is entirely possible to review a picture from
  hours earlier and believe it. Check the mtime.
- **Merging needs one bucket grid.** Each portal would pick its own for "all"
  (from ITS first record), and four series on four time bases cannot be
  summed; the console resolves one window from the earliest record anywhere.
  And an email is unique only WITHIN a portal, so the merged people breakdown
  tags each row with its portal — otherwise one person's two accounts become
  one row and the totals stop adding up (`merge.test.ts`).
- **"Who asked for a link and never got in?"** (owner ask, 2026-09-09 — "that
  would indicate they aren't receiving the reset email"). The People page
  names them at the top rather than badging a row in a table of forty.
  `reset-watch.ts` (pure, 9 tests) is the rule, and it rests on two facts
  about the reset flow: `requestPasswordReset` DELETES a user's earlier unused
  links, so there is at most one row per person and it is always their latest
  ask; and completing a reset sets both `usedAt` and `passwordChangedAt`, so
  "asked but never arrived" is an unused row with no later password change. A
  link that is still VALID reads as "waiting", not stuck — silence inside the
  hour means nothing. Only an EXPIRED unused link is evidence. First reading
  on production found 5, across two portals, all asked within 48
  hours, none completed — which is what turned "the emails might be getting
  filtered" into a fact and produced the temporary-password change above.
- **Two columns on People carry caveats, said on the page:** `lastActiveAt` is
  imported from OWUI for migrated accounts (a date before that portal's
  cutover is history, not a sign-in here), and `passwordChangedAt` is stamped
  only by a RESET, never by accepting an invite — so it is the "this person
  has arrived" signal after a migration and nothing much otherwise. An early
  version painted every normally-invited user amber for a column they could
  never satisfy.
- **Dev:** `NEXT_DIST_DIR` (next.config.ts) lets the console dev server run
  beside the portal one without overwriting its webpack chunks — the
  documented "500 on every route" failure. Unset in every build and deploy.
- **Proof:** `scripts/test-console.ts` (31 live checks — the role cannot
  write, both modes refuse each other's routes, sign-in works and a wrong
  password does not, the overview's numbers match a direct query, every page
  renders with a negative control, sign-out ends the session);
  `scripts/shot-console.ts` (screenshots every page light + dark into `logs/`);
  unit `operators` / `instances` / `labels` / `merge` / `mode` (43).
  `test-deploy-functions.sh` asserts the role grants SELECT and NO write verb,
  with a negative control, and that a portal it cannot prepare is left out
  rather than aborting the deploy.

### Backup & restore (`src/lib/backup.ts`)

A **backup is a single `.zip`** capturing the whole instance:
`manifest.json` (format/app version, timestamps, per-table row counts, and a
**fingerprint** of `OPNINFER_MASTER_KEY`), `database.json` (a portable **logical
dump** of every app table, NOT a binary `pg_dump`), and `storage/<tenant>/…` (a
mirror of the on-disk file tree — uploads, avatars, branding). Backups live in
`<storageRoot>/backups` — **outside** the tenant tree, so they survive a restore
and are never nested inside their own archive. The storage volume is the backup
volume.

- **Create/download/delete** — `createBackup(source)` streams the zip to disk via
  `archiver` (written to a `.part` temp then atomically renamed), listed by
  `listBackups()`, downloaded (streamed) at `GET /api/admin/backup/[name]`,
  deleted by name. Server actions in `app/actions/backup.ts`.
- **Serialization is type-aware**, not naïve JSON: `Bytes`→base64,
  `BigInt`→string, `Decimal`→string, `DateTime`→ISO; `Json` columns pass through.
  Null columns are **omitted** on restore so the DB default/NULL applies (this
  also sidesteps Prisma's Json-null typing). Round-trip is verified against the
  live DB by `scripts/test-backup.ts`.
- **Restore** (`restoreFromZip`, `POST /api/admin/backup/restore`, multipart) is
  **data-only + destructive**: rows are decoded BEFORE anything is wiped, then in
  one transaction every table is emptied (children→parents) and repopulated
  (parents→children) via chunked `createMany`; finally `conversations.updated_at`
  / `settings.updated_at` are raw-`UPDATE`'d back to the backup's values (Prisma
  auto-stamps `@updatedAt` on create, so createMany would otherwise reset them).
  The migration table is never touched — a backup restores into the **current**
  schema. Storage is swapped after the DB commits (tenant dir cleared, then
  `storage/*` extracted with a traversal guard). If the backup's master-key
  fingerprint differs, the result flags `masterKeyMismatch` (encrypted provider
  keys won't decrypt) — surfaced in the UI.
- **Moving an instance by backup-and-restore** (owner question, 2026-09-04,
  checked against the code and a live portal): a backup holds EVERY table (the test
  pins this against the schema) and every plain file under the tenant tree —
  uploads, generated files, avatars, branding, and the Sandbox agent state
  dirs (transcripts). Restore is wipe-then-replace on both — no merge, so a
  newer archive over an older clone simply becomes the archive's state, extra
  hours of chats included. NOT in a backup, and needed on the new box:
  `instances/<name>.env` (master key, DB password, deploy token — the
  manifest's key fingerprint flags a mismatch), the agent credential volume
  (`./deploy.sh agent-login` + `agent-mcp` again), and the images (deploy.sh
  builds them). Rules: same app version on both sides (restore inserts into
  the CURRENT schema — an older archive restores into a newer build, the
  reverse fails safely inside the transaction); the upload route is excluded
  from the middleware matcher so the 256 MB body cap does not apply, but the
  reverse proxy's body limit must exceed the zip (a busy portal's is ~355 MB and grows
  ~30 MB/day). Two fixes made while checking: (1) **the storage walk now adds
  regular files only** (`addStorageTree`) — `archive.directory()` died on the
  Linux symlink each agent state dir carries (`.credentials.json`, invisible
  to Windows `lstat` → EVERY dev-box backup since the agent tier failed with
  EACCES; on Linux it dangles), and that link is now never archived at all,
  since it is the shared Claude sign-in; (2) **a pre-0.5.1 archive restores
  into 0.5.1** — its `user_memories` rows are folded into each person's
  "About you" note and user turns are stamped with their chat's owner, the
  same as the migration, and the serial reset now targets
  `user_memory_topics` (it named the dropped table, which would have failed
  every restore). Proof: `scripts/test-backup.ts` (round trip) and
  `scripts/test-backup-legacy-restore.ts` (an archive edited to look like
  0.4.1: memories folded, authors stamped, sequence advanced, counts intact).
- **Auto-backups** — an in-process scheduler started from `instrumentation-node.ts`
  (Node runtime only). Config is the `backup_config` setting (`enabled`,
  `frequency` daily/weekly, `hourUtc`, `retention`, `lastRunAt`); a cheap
  10-minute tick runs a backup when due, updates `lastRunAt`, and prunes to the
  retention count. Default **disabled**.

### File ingestion & storage pools (0.2.0)

**Every conversation owns a storage pool** — `<root>/<tenant>/chats/<convId>/` —
holding the user's uploads under **human-readable names** (deduped
`name (2).ext`; the model addresses files by name). A hidden `.opninfer/`
subdir holds prepared artifacts (`<fileId>.md`). Deleting a chat (single, bulk,
delete-all, incognito wipe, account delete) **removes the pool from disk**.
Storage paths in the DB are always **POSIX-style** (Windows dev writes them
with `/` too — the Linux worker reads them). Uploads **stream to disk via
busboy** (`/api/files?conversationId=…` — query params, not form fields, since
field order can't be trusted mid-stream); the admin limit (Customise → Uploads,
`max_upload_bytes` setting) is enforced mid-stream (413 + partial cleanup).
Attaching in a brand-new chat **creates the conversation** ("create on attach",
incognito-aware); the chat route still AI-titles a conversation whose first
user turn arrives later (`firstTurn`).

**Attachments render on their message, not above the composer.** The user turn
stores `meta.fileIds`; the loader (`src/lib/message-files.ts`,
`attachFilesToMessages` — pure + unit-tested) re-associates files to their
message (exact via meta; uploads also fall back by TIME for pre-linkage
chats: an upload → first user turn at/after its upload time). **Files the
assistant creates are its private WORKSPACE — invisible until it PRESENTS
them** (2026-07-19, `present_files` — see *Agentic tools*): presented files
stream as `files` SSE events mid-turn onto the reply and persist in
`meta.fileIds` (displayable images go through the INLINE generated-image
flow / meta.images instead); unpresented generated files never render and
never time-fallback. Only genuinely unsent uploads (attach → reload before
send) land back in the composer strip (`initialPending`).

**Uploads >10 MB truncate unless `experimental.middlewareClientMaxBodySize` is
raised.** When middleware matches a route, Next **clones the request body with
a 10 MB default cap and SILENTLY TRUNCATES beyond it** (`body-streams.js`
`DEFAULT_BODY_CLONE_SIZE_LIMIT`) — busboy then throws "Unexpected end of form".
Our `middleware.ts` matches `/api/files` (+ avatar/stt/backup), so
`next.config.ts` sets `middlewareClientMaxBodySize: 256 MB`; it MUST stay ≥ the
admin `max_upload_bytes` limit. Affects **production too**, not just the
`--experimental-https` dev server. Config change → **restart** `pnpm dev`
(next.config isn't hot-reloaded). (Known nit: a next.config comment says the
upload default is 100 MB, but `.env.example` ships
`OPNINFER_MAX_UPLOAD_BYTES=52428800` = 50 MB — the env value wins.)

**The ingestion pipeline is multi-container** — a thin Python router (`worker/`)
plus official engine images; the `files` table IS the queue (`FOR UPDATE SKIP
LOCKED` claim, `claimed_at` staleness reclaim, `attempts` cap — no Redis):

- **worker** (our image): magic-byte detection (`python-magic`; extensions lie),
  the five-group routing map, embedded **MarkItDown** (docx/pptx/pdf-with-text/
  markup/epub/email/zip), the **UTF-8 passthrough** sweep (all code/config/text),
  **spreadsheet schema** extraction (openpyxl/pandas/pyarrow — sheets, shapes,
  headers, dtypes, sample rows; full dump only ≤100 rows: "the map, not the
  dump"), **SQLite introspection** (tables/columns/FKs/row counts, never data),
  **ffprobe** video metadata, **Pillow** image dimensions/EXIF, and a
  metadata-only fallback that never throws. Writes artifacts + updates
  `status/detectedMime/processorGroup/contentPath/meta/tokenEstimate`.
- **gotenberg** (`gotenberg/gotenberg:8`, always on): legacy Office/ODF/RTF/
  iWork → PDF → MarkItDown (`processor_group=libreoffice`).
- **docling** (`quay.io/docling-project/docling-serve-cpu`, `heavy` profile):
  OCR for scanned/complex PDFs. Escalation is dispatcher-driven: MarkItDown
  returns `escalate_to="docling"` when a **large** PDF yields thin text (<200
  chars AND >50 KB — small short-text PDFs are legitimately short, not scanned).
  `POST /v1/convert/file` → `document.md_content`.
- **whisper** (`onerahmet/openai-whisper-asr-webservice`, faster-whisper,
  `heavy` profile): audio → transcript artifact (`POST /asr`). Model size via
  `WHISPER_MODEL`.

Heavy engines: **always on in prod** (shared engines stack — see
*Deployment*); **opt-in in dev** via `--profile heavy` on
docker-compose.dev.yml. Without them those routes degrade to honest
metadata-only results. Statuses: `pending → processing → ready | unsupported
(stored, metadata only) | failed`; chips poll `/api/files/status` and show a
spinner/red dot.

**Chat integration** (`src/lib/file-tools.ts` + the tool loop in
`pipeline.ts`): sending while attachments are still ingesting is allowed —
the chat route **holds the turn** (`waitForTurnFiles`, 3-min cap then answers
with what's ready) and builds the context AFTER the wait, so voice notes/docs
are actually in the manifest when the model starts. The wait streams **`phase`
SSE events** rendered INSIDE the animated thinking indicator (sparkle +
"Processing <file>…" replaces the gerund, label:null resumes it) — NOT a tool
line, which would go stale and stick after the wait (regression:
`scripts/test-ingest-wait.ts`, 8 checks incl. the phase-clear). When a chat has files, the route injects a
**manifest** system
block that INLINES each readable file's prepared content directly (newest
first, up to `MANIFEST_CONTENT_BUDGET_CHARS` ≈ 24k chars / ~6k tokens —
`planInlineTake` is the pure, tested allocation rule) so the model knows what's
attached with no tool round-trip; larger files are truncated with a `read_file`
fallback and files past the budget stay metadata-only. `list_files` +
`read_file` (paged, 12k chars/page) remain for full text. Images ride the turn
natively (vision), never inlined as text. `runAssistant` runs a bounded
**multi-round tool loop** (admin-set tool rounds, default 6, then a forced-answer round;
escalation model gets the tools too; failover stays tool-free). `ChatMessage`
now supports `role:"tool"`, `toolCalls`, and `images` — mapped per provider
(OpenAI `tool_calls`/`image_url`, Anthropic `tool_use`/`tool_result`(merged)/
`image` blocks, Google `functionCall`/`functionResponse`(by name)/`inlineData`).
**Images attached to a turn ride the user message natively** (≤6,
png/jpeg/gif/webp) — no separate vision model. **Vision images are DOWNSCALED
before inlining** (`src/lib/image-vision.ts`, `sharp`): EXIF-auto-rotated,
long edge capped at 1568px, re-encoded in-family — cuts OpenAI/Google image
tokens and shrinks a 12 MB photo to a few hundred KB, so big uploads reach the
model instead of being dropped (source cap 50 MB). **image_edit/blend SOURCES
are ALSO downscaled** (`prepareImageForEdit` via `loadImageByName`), in two
tiers that track the requested output quality — **normal** (standard→Flash/1K:
~1414px/q80) and **pro** (max→Pro/2K: 2048px/q85), mirroring an earlier
in-house toolset's two compression profiles. Uploads stay FULL-RES on disk (originals preserved
for download); only the copy sent to Gemini is shrunk (source cap 50 MB —
big phone photos downscale instead of being rejected, the old 8 MB cliff).
Unlike OWUI we keep the format family (PNG stays PNG) so transparency survives
instead of force-JPEG. Regressions: `src/lib/image-vision.test.ts` (edit tiers
+ alpha) + `scripts/test-image-edit-source.ts` (>8 MB source downscales,
non-destructive, PNG alpha preserved).
`read_file` emits a "Read <name>" notice so users see tool activity. Verified live end-to-end by
`scripts/test-files-http.ts`, `test-ingestion-http.ts`, `test-ingestion-c-http.ts`,
`test-ingestion-d-http.ts`, `test-chat-files-http.ts` (real model reads a CSV
value + reads a word off a PNG).

### Agentic tools (0.3.0) — `src/lib/tools/` + `src/lib/capabilities/` + `sandboxd/`

The assistant acts, not just reads. Full design + per-step reference:
**`docs/V03_AGENTIC_TOOLS.md`**. The load-bearing facts:

- **Registry** (`tools/registry.ts`): every tool = one `registerTool` entry
  (def + GROUP + ctx-bound executor). `buildToolset(ctx, opts)` (async) builds
  the per-turn set: built-ins + enabled capabilities − admin-disabled groups
  (`tools_config.disabledGroups`, Tools page) − incognito exclusions (memory)
  − files group when the chat has no files. Groups: files · datetime · web ·
  memory · image · skills · visualize · sandbox · ask · capability.
- **Tool loop** (`pipeline.ts`): the admin-set tool-round budget (Admin →
  Models → Limits, default 6) then a forced-answer round. **An empty
  turn is triple-guarded** (a live bug: 6 rounds of searches, an unoffered
  7th tool attempt silently dropped, user got NOTHING): (1) the final round
  injects a "[system notice] tool budget exhausted — answer now" message as a
  trailing **user** turn (system text gets hoisted to the top by every mapper
  and loses its position — verified live), (2) a loop that still ends textless
  runs one guaranteed tool-free answer pass, (3) the chat route surfaces an
  honest error if a turn truly produces nothing. Regression:
  `scripts/test-empty-reply-guard.ts`. Tool results
  can carry **images** (`ToolResultPayload`) which ride a synthetic user turn
  (Anthropic mapping merges consecutive user turns — role alternation, with
  tool_result blocks stable-sorted to the FRONT of the merged turn or
  Anthropic 400s on multi-tool rounds). **Gemini 3 `thoughtSignature` must be
  echoed on replay** (`ToolCallPart.signature`) or Google 400s.
- **Token efficiency**: **progressive tool disclosure** (`disclosure.ts` —
  replaced the frontend-role router, which starved the model on ambiguous
  follow-ups): cheap groups (files/datetime/memory/skills/visualize +
  view_image) live from round 1; heavy groups (web/image/sandbox/capability)
  sit behind a MORE TOOLS directory system block and the model activates them
  itself via `enable_tools` (the ctx.tools array grows IN PLACE; the loop
  re-reads it each round). Plus **context curation** (neutral ChatMessage[]
  pre-provider-mapping; ~100k trigger, keep recent 5, never memory ops,
  ~200-token summaries). Usage roles `curator`/`image` (`router` retired,
  kept in `UsageRole` for historical rows).
- **Tool feedback UX**: every call streams a live status line
  (`tool_status` chunk → `tool` SSE; labels in `tool-status.ts`;
  `enable_tools` stays silent) — except the **sandbox family**, which gets
  a rich **run block** instead (2026-07-14): live 5-line code tail as the
  model writes (`tool_call_delta` provider chunks → `ToolArgTap` in
  `src/lib/tool-run.ts`), live console tail during execution (sandboxd
  NDJSON exec streaming → `ToolCtx.emitRun`), then collapsed `+N −M` /
  `Ns · L lines · exit E` chips persisted in `messages.meta.toolRuns`
  (expand on click, survive reload). Web/file-read tools emit **sources**
  (`SourceRef` kind web|file) → streamed, URL-deduped, persisted in
  `messages.meta.sources`, rendered as a favicon "N sources" pill + panel
  under the reply (file rows open the context viewer).
  `GET /api/files/[id]/context` returns the EXACT prepared text `read_file`
  hands the model — file chips are clickable to show it.
- **Tools**: web_search/web_scrape/web_search_and_read/download_file (Tavily
  key = encrypted `web_tools_config` setting + env fallback; download is
  app-side + **SSRF-guarded**, streams into the pool); memory_* (auto-injected
  block, 2000-char budget, never in incognito, cascades with the account);
  view_image (pool filename); image_generation/edit/blend (Gemini only,
  flash/pro weekly quotas counted off usage_records); load_skill
  (`skills/<name>/SKILL.md`, anthropics/skills format, L1 list in prompt, L2 +
  asset staging on demand); render_visualization (marker protocol parsed
  SERVER-side by `viz-stream.ts` → `viz_start/viz/viz_end` SSE → `VizFrame`
  sandboxed iframe, persisted in messages.meta.viz); write_file/edit_file/
  delete_file (host-side, traversal + `.opninfer` guards) and
  execute_command/run_script (broker); read_file gained `raw: true`.
- **Sandbox** ("guard hut", owner-approved): `sandboxd/` is the ONLY holder of
  the Docker socket — narrow bearer-token API; enforces image allowlist,
  per-chat pool mount (dev bind via STORAGE_HOST_ROOT / prod named-volume
  subpath), tmpfs over `.opninfer`, read-only rootfs, 2g/2cpu/128pids,
  cap-drop ALL, egress-only network (internet yes, internal compose net NO;
  `SANDBOX_NETWORK=none` to disable), `timeout -s KILL`, warm per-chat
  containers + idle reaper. Fat image `opninfer-sandbox`
  (`docker/sandbox/Dockerfile`, built by deploy.sh). After every mutation
  `pool-sync.ts syncPool` diffs pool↔files rows (new → kind=generated pending
  → worker ingests; changed → re-ingest; gone → row deleted).
- **Capabilities** (`capabilities/registry.ts`): instance-enabled tool
  bundles; zod-validated config (invalid = fail closed), secretFields
  encrypted; `execute` may return a `ToolOutput`, not just text, so a
  capability can emit **sources**. Admin → **Tools** page hosts group toggles,
  Tavily key, image quotas, memory budget, sandbox status, capability cards.
  No client capability ships in the product: `capabilities/local.ts` is an
  EMPTY list here, and is the ONE file a private deployment replaces to add
  its own (see that file's note, and *Splitting this product* in the working
  agreement). A capability with `configSchema: z.object({})` renders as
  `CapabilityToggleCard`: just the switch, plus the read-only data-source line
  the capability declares for itself — the page is never keyed on a
  capability's id, so it renders one it has never heard of.

### Memory v2 (0.5.1, 2026-09-04) — `src/lib/memory-topics.ts` + `memory-pass.ts` + `tools/memory.ts` + `tools/chat-search.ts`

Owner ask: "better user memories, the current implementation is lacking,
research how OpenAI and Anthropic do it". The research and the confirmed
design are in **`docs/V051_MEMORY.md`**; the diagnosis that mattered: on
one live portal the assistant had saved **14 memories in 1,289 messages**,
because nothing ever told it WHEN to save — the old tools only fired on
"remember that", and the flat one-line list never merged or aged. What
replaced it:

- **Four named notes per person** (`user_memory_topics`: about / replies /
  work / rules — `MEMORY_TOPICS` in `memory-topics.ts`), each **rewritten in
  full** whenever something changes, so "moved to sales" REPLACES "marketing
  lead" instead of sitting beside it. Size-capped per note (admin, default
  1,200 chars; `clipTopic` cuts on a line or sentence, never mid-word). The
  block rides every turn with today's date; null when there is nothing to
  say. The old `user_memories` rows were folded into each person's *About
  you* note by the migration (`20260904160000_memory_topics`), oldest first,
  and the table dropped; the OWUI importer appends to the same note.
- **The idle-chat pass** (`memory-pass.ts`) — the owner's two changes to the
  proposal: **not after every reply — once a chat has been quiet for 30
  minutes** (`MEMORY_PASS_IDLE_MINUTES` overrides; the harness calls
  `runMemoryPassForConversation` directly), and **nothing is shown to the
  user** (no "Memory updated" chip). A 5-minute scheduler
  (`startMemoryPassScheduler`, from `instrumentation-node.ts`) picks chats
  whose newest message is 30+ min old AND newer than
  `conversations.memory_pass_at`, stamps the chat FIRST (a failing model
  call is not retried every tick — the next message makes it due again),
  then runs the front-end role over the newest turns beside the current
  notes and applies the changed notes it returns as JSON (`parsePassOutput`
  tolerates fences and prose). **The picker's raw query needed
  `make_interval(mins => $1::int)`** — Prisma binds a JS number as bigint
  and Postgres has no such overload, so in production the scheduler threw
  on every 5-minute tick from the moment 0.5.1 deployed and NO chat was
  ever picked; dev.log had 88 identical errors nobody read (the "last 60
  minutes" rule would have shown them — read it after a release). Fixed
  the same day; `runMemoryPassOnce()` run by hand picks chats again.
  **And the first working night it ran amok** (2026-09-04, owner: "old
  chats from ages ago showing active in recent moments… what an awful
  leak"). Two design faults: (1) the picker had NO AGE CUTOFF — a chat
  that had never had a pass counted as "something new since the last
  one", so the first tick on a migrated portal started on the OLDEST of 2,100 imported
  chats and worked forward from January, ten every five minutes, for five
  hours (600 chats, $1.46 on the front-end model), rewriting five people's
  notes from months-old conversations and WIPING one person's About note
  (58 folded memories) in favour of what January said; (2) the stamp went
  through `db.conversation.update`, whose `@updatedAt` bumped each chat's
  "last activity" to now — the column the sidebar AND Admin → Chats sort
  by — so January's chats sat at the top of everyone's sidebar all
  evening. Fixed: `MAX_AGE_DAYS` (7, env `MEMORY_PASS_MAX_AGE_DAYS`) in
  the picker and a raw `update conversations set memory_pass_at` for the
  stamp (`memory-pass.test.ts` pins both). Reverted in one transaction
  from the live DB and that morning's backup zip: every bumped chat's
  `updated_at` back to its newest message, the eleven pass-created notes
  deleted, the two rewritten/wiped About notes restored from the backup's
  `user_memories` fold. Lessons: ask what a scheduler does on FIRST
  CONTACT with history, never stamp through Prisma's update on a table
  whose `updated_at` means something, and read the production log after
  every deploy — the make_interval bug had hidden this one all morning.
  Closed out the same night: repair transaction committed (UPDATE 600 /
  DELETE 13 / the two About notes back, one of them needing a second pass
  to strip the CRs a Windows text-mode write had added), the fixed code's
  first ticks took 40 chats from the last week and bumped none, and the
  error-alert path was proven in PRODUCTION with a throwaway user's bogus
  dictation: `[alerts] sent "stt:Whisper rejected a dictation request."`
  in the container log — the first organic alert the instance ever sent.
  The owner re-ran `agent-login` at 22:04 the same night.
  Skips: incognito, shared chats, a person who
  paused, the admin's pause, the memory group off, and a stretch where the
  person wrote under 12 characters. Usage is recorded under the new
  **`memory`** role. Failures are WARN rows (never an alert email).
- **Explicit asks only, in the chat itself.** `memory_update(topic, text)`
  rewrites one note; `memory_view` re-reads them. The block and the tool
  description both say to use it ONLY when the person ASKS to remember,
  forget or correct — things mentioned in passing are for the pass. This
  wording is load-bearing: the first cut said "when they tell you something
  lasting" and the conversation model saved the whole intro itself mid-reply
  (the harness caught it: the pass then had nothing to do). Withheld
  (`ToolsetOptions.excludeTools`) when the person has paused; the block then
  says memory is paused so the model can say so.
- **`search_my_chats`** — Claude.ai's split: memory is a few notes, history
  is searched. Postgres full-text over the person's own + shared chats,
  never incognito, never the current chat; **ANY of the words, ranked by how
  many match** (`to_tsquery` with `|` and prefix matching) — the first cut
  ANDed the words (`plainto_tsquery`) and a model guessing "ailment sick
  unwell this week" found nothing when the chat said "hay fever". Returns
  dated snippets with `/chat/<id>` links; the model cites title + date. In
  the `memory` group; gated separately by the admin's **chatSearch** switch.
  No index yet — tens of ms over a few thousand chats; an expression GIN
  index is the next lever (Prisma can't express one, so it would be a
  hand-written migration and a drift to live with).
- **Guardrails** (`SENSITIVE_RULE`, in the pass prompt AND the tool
  description): health, religion, politics, sexuality, personal finances, ID
  or account numbers, criminal or immigration matters are never kept unless
  the person explicitly asks. **Controls:** per person — pause (keeps the
  notes, stops learning: `users.memory_paused`) and reset; per instance
  (Admin → Tools → User memory, `memory_config` = `{paused, topicChars,
  chatSearch}`) — pause for everyone, note size, chat search; on/off stays
  the `memory` group toggle. Incognito and shared chats never learn.
- **Settings → Assistant memory** (`user-settings-modal.tsx`,
  `/api/memory` GET/PATCH/DELETE/POST): the four notes as editable text with
  "updated Xm ago", the pause switch, "Forget everything", and the
  adjustment chat re-pointed at the two tools.
- **Proof:** `scripts/test-memory-v2.ts` (live, real model, real browser):
  a chat states job / preference / a dated decision / a health remark with
  no "remember" → the pass fills About you, How you like replies and Your
  work, keeps hay fever out, is idempotent, and bills the `memory` role; a
  new chat recalls it unprompted; "moved to sales — remember that" replaces
  rather than appends (status line shown); "forget my job" clears it; the
  ailment — never in the notes — is found by searching the earlier chat,
  with the status line and a link; incognito and shared chats are skipped;
  pause withholds the tool, the assistant says so, the pass skips; the
  settings panel shows, saves and resets notes; chat search off/on is
  reflected in the tools the model is offered. Unit:
  `memory-topics.test.ts` (10). Two harness lessons: the paced reveal keeps
  adding words after the stream ends, so a reply is only read once its text
  has been stable for a second; and the settings modal's lower buttons sit
  in a scroll box Playwright cannot bring into view — click them from inside
  the page (`$eval`).

### Sandbox agent tier (0.4.0) — `src/lib/agent/` + `src/lib/tools/sandbox-task.ts`

The full design record is **`docs/V04_AGENT_TIER.md`** (decisions, the
architecture diagram, every trap found live). The load-bearing facts:

- **What it is.** The old one-command sandbox (write_file / edit_file /
  delete_file / execute_command / run_script) was RETIRED. In its place, ONE
  tool — `sandbox_task` — hands a job to a full autonomous agent (the Claude
  Agent SDK, `@anthropic-ai/claude-agent-sdk`) running in the chat's own
  container; its inner steps stream into the chat as the SAME run blocks and
  status lines the old tools used (the bridge maps Bash→execute_command,
  Write→write_file, Edit→edit_file — those names live on only as the UI's
  vocabulary). `present_files` survives in the `files` group; the agent
  presents through its own host-side copy mid-run.
- **Where the pieces run.** The SDK harness runs in the Next server; only the
  `claude` process runs in the container, attached over ONE duplex HTTP
  request to sandboxd (`POST /sandboxes/:id/agent/attach`, `wire.ts`
  envelopes). So `canUseTool`, the host-side MCP tools and the audit trail sit
  outside anything the agent's code can reach. sandboxd is agent-tier only
  now; its boot sweep still reaps pre-0.4 containers carrying the label.
- **Owner decisions (locked):** a client CAPABILITY, off unless enabled, fully
  configurable on Admin → Tools (its own card); live from round 1 (NOT
  deferred — `disclosure.ts` CORE_EXCEPTIONS); steering says ~80% of
  substantive work goes through it (admin-editable text; escalate = hard
  reasoning, Sandbox = long iterative work); narration goes to the activity
  panel as status lines, never the reply prose; per-chat containers with a
  30-min idle TTL; the whole pool at `/workspace`; general-internet egress;
  the turn's hard stop STRETCHES to the agent's admin-set minutes while it
  runs and snaps back after (`extendTurnHardStop` / `resetTurnHardStop`).
- **Resume.** Every run's session id is saved on `conversations.agent_session_id`
  and the next run resumes it (`fresh:true` opts out), so "now make it blue"
  edits the same files. Transcripts live in a PER-CHAT state directory
  (`storage/<tenant>/agent/<id>` — a sibling of the pool, mounted at
  `~/.claude`), which persists across container recycling and dies with the
  chat. A Postgres session store was DROPPED: this already holds the property,
  and the SDK's store needs the container's `CLAUDE_CONFIG_DIR` to textually
  match the parent's or it drops frames — unverifiable on a Windows dev box.
- **Isolation (owner: work/personal/private never intermingle).** The CLI keys
  transcripts by cwd and every container uses `/workspace`, so ONE shared
  config dir would file every chat's history under one key. Per-chat state
  dirs; the ONLY shared thing is the sign-in, in a named volume
  (`opninfer-agent-config-<instance>`) mounted at `~/.claude-shared` and
  SYMLINKED in — a copy would strand a refreshed OAuth token in a container
  about to be reaped. `.claude.json` is deliberately not shared.
- **Two credential paths, opposite plumbing.** *Subscription* (the
  operator's own plan): the login lives in the volume, written by Anthropic's
  own flow (`./deploy.sh agent-login <instance>`; dev: `docker run -it --rm
  -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent
  claude`); OPNinfer never touches it — there must NEVER be a paste-your-token
  field. *Org API key* (client instances): the key never enters the
  container; the CLI is pointed at `/api/agent-proxy` (reached via
  `host.docker.internal` on the already-published app port; `AGENT_PROXY_BASE`)
  with a per-run bearer (`proxy-tokens.ts`), the proxy injects the key, passes
  SSE through and meters REAL usage off Anthropic's responses (the SDK's
  numbers are estimates Anthropic says not to bill from); `skipWebFetchPreflight`
  so nothing calls Anthropic directly. `buildAgentEnv` THROWS in API mode
  without a proxy — the raw-key fallback is impossible by construction.
- **The long-lived token — the cure for the eight-hourly sign-outs**
  (2026-09-07, owner ask: "it's annoying we get signed out all the time").
  The volume login above is a PAIR — an access token good for ~8 hours and a
  refresh token — and every chat container shares ONE copy through the
  symlink. At each expiry whichever chat runs next refreshes, Anthropic
  issues a new refresh token and KILLS the old one, and anything still
  holding the old one is signed out: a burst of failed runs and alert emails
  at every expiry, then quiet again. There is no safe fix while several
  containers share a rotating credential. `claude setup-token` (a
  subscription feature, present in the pinned CLI) mints a token that never
  refreshes, so there is nothing to race over.
  **`./deploy.sh agent-token <instance>`** runs that flow in the instance's
  credential volume, then asks for the token (hidden input), stores it
  **base64** as `AGENT_OAUTH_TOKEN_B64` in `instances/<name>.env`, drains and
  recreates just that app container, and CONFIRMS by asking the running app
  (`GET /api/admin/agent-credential`, deploy-token authed, three states:
  token · malformed · none) — the console's operator-account lesson applied
  before it could bite, since writing the file and even the value reaching
  the container both prove nothing about whether the app understands it.
  `agentOauthToken()` / `agentTokenSource()` in `agent/env.ts` are the only
  readers; `buildAgentEnv` sets `CLAUDE_CODE_OAUTH_TOKEN` in SUBSCRIPTION
  mode only (in API mode the proxy stays the sole auth), and the CLI prefers
  it over the credential file sitting right beside it — proven live, not
  assumed. Shape-checked rather than trusted: a value that arrived mangled
  reads as "malformed" and falls back to the volume login instead of being
  handed over to be rejected mid-run, and an `sk-ant-api…` key is refused
  outright (an org key in an agent environment is the one thing `env.ts`
  exists to prevent). The volume stays mounted — connected services' OAuth
  lives in the same file — and removing the line restores the old path.
  **The exception it makes, deliberately:** this is the only place OPNinfer
  asks for a plan credential to be pasted, and it is the HOST's own tooling
  writing a 0600 file beside the master key. The admin card still must never
  become a paste-your-token field; it only REPORTS which of the two is in
  use. **CONFIRMED COST, measured live 2026-09-07 the same
  day:** the CLI's "inference-only" warning is real — a long-lived token
  cannot read the plan's usage SCREEN, so the per-window percentages behind
  the Sandbox panel AND the 90% alert email stop arriving. Runs are
  unaffected. The evidence, because "a value did not change" is weak on its
  own: the post-token run DID update the five-hour window (its `observedAt`
  advanced) but recorded NO `percentUsed`, and left the seven-day window at
  its last pre-token value — i.e. `recordPlanUsageFrom` ran, merged the
  event-based floor, and got nothing from `fetchPlanUsage`. The control was
  run on the dev box against the SAME operator plan through the identical
  code path with the VOLUME login and no token: the event carried no
  percentage either, and the usage screen returned five_hour 22% /
  seven_day 15% — the 15% matching the figure already stored in production.
  So the screen read works, and the token is what blocks it. **Fixed the same day** (owner: "build that"):
  `refreshPlanUsageViaVolume` in `limits-store.ts` takes that ONE reading
  with the volume login while every real run stays on the token. Safe
  precisely because of the change it accompanies — the race needs two things
  refreshing one credential and now there is exactly one, this probe; a
  failed refresh can no longer wipe the file either. It runs only when a
  token is configured, only when the newest SCREEN reading has aged past 30
  minutes (`planUsageAge`, pure + tested — a reading counts only if it
  carries a `percentUsed`, since the per-request event usually does not),
  after a run and on Check sign-in (forced). Its own reserved conversation
  id, so it never tears down the sign-in check's container.
  **Two things it had to learn the hard way.** (1) An IDLE session is not
  enough: it answers the usage request in a second with
  `rate_limits_available: true` and `rate_limits: null` — the plan's windows
  only exist once the session has actually spoken to the API — so the probe
  sends one two-word prompt. A version that carefully avoided spending
  anything learned nothing, twice, and the second attempt (waiting for a
  `system` message that an idle session never emits) merely timed out for 60
  seconds first. (2) It retries once after 6s: the probe container is torn
  down the moment it is done and Docker's removal is not instant, so a
  second probe within a second or two lands on a container "marked for
  removal" and reads as "the plan told us nothing" — reproducible every time,
  and reachable in production by pressing Check sign-in just after a run.
  Alerts and the "Check sign-in" error now name the right repair (mint a new
  token, not run /login) and group under their own throttle key.
  **`agent-login` IS NO LONGER SUPPORTED, and none of its code was deleted**
  (owner decision, 2026-09-07, once all four instances were on tokens and
  proven: "agent-token we keep and continue supporting, agent-login we stop
  supporting and notes why but never delete the code itself"). What is wrong
  with it cannot be fixed here — a shared, refreshing credential and several
  containers is a race by construction — and a token has nothing to refresh.
  It stays because it is still the only way to do two things: MINT a token
  (`agent-token` runs Claude Code's own login flow through it) and sign a
  volume in for plan-usage readings. It works exactly as it always did and
  now prints why it should not be an instance's credential, pointing at
  `agent-token`; `test-deploy-functions.sh` asserts all three — that it warns,
  that it names the replacement, and that it still actually runs the login
  (deprecated must not quietly become gutted).
  **Plan-usage tracking went with it.** The volume probe
  (`refreshPlanUsageViaVolume`) is behind `AGENT_PLAN_USAGE_VIA_VOLUME=1`
  and OFF by default: with no volume sign-in on a normal box it would start a
  ~1 GB container after runs, twice an hour, to be told there is nothing to
  read. The code is kept and STAYS PROVEN — the live harness sets that
  variable, so the path is exercised rather than left to rot, and turning it
  back on is one variable plus one `agent-login`. Admin → Sandbox hides the
  numbers on a token and says why: what was left otherwise was a five-hour
  window correctly vanishing as stale beside a seven-day percentage frozen
  at whatever it was when the token went in, and a number that never changes
  reads as current, which is worse than none. The limit-reached alert still
  fires (it comes off the per-response event); only the 90% warning is gone.
  **Going the other way** — `./deploy.sh agent-logout <instance>` takes an
  instance off the plan entirely: it removes the token from the env file AND
  signs the credential volume out (`claude auth logout`), because leaving
  either behind means the instance is still quietly drawing on someone's
  plan. It does NOT delete the volume — connected services keep their own
  OAuth in the same file — verifies the sign-in is actually gone rather than
  assuming, and says plainly that the last step is not scriptable: which
  credential a Sandbox uses is a setting in that portal's own Admin →
  Sandbox, and one left on "Claude subscription" with nothing to sign in as
  fails its runs. Everything is already per instance (`instances/<name>.env`
  and `opninfer-agent-config-<name>`), so different portals can hold
  different plans with no further work.
  Proof: `scripts/test-agent-token.ts` (22 live checks through the REAL path
  — SDK → broker → the container's pinned CLI: an invalid token makes the run
  fail on auth WHILE a working volume login sits beside it, which is the only
  way to prove which credential was used; a run with no token still succeeds
  on that login; the endpoint's three states and that it never returns the
  token; and the plan-usage fallback returning a real percentage for every
  window while a token is configured, throttled, forceable) + 22 in
  `env.test.ts`/`limits.test.ts` + 18 in `test-deploy-functions.sh`.
- **A FAILED refresh BLANKS the credential file, and we used to copy that
  over the shared sign-in** (2026-09-07, found while building the above —
  this is what made the eight-hourly race STICK instead of healing). When the
  refresh fails, the CLI does not leave the file alone: it rewrites it with
  every field present and both tokens empty (538 bytes → 290, reproduced in
  the agent image). The broker's guard only asked whether the file contained
  `claudeAiOauth` — which that wreckage does — so the container that LOST a
  refresh race wiped the instance's sign-in for every other chat, and only
  `agent-login` fixed it. `sandboxd/credentials.mjs` (`isUsableCredential`,
  its own module so it can be tested — importing `index.mjs` opens the Docker
  socket and a listening server) now requires BOTH tokens non-empty, in the
  broker and in `cred-sync.sh`. Its Dockerfile lists broker files by name, so
  a new module must be added there too — `test-cred-sync.sh` derives the
  imports from the source and asserts each is COPYed, because an import that
  resolves in dev and is missing from the image takes the whole broker down
  at boot. Proof: 11 checks in `test-cred-sync.sh` (verified to FAIL on the
  old guard) plus two live ones in `test-agent-token.ts` — a blanked
  credential planted in a chat's state dir leaves the shared sign-in
  byte-identical and the chat still runs; on the pre-fix broker, rebuilt to
  check, the sign-in's hash CHANGED and the next run failed.
- **Usage (owner rules).** `usage_records.billing_source` (`api` |
  `subscription`), `notional_cost`, `agent_session_id`. Subscription rows cost
  $0.00 with the API-rate value kept as notional; the dashboard's average is
  over BILLABLE requests only, a strip shows plan usage as "$X saved", and the
  weekly report has an "On the Claude plan" section incl. rate-limit waits.
  Plan limits (five_hour / seven_day / per-model) render on the Sandbox
  page from TWO sources: the SDK's per-request `rate_limit_event` (status +
  reset time; it carries a percentage only near the limit — found live
  2026-09-02 with the plan at 10% and the panel empty) and, since that day,
  the plan's own usage screen via the SDK's `/usage` control data (real
  0–100 for every window, the numbers claude.ai draws), fetched after every
  subscription run and on "Check sign-in" (`recordPlanUsageFrom`,
  `parsePlanUsage` — pure, tested). The SDK method is marked experimental
  and will be renamed, so it is found by prefix (`usage*`) and every
  failure is silent: the event-based reading stays as the floor.
  **Plan alerts** (owner ask, same day): every reading runs `planAlerts`
  (pure, tested) — a window crossing **90%** and a window the plan
  **refuses** (rejected / 100%) each log ONE ERROR-level `agent` row
  ("Sandbox plan nearing its limit: Current session (90%+)" / "Sandbox
  plan limit reached: Weekly · all models"), which is what Admin → SMTP's
  error alerts email. The raised flags live on the snapshot (`alerted`),
  carry across readings of the same window (reset times within 5 minutes
  count as one window — the event rounds to seconds, the usage screen
  gives an ISO string, and an exact compare re-raised every alert), clear
  with hysteresis (warn below 85%, limit below 95%) and on roll-over.
  `scripts/probe-plan-alerts.ts` feeds fake readings (45 → 91 → 94 → 100 →
  100 + week 92) and prints exactly which rows landed; no mail without SMTP.
  **Test sends** (same ask): Admin → Sandbox → Plan usage has "Send test:
  90% warning" / "Send test: limit reached" (`sendTestPlanAlert` — the REAL
  wording via `planAlertEvent`, to the alerts address, subject prefixed
  `[TEST]` with an amber banner in the body), and Admin → SMTP's weekly
  "Send one now" is likewise marked TEST (only the scheduled Friday send is
  unmarked). The weekly report's "On the Claude plan" section gained
  Sandbox sessions · people, the plan's live reading ("Plan right now"),
  API fall-backs with their cost, and the week's most-installed packages —
  `test-weekly-report.ts` renders it to `logs/weekly-report-preview.html`
  (screenshot it with Playwright `setContent` to eyeball).
- **Permissions (`policy.ts`).** Workspace containment for writes is the one
  hard rule (a blanket allow let the agent write its deliverable to `/tmp`:
  task done, nothing in the pool, no error). Everything else is allowed —
  the container is the boundary. `AskUserQuestion` routes to the chat's own
  ask card and parks the run exactly like `ask_user`. Session-only Claude Code
  tools (cron, worktrees, messaging) are disallowed outright.
- **Stop and steer.** `interrupt()` travels OVER STDIN, so the input stream is
  held open for the whole run — a one-shot prompt makes the SDK send EOF 1ms
  later and a Stop can never land. Mid-run messages are PEEKED from the
  interject mailbox and fed to the agent as a copy; the pipeline still drains
  the mailbox between rounds and appends them as genuine user turns (relaying
  them inside the tool result made the model treat them as injection). A turn
  stopped before any prose is saved with `meta.stopped` and replayed as a
  note (`STOPPED_TURN_NOTE`) — dropping it made the next message restart the
  stopped job.
- **Design work is BUILT, not generated** (2026-09-02, owner: "the LLM is
  using image generation, not creating editable graphics"). The
  `skills/design-graphics` skill (its L1 line is visible every turn) makes
  the model ASK ONCE per chat via the `ask_user` card — "Build it properly
  (recommended)" vs "Quick AI concept image" — then hand the build to the
  Sandbox with "use your design-graphics skill". The agent writes HTML/CSS
  at an exact size from the skill's table and renders with **`html2png`**,
  a Playwright/Chromium renderer baked into the sandbox image
  (`docker/sandbox/html2png.py`; `--pdf` for print); the sources stay in the
  workspace so "make it blue" edits the same file. The image tools'
  descriptions and the MORE TOOLS `image` line now say photos/illustrations
  ONLY. **The agent sees the same skills as the assistant**:
  `agent/skills-sync.ts` mirrors `skills/` into the chat's state dir
  (`~/.claude/skills`) before every run and the SDK is given
  `settingSources: ["user"]` — without that the CLI loads no skills at all.
  Live proof `scripts/test-design-graphics.ts` (16 checks: the card, both
  options, build recommended, Sandbox + skill + renderer used, four
  1080×1080 PNGs presented inline with the HTML kept, ZERO image-generation
  calls, then the install tally on the admin page). The first cut skipped
  the question — the model read "ask which route" as the forbidden
  permission ask — so the skill now says in terms that it is a fork between
  two different deliverables and mandatory on the first design request.
- **The sandbox image is fat on purpose and TRACKS what it lacks**
  (2026-09-02, owner ask). `docker/sandbox/Dockerfile` bakes the common
  Python/Node libraries, fonts (Inter/Roboto/Noto incl. colour emoji…),
  Chromium and OCR (sandbox 6.06 GB, agent 6.92 GB). `manifest.py` writes
  `/etc/opninfer/packages.json` from the INSTALLED state at build (never a
  hand-kept list); sandboxd serves it at `GET /packages` by reading it out
  of a throwaway container from the agent image, cached per image id. Every
  shell command the agent runs goes through `agent/packages.ts`
  (`extractPackageUses`, pure, 16 tests) — pip/npm/apt/gem/cargo/go
  installs, curl/wget hosts, git clones — into the `agent_package_uses`
  table (migration `20260902120000`), and Admin → Tools → "What the agent
  reaches for" lists the top ones over 30 days marked **in image / not in
  image**, which is how the next bake-in gets decided. A `2>&1` once
  tallied as a package called "2" — redirections are dropped in the
  tokeniser now.
- **The shared sign-in must be SYNCED BACK after every run** (2026-09-02,
  found live — see the OAuth gotcha in *Conventions*). `sandboxd/cred-sync.sh`
  runs at container start and after each run; `scripts/test-cred-sync.sh`
  (6 checks) runs that exact file inside the agent image.
- **Subscription failure fails over, and emails** (2026-09-02): a run that
  finds the plan spent or the sign-in gone is logged at ERROR level (the
  alert emails watch that) and re-run on the card's **Fallback key** through
  the proxy, with a status line in the chat. Classifier in `agent/policy.ts`;
  live proof `scripts/test-agent-failover.ts`. Details under *Status*.
- **Admin "Check sign-in" probes INSIDE a container**, never the host — the
  host-side version reported the developer's own login while the container
  was signed in as someone else. `account-check.test.ts` pins this against
  the source, since no output assertion could catch it. **And it makes a
  REAL request** (2026-09-04, found in production): `accountInfo()` only
  reports what the CLI has STORED, so a sign-in whose refresh token
  Anthropic had rotated (the cloned-host trap) read "Signed in" all day
  while every run failed over to the org key. The probe now sends "Reply
  with exactly: OK", judges the outcome with `classifySubscriptionFailure`
  (the runs' classifier), and on `signed_out` writes the SAME error row a
  failing run writes (so the alert throttle groups them) and says the
  token has expired or been rotated; a plan at its limit is a warning
  under "Signed in". Pinned by two more source tests; live-proven on the
  dev box both ways (signed in: "a test request went through"; sign-in
  moved aside: the honest error + the error row).
- **Connected services (MCP) — per instance, signed in inside Claude Code**
  (2026-09-03, owner ask: "only one portal gets the Figma MCP, auth'd in Claude
  Code directly, not jerry-rigged — a setup command like the login one").
  `./deploy.sh agent-mcp <instance> add figma https://mcp.figma.com/mcp`
  then `./deploy.sh agent-mcp <instance> login figma` (also `list` /
  `remove` / `logout`) are thin wrappers over Claude Code's OWN commands —
  `claude mcp add --transport http -s user` and `claude mcp login
  --no-browser` — run inside THAT instance's credential volume
  (`opninfer-agent-config-<instance>`), so only that instance's agents get
  the service. The login is the service's own OAuth flow, headless: it
  needs a TTY (`-it`), prints a URL, the browser lands on
  `http://localhost:<port>/callback?code=…` showing a connection error, and
  the FULL address is pasted back. **The source of truth is Claude Code's
  own config in the volume** — `.claude.json` (user-scope `mcpServers`) and
  `.credentials.json` (`mcpOAuth`, the same file the Claude sign-in lives in,
  symlinked into every chat and synced back by `cred-sync.sh`, so a refreshed
  Figma token is carried like the Claude one). Nothing in the DB, no token
  through the app, and never a paste-a-token field — the rule the Claude
  sign-in already follows. Dev equivalents are the `docker run … opninfer-
  agent claude mcp …` forms the admin panel prints.
  How the app learns it: sandboxd `GET /agent-mcp[?fresh=1]` reads both
  files out of a throwaway container from the agent image with the volume
  mounted READ-ONLY and reduces every token to a boolean; `agent/mcp-store.ts`
  caches it 5 min stale-while-revalidate (a turn never waits on the read;
  Admin → Sandbox passes `fresh`, so that page load is what surfaces a
  just-run `add`). `sandbox_task` passes the READY servers (signed in, or a
  fixed Authorization header, or a local command) through the SDK's
  `mcpServers` beside `opninfer`, with `strictMcpConfig` kept ON — the
  agent's own code can write the workspace, so a `.mcp.json` there must
  never count. The tool description and the agent's system append name the
  ready services, so the conversation model routes "look at my Figma file"
  to the Sandbox instead of saying it has no access; their tool calls read
  "Using Figma: get design context" in the activity panel (`mcpToolLabel`).
  **THE KEY-HASH TRAP:** the CLI finds a stored token by
  `<name>|sha256(JSON.stringify({type, url, headers: headers || {}}))[:16]`
  — `mcp.test.ts` pins that against the key observed live
  (`figma|d39d3b6252bc1ac5`). `sdkMcpServers` therefore passes exactly
  type/url/headers and nothing else; add a header, normalise a slash, and
  the sign-in silently reads as missing. Admin → Sandbox → **Connected
  services** lists each server with its sign-in state and a **Check
  connections** button that boots the CLI in the probe container with ALL
  the servers and reports `mcpServerStatus()` (connected / needs-auth /
  failed) — the CLI's word from inside the container, not a guess from a
  file. Live proof `scripts/test-agent-mcp.ts` (17 checks: the real `claude
  mcp add` into the real dev volume → broker → app reader → page → the CLI
  spawned with `--mcp-config {"figma":{"type":"http","url":…}}` reporting
  `needs-auth` → the real `remove`). The signed-in half (`connected`, then a
  chat that uses Figma) is the owner's live test on a real portal — this box has no
  Figma login. **A subscription login also carries the account's claude.ai
  connectors** (`claude mcp list` in that volume shows the operator's Gmail
  and Calendar) — proven NOT to reach a run: with `strictMcpConfig` the
  CLI's init message lists only the servers we pass (probed live in production,
  2026-09-04, with and without the run's env hygiene vars: `mcp_servers:
  [figma]`, no `mcp__` tools at all). Keep strict mode on for that reason
  alone — a client's chat must never see the operator's inbox. **Two more
  locks, same day** (owner: "want to be sure they don't get added
  automatically… and do we get emails if the link breaks?"):
  `decideToolUse` now takes the run's allow-set (the ready servers) and
  REFUSES any `mcp__<server>__*` tool from a server not set up for the
  instance, whatever the CLI loaded — a CLI update that changed strict mode
  could not leak a connector (`policy.test.ts`). And at the end of every run
  (and from Check connections) `mcpServerStatus()` is judged by
  `classifyMcpStatuses` → `reportMcpHealth` (`agent/mcp-health.ts`): a
  signed-in service the CLI could not use logs ONE ERROR-level `agent` row
  with stable wording (`Sandbox connected service "figma" is signed out —
  …`; details carry the fix command) — exactly what Admin → SMTP's error
  alerts email, throttled like any other — plus a status line in the chat
  ("The figma connection is signed out — the admin has been alerted"); a
  server the CLI reports that was never set up here is a WARN row and a red
  line on the panel (the tripwire). Harness-proven (`test-agent-mcp.ts`, 25
  checks): a bogus token planted in the dev volume makes the reader believe
  figma is signed in, the CLI says needs-auth, the error row lands naming
  `login figma`, no unexpected server, credentials restored byte-for-byte.
  En route: `fetchImagePackages` read a `SANDBOX_URL` variable
  nothing sets, so the image manifest was "unavailable" on every production
  admin page; both readers now go through `agent/broker.ts`
  (SANDBOX_BROKER_URL).
- **Harnesses:** `test-sandbox-long-run.ts` (a run longer than five
  minutes survives — the broker timeout gotcha), `spike-agent-sdk.ts`, `spike-agent-container.ts` (17),
  `test-agent-capability.ts` (20), `test-sandbox-task.ts` (20 — the user
  story incl. resume ACROSS a container recycle, Stop <1s, no restart of a
  stopped job), `test-agent-proxy.ts` (15, real spend). Re-pointed to the
  agent and green: present-files, output-limit, tool-rounds, interject,
  activity-interleave, stream-resume, edit-revert, admin-chats, what's-new,
  deploy-drain, usage-summary, weekly-report. Every harness honours
  `TEST_BASE_URL` (dev runs plain http on :3000).

### Branding

Customise sets an uploaded portal logo + light/dark accent colours.
`getBranding()` feeds the root layout, which injects accent CSS variables and
provides the logo to `<BrandLogo>` (falls back to the default mark). Branding
images are served from `/api/branding/[name]` (PUBLIC, so the logo loads on the
login screen). The assistant's own name + logo are separate (assistant config).

## Conventions & gotchas

- **pnpm via corepack** (not global). pnpm 11 gates native build scripts — allowed
  packages are listed under `allowBuilds:` in `pnpm-workspace.yaml` (NOT
  `package.json` `pnpm.onlyBuiltDependencies`, which pnpm 11 ignores). Currently
  allowed: sharp, prisma family, esbuild; `@google/genai` + `protobufjs` are
  explicitly `false` (their build scripts aren't needed).
- **`instrumentation.ts` is compiled for the Edge runtime too** (middleware runs
  there), so a Node-only import reachable from `register()` breaks EVERY route
  with `Module not found: Can't resolve 'path'`. Keep Node-only startup in
  `instrumentation-node.ts` and import it ONLY inside
  `if (process.env.NEXT_RUNTIME === "nodejs") { await import(...) }` — the exact
  positive-guard shape Next tree-shakes out of the edge bundle (an inverted
  `!== "nodejs" return` is NOT recognised). `archiver` (Node `path`/`fs` +
  dynamic requires) is additionally in `serverExternalPackages` (`next.config.ts`)
  so webpack leaves it a native require instead of bundling it.
- **Manual harnesses that import `server-only` modules** (e.g. `src/lib/backup.ts`)
  can't `import` under plain `node`: `server-only` is a transitive of Next and
  isn't resolvable at the repo root under pnpm. Run them with the loader shim —
  `node --import tsx --loader ./scripts/shim-server-only.mjs …` (see
  `scripts/test-backup.ts`).
- **PowerShell noise:** running pnpm via the PowerShell tool wraps pnpm's stderr
  banner as a "NativeCommandError" — cosmetic. Check the exit code for real failure.
- **The root layout is `force-dynamic`** (`src/app/layout.tsx`) — it reads admin
  branding from the DB on every route, so the whole app renders dynamically and
  `next build` never prerenders a DB call against the dummy build-time database
  (that failure hid behind the pnpm-setup one until CI got past install).
  DB-reading pages also individually set `export const dynamic = "force-dynamic"`.
- **NEVER infer "the model isn't thinking" from an omitted `thinking` param,
  and never let a provider default set the output ceiling.** Anthropic's
  non-thinking default here was `max_tokens: 4096`, on the assumption that
  omitting `thinking` meant standard mode. **Claude Sonnet 5 runs adaptive
  thinking BY DEFAULT when `thinking` is omitted** (changed from Sonnet 4.6),
  so thinking silently consumed that 4096 budget and every substantive turn
  was truncated — the model was cut off mid-tool-call, so the file it kept
  promising could never be written. It cost a real user (chat baf29809,
  2026-07-29) four rounds of asking, ~£0.97, and produced nothing; the model
  then confabulated "tool access has been cut off" because it can't see its
  own truncation. **Nothing errored or alerted** — a truncated response is a
  perfectly successful API call with `stop_reason: max_tokens`. The tell in
  the data is `output_tokens` pinned at exactly the ceiling across several
  turns. Now: one instance-wide ceiling from `src/lib/limits.ts` applied in
  `runRole` for every provider/model/reasoning combination, defaulting to 64k.
  Regression: `limits.test.ts` pins the defaults (incl. an explicit
  "not 4096" assertion in `scripts/test-output-limit.ts`).
- **One `DATABASE_URL`, two consumers with different rules.** `deploy.sh`
  generates it with Prisma's pool tuning
  (`?schema=public&connection_limit=15&pool_timeout=20`). Prisma understands
  those; **libpq does not** and refuses the whole connection with
  `invalid URI query parameter: "schema"`. The Python worker shares that same
  URL, so in production it never connected once — 8 days, zero files ingested,
  while the app (Prisma) was perfectly healthy. Dev never saw it because
  docker-compose.dev.yml hands the worker a bare URL. `worker/app/dburl.py`
  (`libpq_url`, pure + unit-tested — `python -m unittest discover worker/tests`)
  now strips Prisma-only params and translates a non-default `schema` into
  libpq's `options=-c search_path=…`. **Anything else that ever reads
  DATABASE_URL outside Prisma must go through it.**
- **The worker runs as root, the app runs as `node` (uid 1000).** The app image
  chowns `/app/storage` to `node`; the worker container has no `USER`, so
  anything it creates lands root-owned — including each pool's hidden
  `.opninfer/` artifacts dir. The app then can't delete those on chat deletion
  and the pool leaks. `worker/app/artifacts.py` `_match_pool_owner` chowns new
  artifacts to match their pool dir (best-effort: no-op on Windows/non-root),
  and `deleteChatPool` now `console.warn`s instead of swallowing the failure
  silently. **Any new worker-side write into the storage tree needs the same
  treatment.**
- **A chat's pool directory must EXIST before the sandbox mounts it.** Uploads
  and `write_file` create it as a side effect of writing; `execute_command` /
  `run_script` only MOUNT it. In production the mount is a named-volume
  **subpath**, and Docker refuses to start a container whose subpath is
  missing — so a chat whose first sandbox action was a command (a natural
  opening move: "what tools do I have?") could never start a sandbox at all.
  Worse, sandboxd's `ensureContainer` caught the failed `start()` and fell
  through to `createContainer`, which then **409'd on the leftover name** for
  every retry until the 60s idle reaper cleared it. Live 2026-08-03, chat
  cc76d609: four failures in a row, user got nothing. Fixes: `ensureChatPool`
  (storage.ts) is called by `brokerExec` before any broker request, and
  sandboxd now REMOVES a container it couldn't start. **Dev cannot reproduce
  this** — `STORAGE_HOST_ROOT` is a BIND mount and Docker auto-creates a
  missing bind source, so the identical chat works locally and fails in prod.
  Regressions: `storage.test.ts` (5) + `scripts/test-sandbox-cold-chat.ts`
  (6 — cold chat, no uploads, command first).
- **Dev gotcha found the same day: a stale `openinfer-*` container can silently
  mount the WRONG path.** The local sandboxd container was created 2026-07-01
  with `STORAGE_HOST_ROOT=…/OpenInfer/storage`; the checkout was renamed to
  `OPNinfer` on 2026-07-20, so it had been mounting an auto-created empty
  directory ever since — commands "worked" but the workspace was disconnected
  from the app's real pool. If local sandbox behaviour looks impossible, check
  `docker inspect <sandboxd> --format '{{.Config.Env}}'` before debugging the
  code. Recreate with `docker compose -f docker-compose.dev.yml up -d --build
  sandboxd`, and note the fat image must exist locally as `opninfer-sandbox`
  (`docker build -t opninfer-sandbox -f docker/sandbox/Dockerfile
  docker/sandbox`) — deploy.sh builds it in prod, nothing builds it in dev.
- **`deploy.sh` runs `set -euo pipefail` — every helper must tolerate failure.**
  A `grep` that matches nothing exits 1, `pipefail` propagates it out of the
  command substitution, and `set -e` kills the DEPLOY. That shipped for real
  in v0.3.2: `drain_instance` read `OPNINFER_DEPLOY_TOKEN` with a bare grep,
  so on any instance created before draining existed (i.e. every live one) the
  update died at "Deploying instance '<name>'…" — images built, containers
  never recreated, production silently left on the old version while the
  script simply vanished. The function whose whole purpose was "no-op when
  there's no token" was the thing that aborted. Rules now: `|| true` on any
  pipeline that may legitimately find nothing or talk to something that isn't
  up; `case` guards instead of `[ -eq ]` on values that might not be numeric;
  and `|| true` at the CALL SITE for anything optional, so a nicety can never
  block the actual update. Regression: `bash scripts/test-deploy-functions.sh`
  (extracts the real functions out of deploy.sh — no copy to drift — and runs
  them under the same shell options; verified to FAIL on the pre-fix code).
- **`chown -R` in a Dockerfile is never cheap.** A chown rewrites every file it
  touches, so the layer it produces is a full second copy of everything below
  it — paid again in export, unpack, push and disk. `RUN chown -R node:node
  /app` cost 143.8s of a 385s production build and 154 MB of image. Set
  ownership with `COPY --chown=…` (free — it happens during the copy) and chown
  only the specific directories the runtime writes to. The same applies to any
  recursive `RUN` over the app tree (`chmod -R`, `find -exec`).
- **A lexical path guard is not a guard when something else can write to the
  directory.** `poolPath` stripped `..` and prefix-checked `resolve()`, which is
  string arithmetic — `resolve` never touches the disk and never follows a
  symlink. The sandbox mounts the same pool read-write as the same uid, so code
  the model runs could leave a link there and the host-side `write_file` would
  follow it out as the APP user (into `/app`, another chat's pool, anywhere).
  Any path built from an untrusted name and then OPENED needs
  `poolContainmentError` (realpath + refuse a symlinked target), not just the
  lexical check. See `pool-containment.test.ts`.
- **A plain FILE the server reads at runtime must be COPYed in the Dockerfile.**
  The Next standalone build traces JS imports; it ships nothing else, so a
  `readFile` of something like `CHANGELOG.md` works perfectly in dev and
  throws in production. Worse, the natural handler catches that as "no notes
  yet", so the What's new panel would simply be empty forever on every live
  instance with nothing in any log to find. `Dockerfile` copies it explicitly
  (next to the same COPY for `skills/`, which exists for the same reason) and
  `src/lib/changelog.test.ts` asserts the COPY line, because the failure has
  no symptom you would go looking for. Any future runtime-read file needs both.
- **The standalone build does not ship the Agent SDK's CLI binary.** The
  Sandbox passed every dev harness and failed on its FIRST production chat
  (2026-09-02) with "missing CLI binary": Claude Code is a native binary in a
  platform package (`@anthropic-ai/claude-agent-sdk-linux-x64` on the
  servers) that the SDK resolves BY NAME at runtime, so Next's tracer never
  copies it — the production app container had no `@anthropic-ai` directory
  at all. `next.config.ts` now lists the SDK in `serverExternalPackages` and
  adds `outputFileTracingIncludes` for the pnpm store's
  `@anthropic-ai+claude-agent-sdk*` packages; `standalone-trace.test.ts`
  reads the config because nothing outside a standalone build can fail. The
  admin "Check sign-in" card reported this as "Not signed in" — it now logs
  and shows the underlying error. To prove the fix without a deploy: build
  the runner image and run the SDK with a fake `spawnClaudeCodeProcess`
  inside it (see the 2026-09-02 verification in *Status*).
  **The glob must end `sdk@*`, not `sdk*`** (2026-09-05): the loose form
  also matched the platform package's OWN pnpm store directory
  (`@anthropic-ai+claude-agent-sdk-linux-x64@<version>`), and because the
  tracer DEREFERENCES pnpm's symlinks it wrote the 327 MB binary twice —
  once inside the SDK's store directory, once standalone — for ~0.44 GB of
  app image (1.45 GB → 1.01 GB). Only the nested copy is ever used: node
  resolves the platform package by walking up from the SDK's own file to
  the sibling `node_modules/@anthropic-ai/` scope. Verified in a real built
  image before shipping, because a dangling symlink here would break the
  Sandbox exactly as the missing binary did: one `claude` of 342,636,848
  bytes, a REGULAR file and executable (not a link), `require.resolve` from
  the SDK's directory landing on it, and the SDK module itself loading.
- **Agent SDK gotchas (0.4.0 — each cost a debugging round, all pinned by
  tests or comments):** a bare tool name in `allowedTools` auto-approves that
  tool for ANY path before `canUseTool` runs (path scoping = `acceptEdits` +
  the callback, never the allowlist); the SDK silently rejects a generator
  FUNCTION as a prompt — pass the invoked generator — and reports it as
  "aborted by user"; `cwd` is the CONTAINER path; `interrupt()` rides stdin
  (hold the input stream open); `Options.env` REPLACES the child env (build it
  explicitly — `buildAgentEnv`); a `spawnClaudeCodeProcess` result must be a
  real EventEmitter (a hand-rolled listener table threw on an unanticipated
  event name, inside SDK setup, and surfaced as a silent abort); a returned-
  but-not-awaited handler promise in sandboxd escaped its try/catch and took
  the WHOLE BROKER down; a `--mount` tmpfs is root-owned 0750 (use 1777) and a
  fresh named volume is initialised from the IMAGE's directory (pre-create
  `~/.claude` owned by uid 1000). On Windows a Linux symlink on a bind mount
  is invisible to host `lstat` — check from inside a container. `DEBUG_CLAUDE_
  AGENT_SDK=1` writes the SDK's own transport log (path printed to stderr).
- **A test that shells out to `ls -R` on Windows runs under cmd.exe and
  compares two empty strings** — it passed while checking nothing. Walk with
  `node:fs`, and make a containment check FAIL if either tree is empty.
- **The agent's code preview only streams if the CLI is TOLD to stream tool
  input.** Owner report 2026-09-02: "the code appears all in one go" — and a
  first harness "proved" it live because it counted the empty block appearing
  as an update. The decisive probe (`scripts/probe-agent-code-stream.ts`,
  browser timings AND the chat route's per-run `run_code timing` dev.log
  line) showed the truth: block starts, **14.9 s of silence, then 612 deltas
  in 236 ms** — buffered upstream of us. The CLI's model table enables
  `eager_input_streaming` by default only for Bedrock/Vertex; for Anthropic
  direct it is gated on `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`,
  which our host-env strip would never pass through. `buildAgentEnv` sets it
  explicitly now (pinned by `env.test.ts`); the same probe then read 26
  deltas spread over 13.6 s with the first 1 ms after the block started.
  Same failure class as the 2026-07-19 `eager_input_streaming` fix on the
  provider side: **never infer "it streams" from the events existing — time
  their arrival.** `test-agent-run-ux.ts` now asserts the first content
  arrives within 3 s of the block appearing.
- **A re-presented file under the same id shows the OLD image until a
  reload** (owner bug 2026-09-02: the recoloured design). `Cache-Control:
  no-store` was already on the file route and made no difference — the
  browser's in-page image cache keys on the URL alone. Image URLs now carry
  `?v=<file mtime ms>` (`GenImage.version`, stored in `meta.images`, stamped
  at present time from the file's mtime rather than the row's `updatedAt`,
  which lags: `present_files` fires mid-run and `syncPool` only re-syncs the
  row after the agent finishes). Generated images use "now".
- **A refreshed OAuth token written through a symlink does not land where
  the symlink points.** The plan's access token expires every ~8 hours; the
  CLI refreshes it and writes the new pair with a temp file + rename, which
  REPLACES the `~/.claude/.credentials.json` symlink with a regular file in
  that chat's state dir. The shared volume keeps the old pair — and Anthropic
  ROTATES refresh tokens, so the next chat's refresh fails ("OAuth session
  expired and could not be refreshed") and every run fails over to the API
  key, with an alert email each time. Nothing in the app is wrong when this
  happens; the sign-in simply stopped being shared. `sandboxd/cred-sync.sh`
  copies a newer regular file back to the volume and re-links, at container
  start and after every run. If it ever recurs, the recovery is
  `./deploy.sh agent-login <instance>` (dev: the `docker run -it … claude`
  login) — a rotated refresh token cannot be recovered from anywhere.
  **A CLONED VM carries a stale refresh token** (2026-09-04, found while
  hunting API spend): the new node was a clone of the old one, the old one
  kept running (and refreshing) until the cut-over, so the clone's shared
  sign-in held a refresh token Anthropic had since rotated. First run on the
  new box at 10:46 → "signed out" → every Sandbox run that day failed over
  to the org key: **307 calls, $15.10 in one day**, an alert email each
  time. Same recovery (`./deploy.sh agent-login`); rule: **after any clone
  or restore of the host, re-run the login before users touch the
  Sandbox** — the failover is a floor on outage, not a free ride, so an
  admin who sees that email should act the same day. **The rotation race is
  the disease, and the blanked-credential sync-back was what made it
  chronic** (both settled 2026-09-07): a long-lived token
  (`./deploy.sh agent-token`) removes the refresh entirely, and a failed
  refresh can no longer overwrite the shared sign-in — see the two bullets in
  *Sandbox agent tier*. Also found: the app's
  own backup-restore had written the 13 per-chat `.credentials.json`
  SYMLINKS back as 60-byte regular files holding the link target as text
  (an archive from before `addStorageTree` recorded the links; the
  extractor writes them as files). Harmless only by luck — `cred-sync.sh`
  copied any NEWER regular file over the shared sign-in, and those were
  three minutes older. It now refuses a file without `"claudeAiOauth"`
  (`test-cred-sync.sh` case 2b).
- **Version pin:** the agent image's `CLAUDE_CODE_VERSION` must equal the CLI
  the installed SDK bundles (`node_modules/@anthropic-ai/claude-agent-sdk/
  manifest.json`). Bump `package.json` and `docker/agent/Dockerfile` together;
  `version-pin.test.ts` fails otherwise. Rebuild the image, not just the app.
- **Don't broaden `.gitignore` to a bare `logs` / `build` / `dist`** — a bare
  `logs` rule matched `src/app/admin/logs/**` and silently kept the Logs admin
  feature *out of the repo*. Log-output ignores are anchored (`/logs/`).
- **A tie on `created_at` is broken by whatever Postgres's sort does that
  day — never `ORDER BY created_at` alone on messages** (2026-09-10, the
  root cause of the $2-a-message chat). Open WebUI stamps a question and its
  reply with the same SECOND, so every imported chat has tied pairs (661 and
  1,609 chats on two real portals). On a table whose physical order is no longer time
  order — every portal, after enough page reuse — the plan is a real
  quicksort, which put the reply FIRST in 36 of one chat's 74 tied pairs and
  a different 36 on every turn (reproduced on the dev box with the production
  plan and a scrambled insert: ~300 of 600 positions moved per appended
  row). The model read a shuffled history each time, the prompt cache never
  matched, and the whole 525k tokens was re-written at 1.25× on every
  message; users saw the same shuffle on screen. Fix: `orderThreadRows()` in
  every loader (chat-turn, chat-view, the admin viewer, feedback, export,
  rename-with-AI, the memory pass), `strictlyIncreasing()` in the importer,
  and the millisecond repair migration. The dev-box probe with a CLEAN
  insert order was stable and would have "disproved" this — the physical
  order is the variable, so reproduce with scrambled rows.
- **A request held open for the life of a run hits Node's FIVE-MINUTE
  `requestTimeout`** (2026-09-10, found in production nine days after the
  agent tier shipped). A Sandbox run is one HTTP request to sandboxd whose
  BODY is the CLI's stdin, so Node never sees it as "fully received"; since
  v18 the http server closes such a request after 300 s (checked every 30
  s). Every run longer than that died at 5:00–5:30, mid-command — SIGKILL on
  the command (exit 137 in the agent's transcript), the container torn down,
  the model told "the run did not complete" and starting another — and
  NOTHING was logged, because the only record was a `devLog`. The owner's
  chat lost two runs to it (5m10s and 5m22s, stuck on a browser download
  that hangs because Microsoft's download host now answers 400); three other
  people's cut-off runs that week match. `sandboxd/index.mjs` now sets
  `server.requestTimeout = 0` (pinned from the source by
  `broker-server.test.ts`); the admin's `maxMinutes` is the one budget. Any
  future long-lived REQUEST (a streamed upload, another attach-style
  bridge) on a Node server needs the same line — the response side (SSE)
  was never affected. Two things rode along: the agent's prompt says
  Chromium is already installed (`PLAYWRIGHT_BROWSERS_PATH`) and never to run
  `playwright install`; and a run that does not complete writes a WARN
  `agent` row, "Sandbox run did not complete", so Admin → Logs shows it.
  Proof: `scripts/test-sandbox-long-run.ts` — a six-minute command through
  the real broker, verified to FAIL on the old one.
- **A browser fetches a web manifest and its icons with CREDENTIALS OMITTED**
  (2026-09-14, caught while building the PWA — by design, not by accident).
  Left inside `middleware.ts`'s auth matcher, `/manifest.webmanifest`,
  `/sw.js` and `/api/pwa/*` each answer a signed-out browser with the LOGIN
  PAGE'S HTML; the browser then parses a manifest that is not one, declines to
  offer "Install", and logs nothing anywhere — the app simply never becomes
  installable and no screen says why. All three are in the matcher's exclusion
  list, pinned from source by `pwa.test.ts`, and they expose only the logo and
  assistant name the login screen already shows to anyone. A service worker
  additionally needs a **secure context** — HTTPS or localhost, exactly like
  the mic and `crypto.randomUUID` — so none of this exists over a plain-http
  LAN address, which is a normal dev state and not a bug to chase.
  Two more, from the same build: **Next 15 no longer emits
  `apple-mobile-web-app-capable`** — `appleWebApp: { capable: true }` renders
  only the modern `mobile-web-app-capable`, so iOS before 16.4 (which does not
  read `display` out of a manifest) opens in Safari's chrome unless the
  apple-prefixed tag is written by hand in `metadata.other`; found by reading
  the rendered head, which is the only place it shows. And **`public/` must
  stay COPYed in the Dockerfile** (it is, line ~92): the worker is served from
  there and the default icon is READ from there, so losing that line 404s the
  worker and 500s every icon — in production only, like CHANGELOG.md.
- **`localhost:3000` is not necessarily THIS project** (2026-09-09). A harness
  pointed at it spent a debugging round on a `/login` that redirected to
  `/setup`, because the port was serving a DIFFERENT checkout (`OPNmesh`)
  whose database has no users. Harnesses should start their own server on
  their own port and `NEXT_DIST_DIR` (see the gotcha above) rather than
  assuming the owner's dev server is up, is this app, and is warm.
- **A fixed wait after a sign-in is a lie on a cold server** (2026-09-09).
  `test-temp-password.ts` waited 2.5s and then asserted the URL had left
  `/login`. Against a long-warm dev server that is ample; against a freshly
  started one the redirect target still has to compile, so it reported "the
  admin signs in: FAIL" for a sign-in that had SUCCEEDED — and nothing
  contradicted it, because a successful sign-in writes no log row (only
  failures do). Two hypotheses were tried and disproved first (route warming,
  the hydration race); what settled it was the ABSENCE of a failed-sign-in row
  for that account. Wait for the outcome — left /login, or a message on the
  form — never for a stopwatch.
- **Two traps when a harness inspects `logs/dev.log` or drives an admin form**
  (both cost a debugging round on 2026-07-30). (1) The log is UTF-8 and full
  of multi-byte glyphs (the `→` in every LLM line), so to read "everything
  since I started", capture `stat().size` and slice the **Buffer** —
  `string.slice(byteOffset)` overshoots and silently drops the run you're
  looking for. (2) Playwright's `fill()` can land BEFORE React hydrates: the
  DOM value changes, no onChange listener exists yet, component state never
  moves, and a dirty-gated Save button stays disabled forever. Re-fill until
  the button enables (see `typeInstructions` in `scripts/test-system-prompt.ts`)
  — the same hydration race the Admin → Logs harness hit with clicks.
- **Diagnosing "X is broken": read `logs/dev.log`.** `src/lib/dev-log.ts` is a
  verbose file firehose of every request in, every LLM call (model, tokens,
  timing, message previews — base64/secrets redacted), every tool call +
  result/error, uploads, and all `appLog` events (which tee into it). Dev-only
  (gated on `DEV_LOG` / non-production), git-ignored, serial write queue (no
  interleave), auto-rotates past 20 MB. `grep`/`tail` it after a failure
  instead of guessing. Distinct from `appLog` (curated, DB-backed Admin→Logs).
- **CI pnpm setup:** `pnpm/action-setup@v4+` errors ("Multiple versions of pnpm
  specified") if the workflow passes a `version:` input AND `package.json` has a
  `packageManager` field — pass neither; it reads `packageManager` (pnpm@11.9.0).
  The GitHub actions are pinned to their Node-24 majors (checkout v7, setup-node
  v6, upload-artifact v7, pnpm/action-setup v6).
- **Prisma `Bytes` write:** pass `new Uint8Array(encrypt(x))`, not the raw
  `Buffer` (TS rejects `Buffer` for the `Bytes` column under strict types).
- **Theming:** colours are CSS custom properties in `globals.css` (`:root`/`.dark`),
  exposed to Tailwind via `@theme inline`; `@custom-variant dark` maps `dark:` to
  the `.dark` class. The palette tracks Open WebUI (cool neutrals + slate accent);
  primary/send buttons are monochrome.
- **An iframe must declare the same `color-scheme` as the page, or the
  browser paints an OPAQUE canvas behind it** (owner bug 2026-09-04: inline
  visuals in dark mode sat on a white panel with light, unreadable text; the
  model's SVG was clean). `globals.css` sets `color-scheme: dark` on
  `html.dark`; the viz frame's srcdoc said nothing (= light), and CSS Color
  Adjust says a frame whose used scheme differs from its embedder's gets an
  opaque backdrop — so its `background: transparent` was simply ignored in
  dark mode, with nothing in any log. `viz-frame.tsx`'s shell now declares
  `color-scheme` from the `.dark` class AND paints `var(--surface)` itself,
  so it no longer depends on transparency at all. Any future srcdoc/iframe
  (previews, embeds) needs the same line. No DOM property reports the
  backdrop, so the regression is pixel-measured: `scripts/test-viz-dark.ts`
  seeds the owner's exact chart, renders it in both themes and compares the
  frame's canvas to the card's computed surface colour plus the label ink's
  contrast (verified to FAIL on the old shell: white canvas, contrast Δ0).
- **Focus rings:** the global `:focus-visible { outline: 2px solid var(--ring) }`
  is **unlayered**, so it beats any Tailwind `outline-none` utility (which lives
  in `@layer utilities`) regardless of specificity. Text fields are opted out via
  a dedicated `input/textarea/select:focus-visible { outline: none }` rule in
  `globals.css` — fix focus-ring issues there, not with a utility class.
- **`break-words` does NOT stop a long string widening the layout** — use
  `overflow-wrap: anywhere`. `overflow-wrap: break-word` (Tailwind
  `break-words`) lets text break *visually* but does not reduce the element's
  **min-content** width, and min-content is exactly what a flex ancestor sizes
  to. A pasted URL with a query string made a user's message run off screen
  and scrolled the whole thread sideways (owner bug, 2026-07-29): the bubble
  reserved the full unbroken width even though the text was breaking. Fix is
  two parts — `overflow-wrap: anywhere` (on `.markdown` in globals.css and the
  user bubble's `<p>`) **and `min-w-0` on the flex children**, since a flex
  item defaults to `min-width: auto` and refuses to shrink below min-content.
  `.markdown pre` keeps its own `overflow-x: auto`, so code still scrolls
  rather than breaking mid-token. Regression:
  `scripts/test-long-content-wrap.ts` (13 checks — chat at 1280 AND 390, plus
  the admin transcript; measures `scrollWidth - clientWidth` per bubble, which
  is layout-independent, because a scroller-only check passes vacuously in the
  admin view. Verified to FAIL without the fix: 1265px/1771px/1377px).
- **Docker compose INTERPOLATES `$` inside an `env_file`.** An argon2 hash is
  `$argon2id$v=19$m=19456,t=2,p=1$salt$hash`, and compose substituted
  `$argon2id`, `$v`, `$m` and `$p` as undefined variables: 147 bytes in the
  file reached the container as 88, with the algorithm name gone. The console
  then reported "no operator accounts are configured" — indistinguishable
  from never having set one, and nothing in any log said otherwise (found
  live, 2026-09-07, on the first real sign-in). The console's accounts are
  stored **base64** now (`CONSOLE_OPERATORS_B64`), which has no `$` to eat and
  cannot be misread whichever way compose behaves; escaping as `$$` would
  break the other way the day it changes. **Any generated secret that can
  contain a `$` needs the same treatment** — the existing ones are safe only
  by luck: `gen_token` is alphanumeric and `gen_secret` is base64.
  `./deploy.sh console-password` now CONFIRMS BY FETCHING THE CONSOLE'S OWN
  SIGN-IN PAGE. Two earlier versions of that check confirmed the wrong layer:
  the first proved the file was written (compose then ate the `$`s), the
  second decoded the value back out of the container and passed — while the
  screen still said no accounts, because the RUNNING IMAGE predated the code
  that reads the base64 form. **A value arriving is not the same as the app
  understanding it**; the page tells them apart, and names the stale-image
  case ("run ./deploy.sh") rather than blaming the account. Pinned by
  `operators.test.ts` (incl. the exact mangled string that reached the
  container) and ten checks in `test-deploy-functions.sh`.
- **A second `next dev` needs `NEXT_DIST_DIR`, and rewrites two tracked
  files.** Two dev servers on one checkout share `.next` and poison each
  other exactly as a `pnpm build` does (see the next bullet), so the console
  harnesses set `NEXT_DIST_DIR=.next-console`. The catch: Next REGENERATES
  `next-env.d.ts` and `tsconfig.json` to match `distDir` on every dev start,
  so running one of those scripts leaves `next-env.d.ts` referencing a
  git-ignored directory that does not exist on a fresh checkout — `tsc` then
  fails, in CI, for a reason nothing in the diff explains. Both harnesses
  snapshot and restore the pair in `finally` (`snapshotNextFiles`); anything
  new that starts a dev server with a different dist dir must do the same.
- **NEVER run `pnpm build` while `pnpm dev` is running.** They share `.next`; the
  build overwrites the dev server's webpack chunks, causing runtime
  `Cannot find module './vendor-chunks/*.js'` 500s on every route (symptom:
  empty-body 500 on every rendered page, while middleware redirects still 307).
  Recovery: stop dev, `rm -rf .next`, restart dev. Verify with `pnpm typecheck`
  while dev runs; only `pnpm build` with the server stopped.
- **Production standalone build is gated on `BUILD_STANDALONE=1`** (set in the
  Dockerfile) — `output: "standalone"` uses symlinks that fail on Windows
  (EPERM), so local `pnpm build` skips it and the Docker build enables it.
- **Vitest excludes `e2e/`** (`vitest.config.ts`); `tsconfig.json` excludes
  `scripts/` (manual harnesses that reference live APIs).
- **E2E DB safety:** `e2e/global-setup.ts` truncates the database, so it refuses
  to run unless `DATABASE_URL`'s name contains `e2e` (or `CI` is set). Use a
  dedicated `opninfer_e2e` database locally.
- **Secure-context browser APIs:** `crypto.randomUUID` and `getUserMedia` (mic)
  exist **only on HTTPS or `localhost`** — over a plain-HTTP LAN IP they're
  `undefined`. Client id generation goes through `src/lib/uid.ts` (falls back to
  `getRandomValues`/`Math.random`) so chat works on plain HTTP; the **mic needs
  HTTPS** off-localhost. Use `pnpm dev:https` for LAN testing.
- **`pnpm dev:https`** points Next at a self-signed cert in `certificates/`
  (git-ignored) that includes localhost + LAN IP SANs — no mkcert CA-trust popup;
  the browser shows a one-time "proceed" warning. To add another LAN IP, regenerate
  the cert (openssl, SANs) and add the origin to `allowedDevOrigins` in
  `next.config.ts`.
- **Cookies ignore the PORT, so two portals on one host share a jar**
  (2026-09-05, hit while preparing the three client instances before their
  DNS moved). Reached as `<host>:3002/:3003/:3004`, every instance used
  the DEFAULT Auth.js cookie names, so signing into one overwrote the
  session AND the CSRF token of the last — you could never hold more than
  one portal open. Their own domains hide this in production, which is why
  it would rot unnoticed. `auth.config.ts` now names all three Auth.js
  cookies (and `sudo.ts` its grant) per `OPNINFER_INSTANCE`, which reaches
  the app through its instance env file. Two things make that safe: the
  same config object is what MIDDLEWARE runs, so both halves derive the
  same name (a mismatch reads as "signed out" on every request — runtime
  env IS readable there, Auth.js already reads AUTH_SECRET that way); and
  `secure` plus the `__Secure-`/`__Host-` prefixes are derived together
  from AUTH_URL, since a Secure cookie over plain http is silently dropped
  and those prefixes are only legal on a Secure cookie. Renaming signs
  everyone out ONCE on the deploy that ships it. `auth-cookies.test.ts`
  pins it against the source.
- **`AUTH_URL` pins the host.** If set (e.g. to `http://localhost:3000`), Auth.js
  redirects *there* after login, which breaks LAN access (external browser bounced
  to localhost). With `trustHost: true` (already set), **leave `AUTH_URL` unset in
  dev** so redirects follow the request host; set it to the real domain only in
  production. `src/lib/app-url.ts` falls back to localhost for emailed links.

## Deployment — multi-instance, behind the owner's reverse proxy (2026-07-20)

`deploy.sh` manages **every portal instance on the host from one checkout**:

- **Instances** — each portal (e.g. acme / globex / northwind / ini-tech) is one
  compose project `opninfer-<name>` (db + migrator + app + worker + sandboxd)
  driven by a generated, git-ignored `instances/<name>.env` (own secrets,
  master key, Postgres, storage volumes `opninfer-<name>_pgdata`/`_storage`,
  and a distinct `APP_PORT`). Full data isolation between instances.
- **Shared engines** — Gotenberg/Docling/Whisper/Kokoro run ONCE for all
  instances (`docker-compose.engines.yml`, project `opninfer-engines`,
  **always on** — no heavy profile in prod; the profile remains dev-only).
  They're stateless converters (no client data), reached over the external
  `opninfer-engines` network, which only each instance's app + worker join
  (db/sandboxd stay internal). Tunables in git-ignored `engines.env`.
  **Future possibility (owner, 2026-09-04):** move the heavy engines —
  Docling OCR, Whisper STT, Kokoro TTS — to a separate GPU-accelerated
  node. That frees ~25 GB here (their images are 20 GB plus Whisper's 2.4 GB
  model cache, the largest block on the disk) and makes OCR/transcription/
  speech far faster than the CPU images. They are already reached over the
  network only (`WHISPER_URL` / `TTS_URL` / the docling URL), so the move is
  an address change per instance plus the GPU image variants
  (`TTS_IMAGE=…-gpu` is already wired), not an app change.
- **No bundled TLS** — Caddy was removed (2026-07-20, owner decision); the
  owner's reverse proxy terminates TLS and targets `http://<host>:<APP_PORT>`
  (published on 0.0.0.0). Proxy must forward Host + X-Forwarded-Proto,
  disable SSE buffering, allow bodies ≥ the upload limit, generous timeouts.
  Each instance's `AUTH_URL` is its public https domain.
- **Flow** — `./deploy.sh`: auto-installs Docker if missing (get.docker.com;
  sudo fallback when the user isn't in the docker group; warns below Engine
  26, which the sandbox subpath mounts need) → **storage preflight** → first-run
  instance wizard → `git pull --ff-only` → build images ONCE (explicit `image:`
  names opninfer-app/-migrate/-worker/-sandboxd + the opninfer-sandbox
  toolchain image, shared by all projects) → engines up → per-instance
  **drain** → `up -d --no-build` → **health checks**. Re-running **updates
  every instance**; env files/data are never regenerated. `./deploy.sh add`
  appends an instance later.
- **Graceful drain** (`drain_instance`, added 2026-07-30, owner ask) — an
  update used to kill every live reply mid-sentence: the turn registry is in
  memory, so replacing the container takes the running generations with it.
  Now deploy.sh POSTs `/api/admin/drain` on the instance, which stops it
  accepting NEW turns and uploads (503 + `maintenance: true` → the composer
  shows a calm amber "we're updating, try again in a couple of minutes" notice
  and **hands the typed message back** instead of losing it), then polls
  `activeTurns` until the in-flight replies land — up to `DRAIN_WAIT_SECONDS`
  (60) — before `up -d`. Endpoints a running turn depends on (resume, stop,
  interject) stay open throughout. Auth is a per-instance bearer token
  (`OPNINFER_DEPLOY_TOKEN`, generated by deploy.sh; `ensure_deploy_token`
  back-fills instances created before this existed, so THEY drain from the
  next update on) — not an admin session, because the caller is a shell script
  with no cookie jar; the route is excluded from the middleware matcher for
  the same reason as `api/admin/import`. **The flag is in-memory on purpose**
  (`src/lib/drain.ts`): a container restart always clears it, so a deploy that
  dies halfway can never leave a stuck "maintenance mode" row to find and
  clear by hand. No token configured = endpoint 404s and updates restart
  abruptly, exactly as before. Unit tests `drain.test.ts` (5); live harness
  `scripts/test-deploy-drain.ts` (15 — drains DURING a real streaming reply
  and proves it still finishes and persists).
- **Build speed** (2026-08-22, owner ask — a release took **385s** of image
  build on the VM). Four fixes, all in `Dockerfile`, all easy to undo by
  accident, so the file carries the same list as a comment:
  (1) **never `chown -R` the app** — it cost **143.8s** of the 385s AND, because
  a chown rewrites every file, it duplicated the whole image into a second
  layer that then had to be exported, unpacked and stored (measured locally:
  645 MB → **491 MB**, a quarter of the image gone). Ownership now rides
  `COPY --chown`, with an explicit chown of only the four directories the
  runtime writes to. (2) `prisma generate` moved from `builder` to `deps`, so
  it re-runs when the SCHEMA changes rather than on every source change (24s).
  (3) `pnpm build` keeps Next's compiler cache in a BuildKit cache mount, so a
  deploy recompiles what changed instead of starting cold (108s). (4) the
  migrator is `FROM deps` instead of re-copying node_modules into a fresh stage
  (39s of COPY plus 84s of exporting a second full set of layers).
  A FIFTH, found by measuring the next real deploy (2026-08-23, 402s — SLOWER
  than the 385s it was meant to beat): `COPY prisma ./prisma` sat BEFORE
  `pnpm install` in the deps stage, so a release containing one new migration
  file invalidated the install and paid **126.7s** to reinstall identical
  dependencies — then re-exported every dependency layer into the migrator
  image on top (166s). There is no `postinstall` script, so the install never
  needed the schema at all. Moving that COPY after the install makes a schema
  change cost only `prisma generate` (~15s); verified by adding a throwaway
  migration and watching `pnpm install` report CACHED.
  Two more from the same read: the builder stage copied ~1 GB of node_modules
  out of `deps` into a fresh stage (42s of layer writing) to recreate what
  already existed one stage earlier — it is now `FROM deps`, like the migrator;
  and `.dockerignore` let the whole repo into the app context, including
  `worker/`, `sandboxd/` and `docker/` (which build from their OWN contexts),
  the harnesses, the docs — and **`instances/`, which holds every portal's
  master key, database password and deploy token**. Those never reached the
  final image, but they were written into the builder layer and left in the
  host's image store for nothing.
  A third pass followed the same method: with those fixed, the biggest line was
  the MIGRATOR image re-exporting 132.4s of layers whenever `prisma/` changed.
  The stages are now deps → **schema** (schema + migrations only) → builder
  (+ generated client + source), with the migrator built `FROM schema`:
  `migrate deploy` needs the CLI and the schema, never the generated client, so
  a schema change re-exports kilobytes instead of a ~1 GB dependency tree
  (measured 2.5s locally, **0.2s** on the host).
  **Cumulative, all measured on the production VM: 385s → 120.6s**, with Next's
  compiler cache finally paying off once the source tree stopped churning
  (137.7s → 84.2s). What is left is `pnpm build` itself (~84s of compiling and
  type-checking) plus ~26s of image export. The two remaining levers — turning
  type-checking off inside the image, or changing bundler — trade a real safety
  net for the time, so they are a deliberate decision and NOT a speed-pass one.
  The lesson generalises: when a build gets slower, read the STAGE TIMINGS in
  the log before believing the change worked — the app-side wins (no chown:
  ~140s, 154 MB) were real that run and still lost to one invalidated layer.
  deploy.sh also builds with `BUILDX_NO_DEFAULT_ATTESTATIONS=1` — provenance
  and SBOM manifests cost time on every image and nothing here reads them.
  NOT done, and the next real lever if this is still too slow: build the images
  in CI and pull them, so the VM never compiles at all.
- **Self-cleaning** (`reclaim_space`, 2026-08-23, owner ask) — every deploy
  leaves the previous build's layers behind untagged and BuildKit's cache grows
  without bound, on a disk shared with every instance's database and files (the
  first production deploy filled it to 98%, and the preflight was already
  warning at 19 GB free). After the health checks it prunes **untagged images**,
  **exited containers older than a day** (old one-shot `migrate` runs, reaped
  sandboxes — today's are kept so a failed deploy can still be inspected) and
  **build cache older than 14 days**, dropping to 48h if the disk is still under
  15 GB. What it must NEVER do is the point: `image prune -a` or `system prune`
  delete TAGGED images merely because nothing is running them right now,
  including the four shared engine images (~7 GB to re-pull), and volumes are
  instance DATA. `scripts/test-deploy-functions.sh` asserts all four of those
  refusals against a recorded command log rather than trusting the code to stay
  polite — one of those assertions was itself vacuous at first (a malformed
  regex made grep error out and the check "pass"), so it now has a negative
  control. `OPNINFER_SKIP_CLEANUP=1` disables it. It reports what DOCKER says
  each prune reclaimed rather than diffing `df`, which rounds to whole
  gigabytes and so announced "0 GB reclaimed" after genuinely clearing several
  hundred MB.
  **The build cache is capped by SIZE, not just age** (`--max-used-space`,
  10 GB default, `OPNINFER_BUILD_CACHE_MAX` to change; 4 GB when the disk is
  under 15 GB free). An age filter alone was the wrong tool and the first live
  run proved it: on a host that deploys weekly nothing is ever 14 days idle, so
  it reported "build cache 0B" while the cache kept growing on a disk already
  below the warning line. Each run also prints `docker system df` now, because
  "0B reclaimed" with no context is what sent the first diagnosis in the wrong
  direction.
- **What the disk holds on a Docker 29 host, measured on the v0.4.1 deploy
  (2026-09-02).** Before/after snapshots looked like a 13 GB leak from a
  deploy Docker said cost 4 GB. It wasn't: 8 GB of it was the swap file
  created between the two snapshots, and the rest is real — images +3.6 GB
  (the fat sandbox image), build cache +0.4 GB. The containerd image store
  keeps TWO copies of every image: the unpacked layers `docker system df`
  reports (46 GB in `io.containerd.snapshotter.v1.overlayfs`, images +
  build cache) and the COMPRESSED blobs it does not report (11 GB in
  `io.containerd.content.v1.content`, the twin of all 12 images, ~8 GB of
  it the four engines).
  **Storage pass, 2026-09-05 (owner ask), 95 GB disk at 84%: 15.0 GB free
  → 19.0 GB.** What actually worked: the **swapfile** — 8 GB on `/data`,
  created during the 2026-09-02 investigation, halved to 4 GB for a
  straight 4 GB back. The box has 7.4 GB RAM and had 11.1 GB of swap across
  two files with 2.2 GB in use; 7 GB total is still ~1× RAM and memory read
  HEALTHIER afterwards (6.0 GB available vs 5.6). Do it only when idle and
  with headroom: abort if under 3 GB is available or over 2 GB is resident
  on that device, `swapoff` migrates the resident pages into RAM first, and
  recreate with `dd` — NOT `fallocate`, whose unwritten extents make
  `swapon` refuse a file with holes. The `/etc/fstab` entry names the path,
  not the size, so it needs no edit and survives a reboot. Needs root, and
  this host has no passwordless sudo: pass the password to `sudo -S` on
  STDIN, never in argv where `ps` would show it. Second win: the duplicated
  CLI binary (see *Sandbox agent tier*), 0.44 GB off the app image. NOT the
  build cache — see above, 0 B under every filter. Left as the owner's
  call: backups (1.9 GB, retention 7, ~25 MB/day — a recovery-window
  decision, not a disk one). The real future lever is unchanged: the four
  engine images are 22.8 GB and the Whisper model cache another 2.4 GB, all
  of which the GPU-node plan moves off this host. The blobs are inherent to that store — nothing to
  prune, they shrink only with fewer or smaller images. There were no
  orphans: 0 untagged refs, 0 dangling images. Measure with
  `sudo sh -c 'du -xsh /data/containerd/*'` before believing a leak.
  **The one real waste was the build cache: the cap had never worked.**
  `builder prune --max-used-space` without `--all` prunes only DANGLING
  cache, which on a host that rebuilds the same images every deploy is
  nothing — "0B" twice, with 5 GB reclaimable. Fixed with `--all` (pinned
  by `test-deploy-functions.sh`); build cache only, it cannot touch an
  image. **And 0B can still be the right answer** (2026-09-04, checked by
  hand after the deploy reported 0B while `docker system df` claimed 7 GB
  reclaimable): `docker buildx du --verbose` showed the cache IS the current
  images' own layers — the sandbox image's pip/apt/playwright steps, the
  app's pnpm install — which the containerd store shares with the images;
  `system df` counts them "reclaimable" anyway, and neither a size cap
  (`--max-used-space`, `--reserved-space`) nor `until=48h` will free a layer
  a tagged image is made of (`until=168h` found 43 MB). Read `buildx du
  --verbose` before believing either number; the cap is there for the day
  the cache holds something an image no longer does.
  **Settled 2026-09-05: the cap is INERT on this host, and pruning is not a
  storage lever at all.** Measured against a 21.5 GB cache: three successive
  `builder prune --all --filter until=12h` passes freed 0 B (BuildKit
  deletes leaf-first, so repeated passes do NOT cascade here), and
  `--max-used-space 15GB` then `10GB` — caps far below the total — ALSO
  freed 0 B. `buildx du --verbose` calls ~10 GB of it `Shared: false` and
  `Reclaimable: true`, including three `node:22-bookworm-slim` pulls from
  2, 5 and 6 weeks ago, and not one can be removed: they are ancestors of
  records the current images are built from. Build-cache size here is a
  REPORT of the images, not a separate consumer. Do not chase it again, and
  do not lower `OPNINFER_BUILD_CACHE_MAX` expecting space — it costs deploy
  speed and returns nothing.
  **Two more truths about the cap, found the same evening on the new
  host** (cache 16.45 GB, cap 10GB, prune reported 0B — re-run by hand,
  output verbatim: `Total: 0B`): (1) BuildKit counts only the UNSHARED
  cache against `--max-used-space` — entries whose snapshot is also a
  layer of a tagged image (6.0 GB here) are excluded, because pruning
  their record frees nothing — and Docker parses "10GB" as 10 GiB
  (10.74 GB decimal, the unit `buildx du` prints), so 10.2 GB of unshared
  cache sat just under the cap and nothing was pruned. The cap DOES work;
  it bounds the cache-only part, which is the previous build's copies (an
  old `pnpm install` 2 GB, an old standalone 1.1 GB, old worker apt layers)
  plus the intermediate stages no image keeps. (2) **The "build cache NB"
  line had never once been right**: `prune_reclaimed` grepped for
  "reclaimed space", the classic prunes' summary, but `builder prune` is
  served by buildx and ends with `Total:<TAB>NB` — fixed to read both,
  pinned by check 10 in `test-deploy-functions.sh`. Loose end: the
  worker's apt+pip layers were rebuilt on the last two deploys (80 s
  here) although nothing in `worker/` changed; the build does not `--pull`
  base images, so it is the LRU eviction under the cap — cheap on this
  box, watch whether the 6 GB sandbox image ever goes the same way.
  **What the 95 GB data disk held after the 0.5.1 deploy (71 GB used):**
  unpacked image layers 35.4 GB (the four engines 22.8 — Whisper 7.6,
  Docling 7.4, Kokoro 5.4, Gotenberg 2.4; sandbox + agent ~6.9; app,
  worker, migrator, broker, Postgres ~5), the compressed twins of those
  images 10.6 GB, build cache beyond the images ~10–12 GB (bounded by the
  cap), the 8 GB swap file, and 4.7 GB of volumes — of which the CLIENT
  DATA is 0.5 GB of chat pools + 1.8 GB of seven nightly backup zips +
  27 MB agent state + 0.17 GB database; the other 2.4 GB is Whisper's
  model cache. So under 3 GB of the 71 is data; the rest is software. The deploy itself took 36 min, ~17 min of which was the image
  export/unpack (disk write speed), plus a `sudo` password prompt that sat
  waiting after the 22-minute sandbox build — the deploy user is in the
  docker group now.
- **Undrain after the update** (`undrain_instance`, 2026-08-22) — the drain
  flag is in memory and was cleared only by the container being REPLACED. But
  `up -d` deliberately leaves a container alone when its image and config are
  unchanged, which is exactly what a re-run with no new commits produces — and
  the script itself tells you to re-run after fixing a failed check. That
  re-run drained a healthy portal and never undrained it: every user gets "we're
  updating, try again in a couple of minutes" indefinitely while the deploy
  prints "all checks passed", because the `/login` probe still answers. Now a
  best-effort `DELETE /api/admin/drain` runs after `check_instance` (app proven
  responsive first). Covered by three more checks in
  `scripts/test-deploy-functions.sh` (10 total).
- **Storage preflight** (`preflight_storage`, added 2026-07-29) — warns BEFORE
  pulling ~7 GB of images if Docker's `data-root` and containerd's store sit
  on different filesystems (the Docker 29 trap below), and if the image store
  has under 20 GB free. Prints the exact containerd fix.
- **Health checks** (`check_instance` / `check_engines`, added 2026-07-29) —
  "the containers started" is NOT "it works": the ingestion worker sat unable
  to reach its own database for **8 days** in production while every container
  showed `Up` and deploy.sh said "complete". Each instance is now verified
  after `up`: migrations exited 0, the app answers HTTP 200 on `/login`
  (retried up to 60s for a cold start), the **worker logged "connected to
  database"** (and not `loop error`), and sandboxd is listening; the shared
  engines are probed over HTTP from inside the worker container (which is on
  the engines network and already has httpx). Failures are collected and the
  script ends with a red list instead of "Deployment complete" — it never
  claims success it hasn't checked.

- **Sandbox agent tier (0.4.0)** — `deploy.sh` builds `opninfer-agent` FROM
  the toolchain image, health-checks that the broker's boot line names the
  agent image and that the image exists, and gains **`./deploy.sh agent-login
  <instance>`** — Anthropic's own login flow into that instance's credential
  volume (`opninfer-agent-config-<instance>`, deliberately NOT a
  compose-managed volume so `down -v` never logs an instance out).
  **`./deploy.sh agent-token <instance>`** (2026-09-07) is the alternative
  to that login: `claude setup-token` in the same volume, the token stored
  base64 in the instance env file, the app recreated and then ASKED whether
  it understood it. It exists because the login's token refreshes every ~8
  hours and every chat shares one copy — see *Sandbox agent tier*.
  **`./deploy.sh agent-mcp <instance> add|login|list|remove|logout …`**
  (2026-09-03) sets up connected services (MCP, e.g. Figma) in that same
  volume with Claude Code's own commands — see *Sandbox agent tier*. Compose
  passes `AGENT_IMAGE` / `AGENT_MEMORY` / `AGENT_CPUS` / `AGENT_IDLE_SECONDS`
  to sandboxd and `AGENT_PROXY_BASE` (host.docker.internal on `APP_PORT`) to
  the app. Host sizing: budget ≥1 GB RAM + 1 CPU per CONCURRENT agent run on
  top of the 2 GB each container reserves; the 6.7 GB VM will need its bump
  before several instances run agents at once.

- **The operator console** (2026-09-07) — after every instance is up,
  `deploy_console` creates the `console_ro` role in each portal's database,
  regenerates `instances/console/portals.env`, brings up
  `docker-compose.console.yml` (project `opninfer-console`, the same
  `opninfer-app` image with `OPNINFER_MODE=console`) on **port 3000**, and
  attaches it to each `opninfer-<name>_default` network so it can reach those
  database containers. `./deploy.sh console-password` sets a sign-in;
  `OPNINFER_SKIP_CONSOLE=1` turns the whole thing off. Never fatal: a portal
  whose role could not be created is left out of the console's list, and a
  console that fails to start is a red line at the end, not an aborted deploy.
  See *Operator console* and `docs/V06_CONSOLE.md`.

Private repo → the deploy host needs GitHub auth (SSH deploy key or `gh`).
Each portal stays single-process by design (in-memory model cache, stream
registry, local storage volume): scale **up**, and add portals side-by-side
rather than clustering one.

## Concurrency & multi-user scale

Built to serve many users prompting **at the same time** (10+ concurrent chats
comfortably on one instance). What makes that safe, and the knobs that gate it:

- **Per-request, no shared mutable state.** The chat pipeline is async generators
  (`runAssistant` in `pipeline.ts`) whose state (`producedText`, `escalate`, …)
  is all local — nothing crosses requests. The module-level singletons are
  read-mostly / idempotent: the Prisma client (`db.ts`), the AES key memo
  (`crypto.ts`), the per-credential model cache (`providers/model-cache.ts`), and
  the log-listener `Set` (`applog.ts`). None hold per-request data.
- **DB connections are released per query, never held for the stream.** A reply
  may stream for a minute, but Prisma only grabs a connection for each short
  query (load history, save messages, `recordUsage`, `appLog`) and returns it —
  long streams don't pin the pool. **The pool size is the main throughput gate:**
  Prisma's default (~`num_cpus*2+1`) is small, so set `connection_limit` (and
  `pool_timeout`) on `DATABASE_URL` — `.env.example` ships `connection_limit=15&
  pool_timeout=20`, which handles 10+ concurrent turns while staying well under
  Postgres `max_connections` (100). Undersizing it shows up as requests hanging
  then erroring under load, not as a crash.
- **Process-level crash guard** (`src/instrumentation-node.ts`, Node runtime
  only): `unhandledRejection` / `uncaughtException` are logged, not fatal — one stray
  async error can't take the process down and drop *every* connected user's SSE
  stream. Node ≥15 would otherwise exit on an unhandled rejection. All
  fire-and-forget server writes (`lastActiveAt`, `touchCredential`) are already
  `.catch()`-guarded.
- **Streams clean up on disconnect.** The SSE route threads `req.signal` into the
  provider SDK, so a client leaving aborts the in-flight provider request (no
  leaked upstream calls); enqueue-after-close is guarded by a `closed` flag. The
  admin Logs SSE heart-beats every 25s and unsubscribes on abort.
- **libuv threadpool** (`UV_THREADPOOL_SIZE=8` in `docker-compose.yml`): argon2
  password hashing (`@node-rs/argon2`, login only — not the chat path) and file
  I/O run on the threadpool; the default of 4 can queue under concurrent logins
  + uploads. Chat/LLM streaming is not threadpool-bound.
- **Upstream limits, not the app, are the real ceiling.** 10 simultaneous turns
  = 10 concurrent provider calls; a provider **429 fails over** to the failover
  role (`providers/errors.ts` → `runAssistant`), and a **4xx is surfaced** (config
  bug), never masked. There is no internal request queue — fine at this scale.
- **Single-instance assumption.** The model cache and log-listener set are
  in-process, so horizontal scaling would need them externalised (Redis/pub-sub)
  and sticky SSE; today scale **up** (CPU/RAM + `connection_limit`), not out.

## Security

- Provider keys are encrypted at rest (AES-256-GCM, `OPNINFER_MASTER_KEY`).
  **Back up that key** — losing it makes stored keys unrecoverable.
- Never commit `.env` or any secret. Never accept API keys pasted into a chat
  message — direct them to the in-app encrypted credential form or `.env`.
- Reasoning level and model choice are server-authoritative (read from the
  assistant config on the chat route); the client may only send a boolean
  extended-thinking toggle.

## History & locked decisions

Distilled from the (now-deleted) Claude Code memories, 2026-07-20 — the
decision record that isn't derivable from code or git history:

- **v0.1 → v0.2 pivot (decided 2026-06-29):** v0.1 was "each user picks a
  whitelisted model with their own key". Inverted to the central-admin branded
  assistant with the four model roles. Locked then: central admin keys, build
  escalation/tool-calling as part of the pivot, admin restructure first.
  Everything per-user (model picker, whitelist, BYO keys) was deleted — don't
  resurrect any of it.
- **Anthropic subscription OAuth: built, then REMOVED the same day
  (2026-06-29).** A full PKCE flow existed and was gutted after confirming
  Anthropic prohibits routing third-party users through Pro/Max OAuth tokens
  (`sk-ant-oat01-` is individual-use only). Console API keys are the only
  path. **Never re-add it** — this is a terms-of-service line, not a technical
  gap.
- **Conversation titles:** emoji prefix + 2–5 words, sentence case
  (e.g. `🐈 Story about a cat`) — frontend role, locked format.
- **File ingestion (locked 2026-07-01):** "the map, not the dump"
  (token-efficient prepared content, schema over data); the `files` table IS
  the queue (SKIP LOCKED, no Redis); per-engine containers + one thin router;
  MarkItDown embedded in the router (lightweight); heavy engines originally
  opt-in via the compose `heavy` profile (since 2026-07-20: always on in
  prod, profile is dev-only); images → native vision, never text; create the
  conversation on first attach; backups include file pools. Engine pins:
  docling-serve v1.26.0, whisper-asr v1.9.1, gotenberg:8. **Deferred, still
  open:** Access/`.numbers`/avro readers; re-queueing old `unsupported` rows
  when heavy engines come online later.
- **v0.3 agentic tools (locked 2026-07-01):** sandbox as a broker service
  ("guard hut" — only Docker-socket holder) with egress-only network by
  default; ONE unified file-tool family (no parallel `sandbox_*` names); fat
  prebuilt sandbox image; memory auto-injected each turn (not on-demand);
  viz markers parsed server-side; client tools as instance-level capabilities
  (no per-user gating, no email-domain grants); Tavily via the encrypted
  settings machinery. Built in 10 independently-committed steps
  (infra → web → memory → view_image → router+curation → images → skills →
  viz → sandbox → capabilities); the router was later replaced by progressive
  disclosure.
- **Reference toolset:** an earlier in-house Open WebUI toolset was
  **inspiration only** — "fundamentally a new project, do what's best for OPNinfer". Its
  compression tiers were mirrored where they made sense (image edit sources);
  its force-JPEG behavior was deliberately not (format family preserved).
- **Deployment model (locked 2026-07-20, owner decision):** multiple portal
  instances per host from ONE checkout (the first deployment ran four), each
  fully isolated (own DB/storage/secrets), engines
  shared (stateless), heavy engines ALWAYS ON in prod, TLS terminated by the
  owner's existing reverse proxy (Caddy removed from the stack), Docker
  auto-installed by deploy.sh, one `./deploy.sh` run updates all instances.
- **OUT of scope (decided, don't drift into them unasked):** deep research
  mode, ComfyUI/image-model cascade, vector-store file recall, a separate
  code-execution environment beyond the sandbox, Anthropic OAuth (never).
- **"spec §N" code comments** reference the original v0.1 build spec, which
  was supplied in-chat and never committed — they're historical provenance
  anchors, not pointers to a repo file. Harmless; don't hunt for the document
  and don't bulk-strip them (git-blame churn for zero gain).

## Status and deployment history

**Deliberately not in this file.** What a particular deployment is running,
which instances exist, what went wrong in production and what it cost are facts
about *an* OPNinfer, not about OPNinfer. Keeping them out is what lets this file
stay byte-identical between the public product and any private deployment of it,
so that pulling upstream never conflicts here.

If this checkout has an `OPERATIONS.md` beside this file, **read it** — that is
where those facts live, and it is the first thing to read when something is
broken in production. The release notes a user sees are `CHANGELOG.md`; the
design records for each major version are under `docs/`.
