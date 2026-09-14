# OPNinfer v0.5.1 — Better user memory: research and proposal

*Status: **BUILT 2026-09-04, awaiting the owner's local test before deploy.**
Proposed and confirmed the same day with two changes from the owner: **no
pass after every reply — the pass runs once a chat has been quiet for 30
minutes**, and **nothing is shown to the user when memory changes** (no
"Memory updated" chip; the notes are simply there in Settings). Everything
else in §3 was built as written; §3.2 and §3.3 below describe the original
proposal and are superseded by those two decisions. Proof:
`scripts/test-memory-v2.ts` (live, real model, two browsers' worth of
steps A–I). Day-to-day facts in `CLAUDE.md` → Agentic tools → Memory v2.
Original ask: "the current implementation is lacking, not sure why — research
how OpenAI and Anthropic do it and explain what you would do."*

## 0. Why it feels lacking — the numbers

On the only live instance at the time (11 people, five weeks since launch):

| Since launch (2026-07-29) | Count |
| --- | --- |
| Chats started | 267 |
| Messages people wrote | 1,289 |
| Memories the assistant saved | **14** |
| People with any memory at all | 6 of 11 (44 more memories are old ones imported from Open WebUI) |

One memory per ninety messages. The code works — every checklist item in §8
passes — but the assistant almost never *decides* to remember anything. Reading
the implementation, that is exactly what it was built to do:

- **Nothing tells it when to save.** The only steering is the tool description
  ("remember a lasting fact or preference"). The system block it sees each turn
  says *apply memories silently and keep them current*, not *notice things
  worth keeping*. So it saves when someone says "remember that" and otherwise
  gets on with the reply, which is what a busy model does.
- **Memory is a flat pile of one-line sentences** with numeric ids. There is no
  shape (who you are / how you like replies / what you're working on), so
  nothing is ever merged: "prefers bullet points" and "likes short bulleted
  answers" become two lines, and "moved from marketing to sales" becomes a
  third line beside the old job rather than replacing it.
- **The budget is a wall, not a tidy-up.** At 2,000 characters a save fails with
  "delete or shorten an existing memory first" — an error handed to a model in
  the middle of answering someone, which it quietly ignores.
- **Nothing ages.** A memory from July reads exactly like one from today; there
  is no "last confirmed" date, no notion that "planning a trip in August" has
  become "went in August".
- **It only knows facts, never conversations.** "What did we decide about the
  pricing page last month?" has no answer: the assistant cannot look at past
  chats. The search box on the sidebar is for people, not for it.
- **Nobody sees it happen.** ChatGPT shows "Memory updated" under the reply;
  here the only place to notice a save is the settings panel, so people don't
  build trust in it and don't correct it.

## 1. How OpenAI does it (ChatGPT, as of 2026)

Two layers, both on by default:

1. **Saved memories** — an explicit, editable list. The model decides to save
   (or you say "remember…"), a small **"Memory updated"** tag appears under the
   reply, and the list lives in Settings where you can read, edit and delete
   entries. These are included in every future reply, like custom instructions
   that keep themselves current.
2. **Reference chat history** — the model may draw on *anything* from past
   chats without a saved entry. Since June 2026 this runs on a background
   process OpenAI calls **"dreaming"**: it reads across your conversations and
   **rewrites one memory summary** of you, revising outdated facts as time
   passes ("you're going to Singapore in July" → "you went in July"). OpenAI
   reports factual recall rising from 41.5% to 82.8% with it.

Controls: turn either layer off, temporary chats that never touch memory,
per-project memory, delete individual entries or everything. The criticism
that followed the June change is instructive: the summary view "won't include
everything ChatGPT remembers", the choice of what to keep is no longer the
user's, and shared accounts blend two people into one profile.

## 2. How Anthropic does it (Claude.ai, as of 2026)

- Memory is stored as **individual topics, not conversation summaries**, and it
  **updates as you talk** (made live in July 2026), plus "remember this" on
  request.
- **Settings → Memory → Topics** lists every topic; open one to read it, edit
  it, or delete it — and "fix something in one topic and the change applies to
  every conversation from then on".
- **Each Project has its own memory space**, so client work never leaks into
  another client's project.
- **"Search past chats" is a tool the model calls** (retrieval over your own
  history, shown as a tool call, answers cite the chat) — that is how "what did
  we discuss about X?" works, separately from memory.
- **Sensitive topics are excluded by default** (health, religion, politics,
  identity; opt-in), and some things are never stored (ID numbers, criminal
  history, financial account numbers, immigration status).
- Incognito chats never touch memory. Controls: **pause** (keep what it has,
  stop learning) and **reset**. On by default for individuals, **off by default
  for Team/Enterprise** until the organisation's owner enables it.

Anthropic also ships a developer-side **memory tool** on the API: a directory
of files (`/memories`) the model reads at the start of a task and edits with
view / create / replace / insert / delete / rename, and the API adds a prompt
telling the model to check its memory before doing anything and to record
progress as it works. That is a primitive for long-running agents (it is what a
"notes the model keeps organised" design looks like), and it is Anthropic-only —
OPNinfer talks to three providers, so the same idea has to be built as our own
tools rather than adopted as that tool type.

## 3. What I would build — "memory that notices", in plain terms

Both companies converged on the same three things: **the model keeps a small,
organised profile rather than a list of quotes; a background pass keeps it
current without the user asking; and past conversations are reachable by
search rather than crammed into memory.** OPNinfer has the pieces for all three
(a cheap front-end model, an idle timer per chat, Postgres full-text search).

### 3.1 Topics instead of a pile

Replace the flat list with a handful of **named topics** per person, each a
short editable note the assistant maintains:

| Topic | What goes in it |
| --- | --- |
| About you | name, role, team, how to address you, language |
| How you like replies | format, length, tone, units, "don't do X" |
| Your work | ongoing projects and decisions, each dated |
| Rules you've given | explicit standing instructions ("never suggest we outsource") |

The assistant edits a topic **by rewriting it**, never by appending a line, so
consolidation and contradiction-fixing happen naturally: "moved to sales"
replaces "marketing lead" in *About you* instead of sitting next to it. Each
topic is size-capped (say 800 characters); the whole set is what rides every
turn (about 1,000 tokens at most — cheaper than today's worst case and far more
useful). Settings shows the topics as editable text, exactly like Claude's
Topics view, and edits apply from the next message. The existing memory
adjustment chat stays as the conversational way to do the same thing.

### 3.2 A background memory pass after each reply (the fix for "it never saves")

The conversation model should not be asked to notice memories while it is busy
answering — that is why it doesn't. Instead, **after a reply lands**, a cheap
pass on the front-end role (the same role that titles chats and writes
follow-ups) looks at the last exchange plus the current topics and answers one
question: *is there anything lasting here?* — a stable fact, a preference, a
standing instruction, a project or decision, or an explicit "remember this".
If so it returns the **updated topic texts**; if not, nothing changes. It runs
off the reply's critical path (the person is already reading the answer), is
told today's date so it can retire stale lines ("was planning → done"), never
runs for incognito or shared chats, skips one-word turns, and is throttled to
once per reply. This is Claude's "updates as you chat" and ChatGPT's
"dreaming" at the scale of one turn.

The explicit tools stay for the immediate cases: "remember that…" and "forget
my old job" are handled in the reply itself, instantly, with an
acknowledgement — the two layers ChatGPT keeps.

Cost, for scale: at that instance's rate (1,289 messages in five weeks) the pass is
roughly a few million cheap-model tokens a month — pennies, and it only runs
when a person actually wrote something.

### 3.3 Show it happening: a "Memory updated" chip

Under any reply after which memory changed, a small chip: **Memory updated ·
About you**. Click it to see the exact change; **"Don't remember this"** on the
chip undoes it in one click. This is the trust piece both products got right
(and the one ChatGPT's June change was criticised for weakening). Settings gets
"last updated" per topic.

### 3.4 Time-aware memory

Every line in *Your work* carries a month ("[Aug 2026] rebuilding the pricing
page"); the background pass rewrites completed things in the past tense and
drops what is no longer relevant. Topics untouched for six months get a quiet
"still right?" marker in Settings rather than silent deletion — a person
decides, never a timer.

### 3.5 Let the assistant search your past chats

A new tool for the model, `search_my_chats`, over the person's own
non-incognito chats using the full-text search that already powers the sidebar
search — dated snippets with links, cited in the reply ("from your chat on
12 August"). No vector database at this scale; Postgres full-text with an index
is enough for a few thousand chats per person, and it can be upgraded later
without changing the tool. This answers "what did we decide about X" without
memory having to hold everything, which is exactly Claude's split.

### 3.6 Guardrails and controls

- The background pass is told not to keep **health, religion, politics,
  sexuality, personal finances, ID numbers** unless the person explicitly asks
  it to remember them (Claude's default; ChatGPT has similar exclusions).
- **Per person:** *Pause* (keep what it knows, stop learning), *Reset*
  (forget everything), and the per-topic edit/delete.
- **Per instance (admin):** memory on / off / paused for everyone, the size
  per topic, and whether the chat-search tool is offered. Claude ships memory
  **off by default for organisations**; I would keep OPNinfer's **on**, since
  every instance is a single company, but make the switch obvious.
- Incognito and shared chats stay out (already the rule).

### 3.7 Migration

The 58 existing memories are folded into the *About you* topic as they are
(a plain bullet list, no model call, nothing lost), and the next background
pass on each person's next chat tidies them into the right topics. The
Open WebUI-imported ones come along the same way.

## 4. Decisions for you

1. **Background pass after every reply** (recommended) versus **once when a
   chat goes idle** (piggy-backing on the five-minute follow-up timer —
   cheaper, but the "Memory updated" chip would appear late or not at all).
2. **Four fixed topics** (recommended — predictable for people to read) versus
   letting the assistant create its own topics (Claude's way; tidier for power
   users, messier to present).
3. **The chip's undo** as "Don't remember this" only, or also "Edit" inline.
4. **Sensitive categories excluded** by default (recommended), with the person
   able to say "you can remember my health condition".
5. **Chat search** in this release, or as a follow-up. It is the most useful
   single addition and the smallest piece of work; I would include it.

## 5. What it would take

Six pieces, one commit each, harness-proven like the last two releases:

1. Data: `user_memory_topics` (person, topic key, text, updated_at); fold the
   old rows in; the block the model sees becomes the topics.
2. The background memory pass on the front-end role, off the critical path,
   with the date, the exclusions and the throttle; unit-tested on recorded
   exchanges ("I'm the marketing lead and I like bullet points" → *About you*
   and *How you like replies* change; a one-word "thanks" → nothing).
3. The explicit tools re-pointed at topics (remember / forget / correct), plus
   the "Memory updated" chip and its undo.
4. Settings: topics as editable notes, last-updated, pause / reset.
5. `search_my_chats` over the person's own chats, cited in replies.
6. Admin switches; docs; checklist §20; a two-chat harness proving: an
   unprompted fact is remembered in a new chat, a contradiction replaces rather
   than accumulates, "forget" works, a decision from an earlier chat is found
   by search, incognito and shared chats never learn, a health remark is not
   kept.

## Sources

- [Memory and new controls for ChatGPT — OpenAI](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [Dreaming: better memory for a more helpful ChatGPT — OpenAI](https://openai.com/index/chatgpt-memory-dreaming/)
- [Memory FAQ — OpenAI Help Center](https://help.openai.com/en/articles/8590148-memory-faq)
- [ChatGPT now quietly rewrites its memories of you — XDA](https://www.xda-developers.com/chatgpt-quietly-rewrites-its-memories-of-you-not-sure-i-like-it/)
- [ChatGPT memory vs reference chat history — MemX](https://memx.app/blog/chatgpt-reference-chat-history-vs-saved-memories/)
- [Use Claude's chat search and memory — Anthropic Help Center](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- [Memory tool — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Managing context on the Claude Developer Platform — Anthropic](https://www.anthropic.com/news/context-management)
