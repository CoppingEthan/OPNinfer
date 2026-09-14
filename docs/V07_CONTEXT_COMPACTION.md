# v0.6 — Conversation compaction (2026-09-10)

Status: **built, harness-proven and deployed as 0.6.0 the same day** — the
owner approved this proposal as written ("dividing line sounds good … go ahead
and code and fix everything"), with every §7 default taken. What the build
added to the design: a check just before storing a compaction that a newer
one does not already cover the same rows (the harness caught its own dev
server's boot sweep and the test process summarising the same 396 rows five
seconds apart — one process in production, but cheap to defend); and one
fixture lesson, that a "fact" planted in an ASSISTANT turn is not evidence
the model will honour, because it correctly answered that the user never
said it. The record below is the proposal as approved. Written after a read-only investigation of
all four portals, two controlled experiments against the live provider, and a
read of the current Anthropic / OpenAI / Google documentation. The owner's
brief, verbatim where it matters:

> a real fix … validate your findings, testing them … a retroactive fix for all
> conversations that are over a limit, so compaction works when we hit say
> somewhere between 96-128k tokens in context … validate that caching tokens
> works correctly … a GUI option to change the ranges … use the front end
> model for it as it's cheap to do and also faster … really test all of this
> works before a fix is deployed, then deploy it.

Model routing (cheaper models for simple requests) is explicitly **later**,
not here.

---

## 1. What the investigation found

Three separate problems stack up in the one chat that cost US$41.86 in 72
messages (one user's working chat on Portal A — 633 messages, ~388k tokens
of replayed history). Two of them affect the whole estate.

### 1a. Nothing ever compacts conversation history (confirmed in code and data)

- `src/lib/tools/curation.ts` → `selectCurationTargets` only picks messages
  with `role === "tool"`. `toChatMessages` (`src/lib/chat-turn.ts`) replays
  user / assistant / system rows only, so the array it is handed never
  contains one.
- It is also only *called* between tool rounds (`if (round > 0)` in both
  loops of `pipeline.ts`) — a plain prose turn never reaches even the estimate.
- Data: **zero `curator` usage rows have ever been written on any portal**.
  `maxInputTokens` (128,000, set on every portal) is a trigger for that
  curation, never a cap: Portal A served 24 turns over 200k tokens in 30 days,
  Portal B 107.

Where the money is (30 days, conversation-role turns, by prompt size):

| portal | turns ≥ 200k | share of spend | turns 96k–200k | share |
|---|---|---|---|---|
| Portal A | 24 | **94.6%** ($42.75 of $45.21) | 4 | 2.0% |
| Portal B | 107 | **36.1%** ($49.39 of $136.81) | 99 | 13.5% |
| Portal C | 5 | 11.5% ($0.62) | 0 | — |
| Portal D | 1 | 14.6% ($0.30) | 1 | 10% |

Chats that would be compacted today (replayed history ≥ 96k tokens): Portal B 7
(1 active in 30 days), Portal A 1 (active daily), Portal D 0, Portal C 0. The three
Portal B monsters (up to 449k tokens — one of them is a single 1.78 MB assistant
message) are dormant since April.

### 1b. Prompt caching works — except in this chat, and the reason is not what it looked like

**Caching is fine in general.** On Portal B, consecutive no-tool turns in the same
chat within 5 minutes hit the cache 452 times out of 499; in the 100–200k
band **22 of 22**. A controlled probe on the dev box through the app's own
message mapping (`scripts/_probe-cache.ts`, real Sonnet 5, ~$1.50) confirmed:

| probe | result |
|---|---|
| A2: next turn, same settings, ~76k tokens | **read 75,787 / write 18** (full hit) |
| A3: next turn with the Think toggle switched on | **read 0** — messages AND system re-written |
| A5: Think switched off again inside 5 min | full hit again (each mode keeps its own entry) |
| B2, B3: next turns at ~267k tokens | **full hits** — no problem above 200k |

So two of my earlier hypotheses are dead: the >200k path caches normally, and
Anthropic no longer doubles prices above 200k (pricing page: "the full 1M
token context window at standard pricing" for 4.6+ models), so the ledger is
right.

**The real cause of the misses is the ORDER the history is replayed in.**
The Portal A chat was imported from Open WebUI, where a question and its
answer are stamped with the **same second**. 74 of its message pairs share a
timestamp. `loadConvo` orders by `createdAt` only, and for tied rows Postgres
returns *whatever order its sort produces*. Measured in production:

- physical (insert) order has the user first in **73 of 74** tied pairs;
- the `ORDER BY created_at` output has the **assistant first in 36 of 74** —
  the sort scrambles half of them;
- the table is physically out of time order (25 backwards steps in that chat;
  102 chats on Portal A, 1,102 on Portal B), which is what defeats Postgres's
  "already sorted" shortcut and sends the rows through a real quicksort.

Reproduced on the dev box with the production query plan and a scrambled
insert order (`scripts/_probe-ties2.ts`): **the tie order changes on every
turn** — ~300 of 600 positions moved each time a message was appended, with
147–160 of 300 pairs reversed. Every request therefore carries a *different*
history, the cache prefix never matches, and the whole 525k tokens is
re-written at 1.25× — US$2.00 a message — while only the 7k-token system
prompt is read back (exactly the `cread=7112` signature in the ledger). It also
means the model has been reading half of that chat's questions **after** their
answers, and the user sees the same reversed order on screen (the chat opens
with an error reply above the question that caused it).

Chats with tied timestamps exist on every portal (imported OWUI history):
Portal A 661 (89 active in 30 days), Portal B 1,609 (6 active), Portal D 683 (46
active), Portal C 556 (62 active). Which of them scramble depends on
physical layout, which changes as pages get reused — so any of them can start.

### 1c. The Think toggle is a full cache rewrite

Not a bug, a fact to know (probe A3, and Anthropic's docs: thinking config is
rendered into the prompt ahead of the system text on Sonnet 5). Each switch
on or off re-writes the whole prompt once. At 525k tokens that is $2; at the
post-compaction size it is ≤ $0.36. Noted, not changed here.

---

## 2. What the research says (2026-09-10, sources in the two agent briefs)

- **Anthropic** now offers *server-side* compaction (beta header
  `compact-2026-01-12`, `context_management.edits[{type:"compact_20260112",
  trigger:{type:"input_tokens", value:150000}}]`): the API summarises the whole
  history into a `compaction` block, which the client must pass back. Billed as
  an extra sampling step at the conversation model's own rates (`usage.
  iterations`). Recommended breakpoint: end of the system prompt, so a
  compaction only re-writes the summary. Their recommended trigger is 150k,
  floor 50k. Their own client-side advice, if not using the beta: "summarize
  the whole session into one user message and send only that message plus the
  next instruction … Claude models are trained on long-horizon tasks with this
  scheme."
- **Claude Code** compacts client-side: a separate request with the same
  system prompt and history plus a summarisation instruction; the summary
  keeps the user's requests and intent, key facts, files/snippets, errors,
  pending work and current work; recent files are re-read. It reads the
  warm cache, so an in-session compact is cheap.
- **OpenAI** offers `context_management: [{type:"compaction",
  compact_threshold: 200000}]` on the Responses API and a standalone
  `POST /v1/responses/compact`; the result is an opaque encrypted item, bound
  to the model, billed as an ordinary request. Codex CLI: per-model
  auto-compact threshold, a structured hand-off summary ("progress and
  decisions / context and constraints / what remains / critical data"), recent
  user messages kept verbatim, only the newest summary retained.
- **Google Gemini**: implicit caching (90% off), **no** compaction of any kind.
- **Everyone** (LangChain `SummarizationMiddleware`, OpenAI cookbook
  `SummarizingSession`, Codex, Claude Code): summarise the older part, keep the
  most recent turns verbatim, keep one rolling summary, never split a tool
  call from its result.

---

## 3. Options and recommendation

| option | for | against |
|---|---|---|
| **A. Client-side rolling summary, front-end model** (recommended) | Provider-agnostic (works if the conversation model is ever OpenAI/Gemini); the owner's cheap model does the reading (gpt-5.6-luna: $0.20/M in — summarising 96k tokens costs ~$0.03); can be run **retroactively** over existing chats and stored; fully testable locally; admin-tunable | We write the prompt and own its quality |
| B. Anthropic server-side compaction | Zero summarisation code; Anthropic's tuned prompt | Beta; Anthropic only; summarised by Sonnet at Sonnet prices ($0.30+ per compaction); cannot fix existing chats; opaque to the admin |
| C. Truncate (drop oldest) | Trivial | Loses the template text this very user is working from — the cost of being wrong is the user retyping their work |

**A**, which is also what the owner asked for. B stays on the list as a
possible later switch for Anthropic-only instances.

---

## 4. The design

### 4a. Two admin settings, on the existing Limits card (Admin → Models)

Stored in the existing `token_limits` setting beside the three current fields:

| field | default | bounds | meaning |
|---|---|---|---|
| **Compact conversations at** (`compactAtTokens`) | **96,000** | 20,000 – 400,000, and ≤ Max input tokens | when the replayed history reaches this, older messages are summarised before the reply is generated |
| **Keep recent** (`compactKeepTokens`) | **20,000** | 4,000 – 100,000, and < half of the above | the most recent turns are always sent verbatim; only what lies before them is summarised |

Why 96k / 20k: after a compaction the prompt is ~25k (summary ≈ 3k + 20k
recent + system); it then grows to 96k over ~40 turns, each of which reads the
prefix at 0.1×. A lower trigger compacts more often (more cold writes, more
summarisation loss); a higher one costs more per turn and, per Anthropic, "as
token count grows, accuracy and recall degrade". Both are one-line settings
changes with the same 30-second cache as the other limits. "Max input tokens"
(128k) stays as the hard ceiling and the tool-result curation trigger; its hint
text is corrected.

### 4b. When it runs

**At the start of a turn**, in `startChatTurn`, after the ingestion wait and
before the prompt is assembled: if `estimateTokens(history) ≥ compactAtTokens`,
compact, then build the prompt from the compacted history. The user sees a
phase line in the thinking indicator — "Summarising earlier messages…" — the
same mechanism as "Processing <file>…". It happens once every few dozen turns
and takes a few seconds on the front-end model. A failure is a WARN log row
and the turn proceeds uncompacted: a reply must never be blocked by tidying.

Why not in the background after the reply (like the memory pass): the memory
pass taught us what a background job does on first contact with history. Doing
it inline means the model call that follows is *guaranteed* under budget, the
harness can assert it, and nothing can run away.

### 4c. What is kept and what is summarised

- Walk back from the newest message accumulating tokens (chars/4 + 1,000 per
  image); stop at the first **user** message once `compactKeepTokens` is
  exceeded. Whole turns only — never a reply without its question.
- Everything before that boundary — plus the **previous summary**, if one
  exists — goes to the front-end model and comes back as one new summary
  (rolling, like Claude Code and Codex: one summary, always the newest).
- Summarised in **chunks of ≤ 48k tokens**, rolling the summary forward
  through each chunk, so a 449k-token chat (or a single 1.78 MB message, which
  is split by characters) works with any front-end model's context window and
  never sends one enormous request. Each call: the compaction instructions +
  the summary so far + the chunk rendered as `User:` / `Assistant:` turns
  (with the author's name in a shared chat) → a summary capped at ~3,000
  tokens (`max_tokens` 8,000, because gpt-5.6-luna is a reasoning model and
  thinking counts — the title-budget lesson).

The summary prompt (to be pinned by tests, wording refined during the build):

1. **What the user is working on and wants** — their goals and requests, in
   their own words where possible.
2. **Key facts, names, numbers, dates and decisions** — anything a later
   answer would need to get right.
3. **Content they may reuse** — templates, drafts, final wording, lists, code:
   keep the **latest version verbatim** up to a size budget. (This chat's whole
   value is the email template — it must survive.)
4. **Their preferences and standing instructions** given in this chat.
5. **Open items** — what was asked and not finished.
6. **The most recent request**, verbatim.

Never invent, never resolve an ambiguity by guessing — leave it out. Plain
text.

### 4d. How it is stored and replayed

New table **`conversation_compactions`** (cascades with the chat): `id`,
`conversation_id`, `summary`, `boundary_message_id` (the first kept message),
`boundary_at`, `messages_covered`, `tokens_before`, `tokens_after`,
`provider`, `model`, `created_at`. Nothing in `messages` changes; the user's
full history stays exactly as it is. Older compaction rows are kept (they are
tiny) so an admin can see what was summarised when.

Replay (`loadConvo`): take the newest compaction; if its boundary message
still exists, the history sent to the model is

```
user:      [Summary of the earlier part of this conversation, written by the
            assistant to keep the chat fast. It replaces N earlier messages.]
            <summary>
assistant: Understood — I have the earlier context and will continue from here.
…the kept messages, verbatim…
```

That is Anthropic's own recommended client-side shape (one user message), and
the acknowledgement keeps roles alternating for every provider without
relying on the mappers' merging. If the boundary message is **gone** — the
user edited or reverted a message from before it — the compaction is simply
invalid: the full history is used and re-compacted on the next turn. Retry
(regenerate) only deletes the trailing reply, so the boundary survives. That
one rule covers edit/revert, delete, and any future path, with no bookkeeping.

### 4e. The retroactive fix

A **boot-time sweep** in `instrumentation-node.ts` (portal mode only, 90 s
after start, like the other schedulers): every conversation whose replayed
history is over the trigger and has no valid compaction is compacted, one at
a time, newest activity first, skipping incognito chats and any chat with a
live turn, capped at 50 per boot, each logged (`chat` / "Conversation
compacted", with before/after tokens and cost). It writes only to its own
table, so it cannot bump `updated_at` (the memory-pass mistake). Today that is
8 chats across the estate, a few cents in total, and it means the deploy
itself is the retroactive fix — no per-instance command. A chat crossing the
line later is handled inline (4b), so the sweep is a warm-up, not a
dependency.

### 4f. What the user sees

The thread on screen is unchanged — every message stays. Proposed: a thin
divider above the first kept message, "Earlier messages summarised for the
assistant", so a user who notices the assistant being vaguer about old detail
understands why (Claude Code draws the same boundary). The Admin → Chats
viewer would show the summary itself, expandable, since an admin reading a
support case needs to know what the model could and could not see. **Both are
the owner's call** (§7).

### 4g. Accounting

Every summarisation call is a `usage_records` row with a new role,
**`compaction`**, on the front-end model, charged to the person whose turn
triggered it (the chat's owner for the sweep). It appears in Admin → Usage's
role table, the weekly report and the console like any other role. Expected
scale: ~$0.03 per compaction at gpt-5.6-luna rates.

### 4h. The ordering fix (goes in the same release, cannot wait for it)

- One helper, `orderThreadRows()`, used by **every** loader that reads a
  thread (`chat-turn`, `chat-view`, the admin viewer, feedback snapshots,
  export, the memory pass): sort by `createdAt`, then role (**user before
  assistant** before system), then `id`. Deterministic on every database, on
  every plan, for ever.
- The OWUI importer stops writing ties (a message whose timestamp equals the
  previous one is nudged forward by a millisecond).
- A one-off data repair for the existing imported rows — `+1 ms` per row
  inside each tied group, user first — so SQL consumers (the console, search
  ordering, the memory pass's "newest turns") agree with the app. Timestamps
  from OWUI were only ever second-accurate, so a millisecond changes nothing
  anyone can see. Reversible in effect (the app-side sort would give the same
  order without it); listed here so it is a decision, not a surprise.

Effect on the Portal A chat **on its own**, before compaction: each turn would
read ~525k at $0.30/M ($0.16) instead of writing it at $3.75/M ($1.97).
Compaction then brings the 525k down to ~25–96k.

---

## 5. Expected cost effect

Per message in the Portal A chat: **~$2.00 today → ~$0.05–0.10** (read of a
25–96k prefix at 0.1× plus the reply's output tokens), with one ~$0.03
summarisation every ~40 messages.

Estate, on the last 30 days' shape: turns over 96k were $68 of Portal B's $137 and
$43 of Portal A's $45. Compacted, those turns cost roughly a fifth to a quarter
of that. **Roughly $85–95 of the ~$190 spent on conversation calls in the last
30 days would not have been spent**, before any model routing.

---

## 6. How it will be proven before it ships

Unit (pure, no keys): boundary selection (whole turns; keep budget; a chat
smaller than the trigger is untouched), chunk planning (an oversize single
message splits; chunks never exceed the cap), token estimate, prompt
rendering, the boundary-missing invalidation rule, settings clamps and the
`compactAt ≤ maxInputTokens` rule, `orderThreadRows` (ties resolve user-first,
identical output for any input order), importer never writes ties, and
`backup.test.ts` picks up the new table from the schema automatically.

Live harness `scripts/test-compaction.ts` (own dev server on its own port, real
front-end AND conversation models, the run-harness pattern from 2026-09-09):

1. seed a ~110k-token chat with five facts planted early (a name, a figure, a
   date, a decision, a template paragraph); send a message → the phase line
   shows; a compaction row exists; the conversation model's prompt was **≤
   the trigger** (from `usage_records`, all four tiers summed);
2. the reply **recalls at least four of the five planted facts** — the
   summary carries information, not just fewer tokens;
3. a second message: cache **read ≥ 70%** of the prompt — caching works after
   compaction;
4. Retry keeps the compaction; editing a message from before the boundary
   invalidates it, and the next turn re-compacts;
5. a 400k-token seed in the dfleary shape (tied timestamps included) compacts
   in chunks and the replay order is user-first — read back from the prompt
   actually sent (dev.log);
6. usage rows carry `role=compaction` on the front-end model, with cost;
7. the sweep compacts an oversize idle chat, skips one with a live turn, and
   bumps nobody's `updated_at`;
8. the divider (if adopted) renders, survives reload, and shows in the admin
   viewer; nothing is drawn on an uncompacted chat.

Re-run of the existing harnesses it touches: `test-curation`, `test-edit-revert`,
`test-stream-resume`, `test-shared-chat` (compaction inside a shared chat),
`test-owui-import` (the real backup, 24 checks — the importer changes),
`test-backup` (the new table round-trips), `test-admin-chats`, the console
harness (the new usage role). Then typecheck and the full unit suite.

After the deploy, in production: the four sweep logs; the next two turns on
the Portal A chat (prompt ≤ 96k, cache read on the second); and the
size-bucket query from §1a re-run a week later with `≥ 200k` at zero.

---

## 7. Decisions for the owner

1. **The divider in the chat** ("Earlier messages summarised for the
   assistant") — show it, or keep compaction invisible to users?
2. **The summary in Admin → Chats** for support reading — yes/no.
3. **The millisecond data repair** for imported timestamps — do it, or rely on
   the app-side sort only.
4. **Defaults 96k / 20k** — fine, or different numbers.

Everything else above is proposed as decided unless told otherwise.

---

## 8. Out of scope (deliberately)

- Model routing (cheaper models for simple requests) — the owner's next item,
  after this ships.
- Making the Think toggle cheaper (it is a full re-write per switch by
  Anthropic's design; ≤ $0.36 after compaction).
- Anthropic's server-side compaction beta — an option to revisit if we ever
  want Sonnet, not Luna, writing the summaries on Anthropic-only instances.
- The 1-hour cache TTL (2× write) — the audit on 2026-09-04 found it nets to
  zero on this estate's usage pattern.

## Appendix — the evidence trail (session scratch, read-only)

- Production queries: `compact1.sql` … `compact8.sql` over all four portals via
  `docker exec … psql` (sizes, buckets, `curator` rows, cache behaviour by gap
  and by prompt size, the big chat's per-turn ledger and rows, tie counts,
  plans, physical order).
- `scripts/_probe-cache.ts` — the provider probe (A1–A5, B1–B3 above).
- `scripts/_probe-ties.ts` / `_probe-ties2.ts` — tie-order stability on the
  index plan (stable) and the production Sort plan with scrambled physical
  order (changes every turn).
- The two research briefs (Anthropic; OpenAI/Gemini/industry) with source
  URLs for every claim in §2.
