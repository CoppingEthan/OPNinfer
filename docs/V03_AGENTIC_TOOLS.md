# OPNinfer v0.3 — Agentic Tools: Brief, Decisions & Implementation Reference

*This is the survival document for the v0.3 build. It contains (1) the product
owner's working brief, (2) every decision locked with them, (3) the distilled
mechanics from an in-house Open WebUI toolset studied as a reference, per
remaining build step. A fresh session should be able to implement any step from
this file + `CLAUDE.md` + `docs/PROJECT_BRIEF.md`. That toolset was inspiration
ONLY — "fundamentally a new project, do what's best for OPNinfer" — and is not
part of this repository.*

**Communication rule from the owner:** explain simply, propose decisions as
one-question-at-a-time approvals (AskUserQuestion), avoid jargon walls.

---

## 1. The owner's brief (condensed, nothing dropped)

Build the v0.3 agentic-tools phase so the assistant can ACT, not just read —
iterating like a coding agent until a task is done. Feature-match that toolset
V2 fairly closely for the in-scope items, but port ideas into OPNinfer's
idioms — where OPNinfer already has a better version (provider abstraction,
storage pools, usage tracking), extend that.

**IN SCOPE:** web search + scrape (Tavily; admin-configured encrypted org
credential); image generation/edit/blend (Gemini ONLY, honest error if
unconfigured, keep per-user weekly quotas); view_image (token-efficient
re-examination, strict ownership security); sandbox read/write/list/diff/
delete/run on the REAL conversation pool; skills (progressive disclosure,
anthropics/skills-compatible format); render_visualization (inline, streamed,
sandboxed iframe — mechanism was mine to propose); user memory (per-user,
admin char budget, Postgres, auto-injected, never curated); date/time tools
(proper tz library-grade math); token-efficiency infra (tool router classifier
on the frontend role + context curation).

**OUT OF SCOPE (do NOT build):** deep research + PDF reports, ComfyUI/any
non-Gemini image backend + tiered cascade, file recall (vector store), a
separate code-execution engine (CEE), Anthropic subscription OAuth (never).

**Cross-cutting:** provider parity for every tool (OpenAI tool_calls /
Anthropic tool_use+tool_result / Google functionCall+functionResponse); every
model call writes usage_records (classifier, curator, images incl. per-image
cost); server-authoritative (client never chooses tools/models); new admin
controls in the existing admin area (Tavily key, Gemini image quotas, tool
toggles, memory budget, sandbox caps, per-tool usage on Usage page); Windows
dev / Linux prod; graceful degradation (unconfigured backend → clean tool
error the model can reason about); unit tests for pure logic + manual live
harnesses in scripts/ for anything hitting real services.

**Each step independently reviewable; stop and flag at expensive-to-reverse
forks.**

---

## 2. Locked decisions (owner-approved 2026-07-01)

1. **Sandbox = broker service** ("guard hut" — owner approved via question).
   A tiny separate container is the ONLY holder of the Docker socket. App asks
   it over a narrow shared-secret HTTP API (`POST /sandboxes/:convId/exec`,
   `DELETE /sandboxes/:convId`, `GET /health`; token from .env; internal
   network only, never through Caddy). Broker ENFORCES policy: image allowlist
   (only `opninfer-sandbox`), convId must be UUID, mounts exactly that chat's
   pool at `/workspace`, **tmpfs over `/workspace/.opninfer`** (hides/protects
   worker artifacts), 2g mem / 2 cpus / 128 pids, cap-drop ALL,
   no-new-privileges, read-only root + tmpfs /tmp, non-root user, exec wrapped
   in `timeout -s KILL`, warm per-conversation containers + 10-min idle reaper
   + orphan sweep. Command passed as argv (never shell-interpolated in the
   broker). Runs in BOTH dev and prod compose (Docker Desktop socket mount
   works → single code path). Dev bind mounts need `STORAGE_HOST_ROOT` (host
   path of ./storage); prod uses named-volume `volume-subpath` mounts
   (Docker Engine ≥ 26).
2. **Sandbox internet (owner requirement): egress-only, ON by default.**
   Dedicated bridge network that reaches the internet but CANNOT reach the
   internal compose network (db/app/broker/engines). Admin toggle per instance
   to turn it off. Because offline mode must still work: a `download_file`
   tool runs APP-side (fetch URL → save into pool via saveBufferToPool-style
   streaming) covering repos/docs/images without box networking.
3. **Sandbox image: FAT prebuilt** (~2.5–3 GB): Ubuntu 24.04 + Python 3
   (numpy pandas scipy matplotlib seaborn plotly pillow opencv-headless
   openpyxl xlsxwriter python-docx pypdf pdfplumber python-pptx requests bs4
   lxml pyyaml tabulate python-dateutil pytz ffmpeg-python etc.) + Node 22 +
   ffmpeg + imagemagick + ghostscript + poppler-utils + pandoc + LibreOffice +
   jq/csvkit/sqlite3 + git + zip tools + ripgrep + build-essential + Playwright
   chromium pre-cached. Non-root `sandbox` user (uid 1000). MPLCONFIGDIR=/tmp.
4. **Pool-mount concurrency (`syncPool(convId)`):** after every mutating tool,
   diff the pool directory vs `files` rows → new files = `kind=generated,
   status=pending` rows (ingestion worker prepares them; manifest + chips
   update automatically); changed mtime/size → status reset to pending;
   missing → row deleted. Known accepted hazard: worker mid-read of a file the
   sandbox rewrites → one garbage artifact, self-heals on next sync.
5. **Client tools = instance-level capabilities** (owner approved via
   question). NO email-domain grants, NO per-user gating in v0.3. A Capability
   is a code module: `{ id, label, description, tools: ToolDef[], executor,
   configSchema (zod), secretFields, verify?(config) }` in
   `src/lib/capabilities/registry.ts` (same one-file+registry pattern as
   providers). New **Admin → Tools page** hosts: built-in tool-GROUP toggles
   (server-authoritative enablement) + a card per capability (enable switch +
   config form from schema; secretFields encrypted with OPNINFER_MASTER_KEY;
   stored in `capability_<id>` settings keys). First capability:
   one client capability with a format-keyed adapter registry (a snapshot
   adapter, config `{provider, base_url}`).
6. **ONE unified file-tool family** (no parallel `sandbox_*` names): existing
   `list_files` + `read_file` (grow a `raw: true` param for exact bytes), plus
   `write_file`, `edit_file` (exact search/replace, `all` flag),
   `delete_file`, `execute_command`, `run_script` (write+run composite,
   auto-detect runner by extension: .py→python3 .js/.mjs→node .ts→npx tsx
   .sh→bash). Reads/writes/edits/deletes run HOST-side in Node on the pool;
   only execute/run enter the sandbox. All go through syncPool after mutation.
7. **view_image by pool FILENAME** (not URL — OPNinfer has no public URLs).
   Loads via the existing vision loader (VISION_MIMES png/jpeg/gif/webp,
   ≤8 MB). Provider snag + solution: OpenAI/Google tool-result messages cannot
   carry images → tool result text says "image attached", and the loop appends
   a synthetic user-role message with the image part before the next round.
8. **Memory auto-injected** every turn (diverges from reference's
   on-demand-only, per the owner's brief): compact block in the system prompt,
   budget default 2000 chars (admin-adjustable), + memory_retrieve/create/
   update/delete tools. New Postgres table `user_memories(id, user_id FK,
   content, created_at, updated_at)` keyed by user id. NEVER context-curated.
9. **Visualisation:** model-facing marker protocol kept (`@@@VIZ-START` /
   `@@@VIZ-END` emitted as plain text in the SAME reply after calling
   `render_visualization {title}`), but parsed SERVER-side in the chat route's
   SSE framing → markers stripped from the text stream → first-class `viz`
   SSE events → React sandboxed-iframe component (`srcDoc`,
   `sandbox="allow-scripts"` only — no allow-same-origin, strict CSP, theme
   CSS variables injected, height via postMessage). Persist viz HTML in
   `messages.meta` so it survives reload.
10. **Tool router:** frontend role classifies which tool GROUPS a turn needs;
    skip when ≤5 tools enabled; max_tokens ~50; parse group names by word
    boundary; "none" → 0 tools; unparseable or empty intersection → ALL tools
    (fail open). Usage recorded (new usage_records role tag `router`).
11. **Context curation:** runs on OPNinfer's NEUTRAL ChatMessage[] BEFORE
    provider mapping (one code path — big simplification vs reference).
    Trigger ~100k est. tokens (len/4); keep most-recent 5 tool results full;
    skip results <500 chars and already-curated ones; summarize to ~200 tokens
    via the frontend role; replacement text `[Tool result curated to save
    context] Tool: X / Params / Summary`. Never curate memory ops. Usage role
    tag `curator`.
12. **REVISED at build time:** Tavily key is a **settings-encrypted service
    secret** (`web_tools_config.tavilyKeyEncrypted` = base64 of
    master-key-AES-GCM ciphertext; `src/lib/tools/tavily.ts getTavilyKey()`),
    NOT a Provider enum value — a credential-table entry would pollute the
    model-role dropdowns. Env fallback `TAVILY_API_KEY` for dev. Admin form
    lands on the Tools page (step 10). Same encryption mechanism, cleaner
    home. **Gemini image gen reuses an existing google credential** — admin
    binds one (like model roles); no new key type.
13. **Quotas:** per-user-id rolling 7-day image quotas, defaults 20 flash /
    5 pro, admin-configurable. New table (e.g. `image_usage(user_id, model,
    created_at)`) or reuse usage_records filtered — decide at step 6;
    per-image cost recorded.

---

## 3. Progress state

- **Step 1 DONE (committed after 04da1f9):** `src/lib/tools/` registry
  (types.ts: ToolGroup files|datetime|web|memory|image|skills|visualize|
  sandbox|capability; registry.ts: registerTool + buildToolset(ctx, {
  includeFiles, groups? }) with defensive dispatch), date-time.ts (pure,
  IANA-correct via Intl: wallClockIn, clamped-month-anchoring
  calendarBreakdown — naive borrowing FAILS Jan31→Mar1, tests cover DST +
  clamping), 14 unit tests, chat route now builds the per-turn toolset
  (datetime always, files when manifest exists). Live-verified round-trip on
  all 3 providers via `scripts/test-tools-live.ts`.
- **CRITICAL provider fix discovered in step 1:** Gemini 3 requires
  `thoughtSignature` echoed back on functionCall replay (400 otherwise).
  Plumbed as `signature?` on the `tool_call` ChatChunk and `ToolCallPart`;
  google.ts captures `part.thoughtSignature` and re-attaches it on the
  replayed part; pipeline threads it through both tool loops. OpenAI/Anthropic
  ignore it.
- **Step 2 DONE:** `src/lib/tools/{tavily,web,web-helpers}.ts` — web_search /
  web_scrape / web_search_and_read (Tavily; 30s timeout; truncation caps
  4k/result, 15k search total, 8k/page, 20k scrape total) + download_file
  (app-side, SSRF-guarded: http(s)-only, no credentials in URL, forbidden
  hostnames, DNS-resolved private-IP blocking incl. metadata/CGNAT/v6, manual
  redirect loop max 5 re-validating each hop; streams into the pool via
  saveFileToPool, creates kind=generated pending row → worker ingests).
  11 unit tests (SSRF matrix, filename inference, truncation) + live harness
  `scripts/test-web-tools.ts` (13 checks incl. worker round-trip). Owner's
  Tavily key in .env works.
- **ALL 10 STEPS COMPLETE (2026-07-02).** Local commits, one per step, NOT
  pushed: bb5d008 (1-2 registry/date-time/web), 3d62ad1 (3 memory), fae9f79
  (4 view_image + ToolOutput images + Anthropic user-merge), 25d20dd (5
  router+curation + UsageRole + vitest server-only alias), e6d5f41 (6 Gemini
  images + quotas-off-usage_records), 409a648 (7 skills + seeds + Dockerfile
  COPY skills), ed7adaa (8 viz: viz-stream parser + viz SSE + VizFrame +
  meta.viz + visualize skill), 2cef3f3 (9 sandbox: sandboxd broker +
  docker/sandbox fat image [NO LibreOffice — Gotenberg covers docs; openpyxl
  covers xlsx] + write/edit/delete/execute/run_script + read_file raw +
  pool-sync + compose dev/prod + deploy.sh builds image & generates token),
  635fa46 (10 capabilities + Admin→Tools page + the first client
  capability, reading `<base_url>/properties.json`).
- **Verification: every step has a live harness, ALL GREEN** — test-tools-live
  (3 providers), test-web-tools (13), test-memory-tools (12), test-view-image
  (4, real model read PINEAPPLE via tool), test-router-curation (13, 116k→1.4k
  tokens), test-image-tools (7, real $0.067 gen), test-skills (11),
  test-viz-http (9, real model drew SVG through the route), test-sandbox-tools
  (21, full security envelope: artifact masking/read-only rootfs/egress-works/
  internal-DNS-blocked/timeout-kill/pip-install), test-capabilities (12).
  54 unit tests. Dev .env has SANDBOX_* vars set; sandboxd + worker +
  gotenberg containers running; dev server running.
- **Working mode granted by owner: "finish everything up, test as you go,
  don't stop until done." Local commit per step; NO pushes until the owner
  approves.**
- **FINAL PASS COMPLETE — v0.3.0 RELEASED 2026-07-20** (commit 83b4acb, CI
  green). The full owner-testing checklist (`docs/FEATURE_TESTING_CHECKLIST.md`)
  is ticked except §16 client capabilities, deferred pending a live data
  endpoint. At the cut: typecheck ✓, 167 unit tests ✓, ~20 live harnesses ✓.
  This document is now the HISTORICAL design record for v0.3; current state
  lives in `CLAUDE.md` → Status.
- Dev gotcha learned: NEVER round-trip source files through PowerShell
  Get-Content/Set-Content (PS 5.1 mangles UTF-8 em-dashes). Use the Edit tool;
  recover with `git checkout --`.

### Post-0.3.0 revision (2026-07-19, owner testing §11)

- **File presentation (NEW, owner ask).** The auto-attach of every
  turn-created file (post-turn pool diff) is GONE — the pool is now the
  assistant's private workspace, and files reach the user only through the
  new `present_files` tool (sandbox group). Presented displayable images
  (png/jpg/gif/webp by mime OR extension — syncPool rows are octet-stream)
  render INLINE via the existing generated-image flow (sharp aspect ratio,
  image_start+image_done back-to-back, meta.images with
  operation:"present"/prompt=filename); other files become download cards
  (`files` SSE mid-turn, meta.fileIds). `download_file` auto-presents.
  `ToolOutput.presented` → pipeline `files_presented` → route resolution.
  `attachFilesToMessages` no longer time-falls-back generated files (an
  unpresented file must stay masked across reloads) nor returns them as
  pending. Tool-result steering: sandbox mutations end with "in your
  workspace, NOT visible to the user — call present_files…". Regression:
  scripts/test-present-files.ts (9 browser checks over 3 model turns).
- **Live tool-run feedback follow-ups:** Anthropic buffers
  `input_json_delta` by default — `eager_input_streaming: true` per tool
  def (fine-grained tool streaming, GA) makes the code preview actually
  type live; previews render IDE-style (Prism + line-number gutter,
  `CodeView` in tool-run.tsx, `.oi-code` palettes in globals.css).

### Post-0.3.0 revision (2026-07-14, owner testing §11)

- **Live tool-run feedback (NEW, owner ask).** Sandbox-family calls
  (write_file / edit_file / run_script / execute_command) no longer show a
  bare status line — they render a **run block**: a rolling 5-line preview of
  the code AS the model writes it, a live console tail during execution, then
  a collapsed chip row (`file.py +N −M` · `0.1s · N lines · exit E`) that
  expands to the full code/output and persists via `messages.meta.toolRuns`.
  Mechanics: providers emit a new `tool_call_delta` ChatChunk (OpenAI/
  Anthropic stream partial tool args natively; Google emits one whole-args
  burst so the preview fills at once); the pure incremental-JSON tap
  `ToolArgTap` + `ToolRunTracker` + `lineDiffStat` live in
  `src/lib/tool-run.ts`; sandboxd gained a `stream:true` NDJSON exec path
  (`{o}`/`{e}` chunks live, `{done}` carries durationMs — real-time even
  through the Docker Desktop dev relay); console chunks thread up as
  `ToolCtx.emitRun` → registry → disclosure → an event bridge in the
  pipeline's `emitToolCall`. `UIMessage.tools: string[]` became
  `activity: ActivityItem[]` (status lines + run blocks in invocation
  order). Buffered broker exec remains the fallback (no `onEvent` → plain
  JSON; exercised by test-sandbox-tools). Regressions: tool-run units (18) +
  scripts/test-tool-run-ui.ts (10 real-browser checks, both call shapes).

### Post-0.3.0 revision (2026-07-13, owner testing §9–10)

- **Decision #9 REVISED — render_visualization tool RETIRED.** The
  declare-then-emit flow confused models repeatedly (re-declarations burning
  tool rounds; view_image("dummy") attempts to "check its work") and held the
  visual behind tool round-trips. The marker protocol is now taught UP FRONT:
  the chat route injects `VIZ_PROTOCOL_BLOCK` (tools/visualize.ts) whenever
  the `visualize` group isn't admin-disabled (`Toolset.disabledGroups`), and
  the model emits `@@@VIZ-START Title on the marker line` … `@@@VIZ-END`
  directly — the chart streams from its first token. Parser gained a title
  mode; `viz_title`/pendingVizTitle plumbing removed; VizFrame gained a
  ready-handshake (streamed HTML used to be lost to the iframe boot race).
  Registry threads per-turn `turnCallCount` into every executor (kept —
  generally useful). Regressions: viz-stream units (14) + test-viz-live-ui
  (6 browser checks).

### Post-0.3.0 revision (2026-07-02, owner-testing feedback — local, uncommitted)

- **Anthropic multi-tool 400 fixed**: when one round called view_image +
  another tool, the synthetic image turn merged BETWEEN the two tool_result
  blocks — Anthropic requires them contiguous at the front. anthropic.ts now
  stable-sorts tool_result blocks to the front of merged user turns.
  Harness: `test-anthropic-multi-tool.ts`.
- **Step 5a REVERSED — tool router retired** (owner call: "give the decision
  to the actual powerful model"). Replaced by **progressive disclosure**
  (`src/lib/tools/disclosure.ts`): core groups (files/datetime/memory/skills/
  visualize + view_image) offered round 1; deferred groups (web/image/
  sandbox/capability) described in a MORE TOOLS system directory; the model
  calls `enable_tools` to activate them (defs array grows in place; pipeline
  re-reads per round; MAX_TOOL_ROUNDS 4→6; enable_tools emits no status).
  Router files deleted; usage role `router` kept for old rows; curation
  unchanged. Harnesses: `test-tool-disclosure.ts` (replaces
  test-router-followup-context), `test-curation.ts` (replaces
  test-router-curation).
- **Tool feedback UX added**: `tool_status` pipeline chunk → `tool` SSE →
  Claude-style muted activity lines (labels in `tool-status.ts`);
  `sources` chunk (SourceRef kind web|file) from web tools + read_file +
  view_image → streamed/deduped/persisted `messages.meta.sources` → favicon
  "N sources" pill + expandable panel (file rows open the context viewer).
- **File-context viewer**: `GET /api/files/[id]/context` (owner-gated) =
  exact `read_file` text; file chips clickable. **Usage cost chart**:
  series endpoint gained cost+requests; `usage-cost-chart.tsx` (hour→year,
  hover tooltip) replaced the fixed 30-day bars.
- Unit tests 54→64 (disclosure + tool-status + curation split).

---

## 4. Distilled OWUI reference mechanics (per remaining step)

### Step 2 — Web (Tavily)
- API base `https://api.tavily.com/` endpoints `search` and `extract`;
  30s timeout; auth via api_key in body.
- `web_search {query, num_results 1-10 def 3, include_full_content?,
  include_images?}` → search_depth 'advanced' when full content else 'basic';
  include_raw_content:'markdown' when full; topic 'general'; images +
  descriptions paired. Result text: URL/title/content per hit; images list.
- `web_scrape {urls[] max 20, include_images?}` → extract endpoint,
  extract_depth 'basic'; per-URL success/failure counts.
- Composite `web_search_and_read {query, num_results 1-5 def 3}` kept.
- OPNinfer additions: `download_file {url, filename?}` runs app-side →
  streams into the pool (size-capped by the admin upload limit) → syncs a
  files row (kind=generated or kind=upload? use generated) so it's ingested +
  visible as a chip. Truncate tool-result text sensibly (token efficiency).
- Tavily key: org credential (enum value `tavily`); admin adds it on the API
  page; graceful "not configured" tool error otherwise. `.env`
  TAVILY_API_KEY seeds it for local testing (scripts/seed-keys.ts pattern).

### Step 3 — Memory
- Tools: `memory_retrieve {}` (list all w/ ids + usage), `memory_create
  {content}`, `memory_update {memory_id, content}`, `memory_delete
  {memory_id}`. Budget check on create/update with remaining-capacity error
  messages. Auto-inject block each turn (decision #8). Admin budget setting
  (`memory_config` or in the Tools page config; default 2000 chars).

### Step 4 — view_image
- `view_image {name}`: file must belong to THIS conversation (lookup by
  filename within convId — ownership implicit), be a VISION_MIME ≤ 8 MB.
  Result = "attached" note + synthetic user image part next round (decision
  #7). Manifest lines for images should mention "re-view any image with
  view_image".

### Step 5 — Router + curation
Constants (env-overridable): CURATION_TRIGGER_TOKENS 100000, KEEP_RECENT 5,
MIN_RESULT_SIZE 500 chars, SUMMARY_TARGET ~200 tokens. Classifier: system
prompt lists groups + one-line criteria; input = last user message tail
(~1000 chars); output first line parsed by word-boundary regex; "none" → no
tools; fail → all tools; skip entirely when ≤5 tools. Both run on the
frontend role; both record usage (roles `router`/`curator`).

### Step 6 — Images (Gemini)
- Models: flash `gemini-3.1-flash-image` (default), pro `gemini-3-pro-image`
  (quality:'max'). API base https://generativelanguage.googleapis.com/v1beta,
  timeout 180s. Reference costs: flash $0.067/img (4K $0.13), pro $0.134
  (4K $0.24) — verify current pricing at build time.
- Tools: `image_generation {prompt, aspect_ratio enum 1:1|16:9|9:16|4:3|3:4|
  3:2|2:3|4:5|5:4|21:9 def 1:1, quality standard|max def standard}`,
  `image_edit {prompt, image (pool filename), ...}`, `image_blend {prompt,
  images[] (pool filenames)}`. Outputs land in the pool (kind=generated) →
  chips/manifest via syncPool/ingestion; meta.json equivalent goes in
  files.meta.
- Quotas per decision #13; quota-exceeded and API failure = honest tool
  errors (NO fallback backend, NO cascade).

### Step 7 — Skills
- `skills/<name>/SKILL.md` with `--- name: X / description: Y ---`
  frontmatter (match https://github.com/anthropics/skills format so drop-in).
- L1: name+description list injected into system prompt every turn (when
  skills group enabled). L2: `load_skill {name}` returns full body, re-read
  from disk each call. `skills/<name>/assets/*` staged into the pool
  NON-overwriting on load ("kept your edits" semantics), synced as files rows.
- Seed skills worth porting from the reference: visualize (required by step
  8), code-review, email-drafting, meeting-notes, seo-writing,
  social-media-posts, internal-comms, frontend-design (cherry-pick sensible
  ones).

### Step 8 — Visualisation
- Tool `render_visualization {title?}` returns a teaching-signal result
  explaining the marker protocol; model then emits `@@@VIZ-START` … html …
  `@@@VIZ-END` as plain text in the same reply (NOT in a code fence).
- OPNinfer mechanism (decision #9): chat route strips markers from the text
  SSE and emits `viz` events; React `<VizFrame>` renders sandboxed iframe
  (srcDoc; sandbox="allow-scripts"; CSP via <meta> in the wrapper; theme
  variables from globals.css injected; height via postMessage; persisted in
  messages.meta.viz).
- Wrapper details worth porting: CSS vars (--color-text-*, --color-bg-*,
  --font-sans/mono, radius), 9 colour ramps (purple teal coral pink gray blue
  green amber red; _fill light-50 / _stroke 600 / _th 800) with light/dark
  swaps, alias vars to catch hallucinations (--fg --bg --border --primary
  --accent). Design rules for the model (in the visualize SKILL): no emoji,
  flat design, sentence case, min 11px, explanatory prose in chat not in the
  visual. Security levels strict|balanced|none (default strict).

### Step 9 — Sandbox (decision #1/#2/#3/#4 above is the spec)
- Reference values to keep: exec timeout 300s default, inactivity reap
  (we chose 10 min), cleanup sweep ~30 min, exit 137 = OOM-or-timeout
  (distinguish via docker inspect OOMKilled), streaming stdout/stderr
  callbacks (→ pipeline notice/thinking events), fs.chmod pool for the
  sandbox uid, tmpfs sizes /tmp 256m /var/tmp 64m ~/.cache 64m.
- New OPNinfer service `sandboxd/` (TS + dockerode) + `docker/sandbox/
  Dockerfile` (fat image, decision #3) + compose wiring (dev + prod, egress
  network `sandbox_egress` + internal-only reachability from app).

### Step 10 — Capabilities
- Decision #5 is the spec. Property adapter interface:
  `search(params, cfg) → {items, total}`, `getByRef(ref, cfg)`.
  `property_search {transaction sale|let?, sector residential|commercial def
  residential, location?, min_price?, max_price?, min_bedrooms?,
  property_type?, include_unavailable def false, limit def 12 max 25}`;
  `property_details {ref}`. Tools join group `capability`.

---

## 5. Keys & configuration the owner must supply

- `TAVILY_API_KEY` in `.env` (placeholder added) — needed to live-test step 2;
  free tier at tavily.com. In production it's added via Admin → API as an
  encrypted org credential.
- Gemini image gen uses the EXISTING Google key — nothing new needed.
- Everything else (sandbox, memory, skills, viz) needs no external keys.

---

## 6. Handoff (2026-07-08) — pushed as v0.2.1, moving machines

The whole v0.3 feature set + four owner-testing sessions (07-03/04/05/08)
were **pushed to GitHub as v0.2.1** — a WIP snapshot; **0.3.0 is cut when
`docs/FEATURE_TESTING_CHECKLIST.md` finishes** (ticked so far: 1–6, 7.1–7.4,
8.1–8.3, 13.10). **CLAUDE.md → Status is the authoritative changelog** of the
testing phase (resumable streams, mid-turn interjection, escalation trilogy,
empty-reply guard, abort classification, image edit/blend source tiers,
Admin Usage/Feedback pages, user-settings memory panel, …).

New machine setup: clone → `corepack enable` + `pnpm install` → copy `.env`
from the old box (SAME `OPNINFER_MASTER_KEY` — a new key makes the stored
provider keys unrecoverable) → `docker compose -f docker-compose.dev.yml up
-d` (add `--profile heavy` for OCR/Whisper) → `pnpm db:migrate` → move data
via an **Admin → Backups** zip (database + storage in one archive; restore
on the new instance) → regenerate `certificates/` for the new LAN IP
(`pnpm dev:https` needs it off-localhost).
