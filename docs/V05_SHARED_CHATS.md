# OPNinfer v0.5 — Shared chats: design proposal

*Status: **BUILT 2026-09-04, awaiting the owner's visual test before
deploy.** Proposed the same morning, confirmed by the owner with one change
(decision 4: a separate "Shared" sidebar section), then built in one pass
exactly as written below and proven by `scripts/test-shared-chat.ts` — 50
checks, two real people in two browser sessions against a real model — plus
the re-run of every existing harness the change touches (listed in
`CLAUDE.md` → Status). This file is now the design record the way
`docs/V04_AGENT_TIER.md` is for the Sandbox tier; the day-to-day facts and
the two traps found live are in `CLAUDE.md` → Chat workspace → Shared chats.
Owner rule for this feature: tested on the local dev box first, deployed
only when the owner says so.*

## 0. The idea, in one paragraph

A person starts a chat as they do today. Once it exists they can **share it
with one or more colleagues** on the same portal. From then on it is **one
conversation with several people in it**: everyone sees the same transcript,
every message shows **who wrote it** (avatar and name), and when the
assistant replies **everyone watches the same reply stream in at the same
moment**. Anyone in the chat can talk to the assistant, attach files, answer
its questions, steer a task that is mid-way, or line up a message to go the
instant the current reply finishes. The chat stays **the creator's**: only
they can invite, remove people, or delete it; everyone else can leave. A
**People** panel shows who has access and lets the owner remove anyone. As
far as we know no major AI product offers a live multi-person chat with the
model like this.

## 1. What a person sees

**Sharing.** In any of your chats (not incognito) the top bar gains a
**People** button (two-heads icon, with a small count once shared). It opens a
panel listing everyone in the chat — you first, marked *Owner* — with a
search box to add a colleague by name or email from the portal's user list.
There is no invitation to accept: the moment you add someone the chat appears
in their sidebar, and if they are online a small notice tells them.

**The invitee.** The chat shows in their sidebar with the shared icon,
ordered by recency like any other. Opening it shows the full history so far,
with the owner's avatar and name on the messages the owner wrote. They type
and send exactly as in their own chats.

**The live session.** With several people in the chat, everything that
happens appears on every open screen within a moment: a message someone else
sends, the assistant's reply as it streams (word by word, the same reveal
everyone else sees), its working steps, images and files as they are
presented, the question card when it asks something, a scheduled message
someone lined up, a renamed title, a person added or removed. Nobody needs to
refresh.

**Who wrote what.** Messages from people keep their place on the right, the
assistant stays on the left, and in a shared chat each human message carries
a small avatar + first name above it (your own included, so the transcript
reads the same on every screen). Attachments sit on the message of whoever
attached them.

**Scheduling and steering, with several people.** While the assistant is
replying, anyone can still send. The message is first offered to the running
task (if the assistant is between steps it is spliced straight in, as today —
the chip reads *Steering the task*); otherwise it is **scheduled**, shown
above the composer to **everyone** as *Scheduled — Priya: "…"*. Several people
can each schedule one. When the reply finishes the portal sends them in the
order they arrived, one reply each. You can cancel your own scheduled
message; the owner can cancel anyone's. (This also fixes a quirk of today's
solo scheduling: a scheduled message now survives a refresh, because the
portal holds it rather than your browser tab.)

**The assistant's questions.** When it raises a question card, everyone sees
the card; the first person to answer settles it and the card shows *Answered
by Sam* on every screen. Typing a reply directly under the card answers it as
today.

**Files.** A shared chat has one shared workspace. Anyone can attach files;
anyone in the chat can open or download any file in it, including what the
assistant produces; the assistant sees them all. Files someone uploaded stay
in the chat if that person is removed or leaves.

**Removing, leaving, deleting.** The owner removes someone from the People
panel; the removed person's screen shows *You no longer have access to this
chat* and returns them to the chat list, and their links to its files stop
working at once. Leaving does the same, self-served, from the chat's menu.
If the owner deletes the chat it is gone for everyone (it is one chat), with
the same notice on any open screen.

## 2. The rules (who may do what)

| Action | Owner | Member |
| --- | --- | --- |
| Read the whole transcript, live | ✓ | ✓ |
| Send messages, attach files, use the mic | ✓ | ✓ |
| Answer the assistant's question card | ✓ | ✓ |
| Steer a running task; schedule a message | ✓ | ✓ |
| Cancel a scheduled message | any | own only |
| Download / open any file in the chat; export the chat | ✓ | ✓ |
| Copy, Listen, Retry the last reply | ✓ | ✓ |
| Rate a reply (thumbs) | own rating | own rating |
| Edit-and-revert a message | own message, only if it is the latest human message | same |
| Rename (incl. Rename with AI) | ✓ | ✓ |
| Star | personal — your star is yours alone | same |
| Invite people, remove people | ✓ | — |
| Leave the chat | — | ✓ |
| Delete the chat | ✓ | — |
| Make it incognito | never (incognito chats cannot be shared) | — |

## 3. Decisions taken for you — confirm or change any

1. **Adding people is direct, no accept step.** It is a private company
   portal; the chat simply appears for them and they can leave. (Alternative:
   an invite they accept first — more clicks, little gain.)
2. **Anyone on the portal can be added**, found by name or email from the
   portal's user list (disabled accounts excluded). No admin approval.
3. **Your messages stay on the right, others' too; the assistant stays on the
   left.** The avatar + name label tells people apart. (Alternative, like a
   messaging app: yours on the right, everyone else's on the left. I recommend
   against it — the left is the assistant's side, and the transcript would
   look different on every screen.) *This is a visual call — yours.*
4. **A separate sidebar section called "Shared"** (owner decision,
   2026-09-04) holds every shared chat — the ones you shared and the ones
   shared with you — above the normal date-grouped list. Chats shared *with*
   you show the owner's avatar in the row. The normal list shows only your
   private chats.
5. **A dot on a shared chat in the sidebar** when someone else has written in
   it since you last opened it. Cheap to add once the live plumbing exists;
   say the word if you would rather not have it.
6. **Presence in the People panel**: a green dot next to anyone who has the
   chat open right now. Free with the live plumbing. No "Priya is typing…"
   indicator — noise.
7. **Personal memory is OFF in a shared chat.** Your memory is private and the
   assistant's replies are on everyone's screen, so it must not draw on
   anyone's memory nor save anything from a shared chat into anyone's memory —
   the same rule incognito already follows. It switches back on if the chat
   ends up with just the owner again.
8. **Each reply is charged to the person whose message triggered it.** The
   admin's per-person usage, the Logs feed and the weekly report stay
   accurate. A mid-task steer does not change who the running reply is
   charged to.
9. **Editing is limited** to your own message and only when nothing anyone
   else wrote comes after it — because edit-and-revert deletes everything
   after that point, and one person must never be able to delete another's
   words. (Alternative: the owner may edit anything. I recommend the strict
   rule.)
10. **Rating is per person.** Two people can rate the same reply differently;
    the Feedback page shows who rated. The button shows your own rating.
11. **Rename is open to everyone in the chat**; delete/invite/remove are the
    owner's alone. "Delete all my chats" deletes the chats you own (including
    shared ones — they are yours) and merely *leaves* chats shared with you.
12. **If the owner's account is deleted by an admin, their shared chats go
    with it**, as every chat does today. (Alternative: hand them to the
    longest-standing member. Recommend the simple rule; can add a transfer
    later if it is ever needed.)
13. **One reply at a time per chat, as today.** If two people send at the
    same instant while the assistant is idle, the first starts the reply and
    the second's message is scheduled automatically — nobody sees an error.
14. **No email notifications** for shared-chat activity. In-app only.
15. **Version 0.5.0**, with one line in the release notes: *"Share a chat with
    a colleague and work in it together — everyone sees the same replies live."*
16. **Files belong to the chat, not the uploader.** When a member leaves or is
    removed (or their account is deleted), the files they added stay in the
    chat and are re-stamped to the owner — otherwise deleting that person's
    account would silently delete files out of someone else's chat (see the
    appendix for why).

## 4. Not changing / out of scope

- Admins are not automatically in every chat. Admin → Chats works as today
  (behind the admin's own password): a shared chat is listed under its owner
  with a *shared with N* marker, and the viewer shows who wrote what because
  it renders with the same component.
- No per-chat permissions finer than owner/member (no read-only members).
- No sharing across portals, no public links, no guests.
- No email notifications, no typing indicators, no message threads/replies.
- Incognito chats stay strictly private.

## 5. How it works underneath (short version)

- **Who is in a chat** — a new `conversation_members` table: chat, person,
  who added them, when, plus the member's personal star and when they last
  opened it. The creator stays the owner via the existing
  `conversations.user_id` column, so every existing chat is unchanged.
- **Who wrote a message** — a new author column on `messages` (empty on old
  rows = the owner). It rides the stream events too, so a live-sent bubble
  gets its avatar without a reload.
- **One access rule, used everywhere** — a small pure module answers *can
  this person read / write / manage this chat?* and every route, action and
  page loader that today checks "is this the owner" calls it instead. The
  sweep (appendix) is the bulk of the work and is what makes "every feature
  works" true rather than hoped.
- **Live, for everyone** — each open chat screen holds a lightweight live feed
  (the same technique the admin Logs page and the resumable reply stream
  already use). It carries: a message from someone else, *reply started* (the
  screen then attaches to the reply stream that already exists for resuming
  after a refresh — so every screen literally reads the same buffer),
  scheduled-queue changes, a question answered by someone else, people
  added/removed/left, title changes, reverts, deletion. In memory on the
  single instance, like the reply registry. If the feed drops and reconnects,
  the screen quietly reloads the thread.
- **The scheduled queue moves server-side** — a per-chat queue held by the
  portal, drained in order when the reply ends, each entry a normal turn sent
  as its author (attachments included). The mid-task steer keeps working from
  anyone and now carries the sender's identity so the spliced-in bubble is
  attributed correctly.
- **Charging** — the usage row for a reply carries the id of whoever sent the
  triggering message.
- **Memory off** — the same exclusion incognito uses (no memory block, no
  memory tools) applies while the chat has members.
- **Files** — nothing moves: the per-chat pool already is the shared
  workspace. Only the access checks on upload, download, context view and
  presenting change from "owner" to "anyone in the chat".
- **Backups** include the new table automatically (the backup test pins every
  model in the schema, so it cannot be forgotten).

## 6. Every existing feature, checked against a shared chat

| Feature | In a shared chat |
| --- | --- |
| Streaming reply, paced reveal | Identical on every screen; late joiners attach mid-reply |
| Resumable stream (leave/refresh) | Works per screen as today |
| Stop | Anyone in the chat can stop the running reply |
| Steering mid-task (interject) | Anyone; bubble attributed to the sender |
| Scheduled message | Shared queue, visible to all, in arrival order |
| Question card (`ask_user`, incl. the Sandbox's questions) | Everyone sees it; first answer settles it; *Answered by X* |
| Attachments, uploads, paste-to-attach, mic | Anyone; shown on the sender's message |
| File chips, context view, download, Download all | Anyone in the chat |
| Presented files and images, image generation | Appear on every screen as presented |
| Sandbox agent | One container and session per chat, whoever asks |
| Web search, sources pill | Unchanged |
| Visualisations | Unchanged |
| Skills, escalation, failover | Unchanged |
| Memory | Off while shared (see decision 7) |
| Follow-up suggestions | Generated once per reply, shown to all; clicking sends as you |
| Copy / Listen / Retry | Anyone |
| Thumbs rating, Feedback page | Per person; page shows the rater |
| Edit-and-revert | Own message, latest human message only |
| Rename, Rename with AI, tab title | Anyone; everyone's tab updates |
| Star | Personal |
| Search | Includes chats shared with you |
| Export JSON | Anyone in the chat |
| Incognito | Cannot be shared |
| Delete, delete all, account deletion | Owner's; members leave instead |
| Completion chime | Rings for every screen with the tab in the background |
| What's new, browser tab titles | Unchanged |
| Admin → Chats viewer | Shows members and who wrote what |
| Admin → Users → View chats | Includes chats the person is a member of |
| Usage, Logs, weekly report | Attributed to the sender of each turn |
| Backup & restore | New table included |
| Deploy drain | Unchanged (turn registry unchanged) |

## 7. How it will be built and proven

Seven stages, one commit each, every stage live-tested on the dev box before
the next; nothing deployed until the owner has tested it visually:

1. **Data and the access rule** — members table, author column, the pure
   access module with unit tests, and the sweep of every owner check.
2. **People panel** — invite (user search), remove, leave; sidebar marking and
   the owner's avatar on shared rows; audit rows (`chat.share`, `chat.unshare`,
   `chat.leave`).
3. **Who wrote what** — author on stored and live messages, avatar + name in
   the bubble, in the admin viewer for free.
4. **The live feed** — the per-chat feed and the screen's hook: others'
   messages, reply-started → attach, people changes, deletion/removal
   bounce, title, presence dots, unread dots.
5. **The shared scheduled queue** — server-side queue replacing the
   browser-only one; steering carries identity.
6. **The rest** — per-person ratings, answered-by on the card, the edit rule,
   memory off, search/export/files access, charging.
7. **Docs and release** — `CLAUDE.md`, checklist §19, `CHANGELOG.md`, version.

Proof: unit tests for the access rule, the queue order and the feed registry;
one live browser harness, `scripts/test-shared-chat.ts`, with **two real
users in two browser sessions**, proving in one run: share → appears for the
other person → both see the same reply stream live (compared byte for byte at
the end) → the other person's message appears live on the first screen with
their avatar → two scheduled messages from two people run in order → a steer
from the non-sender lands mid-task → a file the invitee attached is read by
the model and downloadable by the owner → the question card answered by the
other person → rating stored per person → the invitee cannot delete, invite
or edit the owner's message → search finds the shared chat for the invitee →
remove bounces them and every route refuses them → delete removes it for both.
Then the existing harnesses re-run: stream-resume, interject, ask-user,
present-files, edit-revert, admin-chats, search, what's-new.

## 8. Appendix — where the owner check lives today

From a sweep of the code (2026-09-04). Every gate is the same shape — the
conversation's `userId` (or a file's `userId`) compared with the signed-in
user — and there is no membership concept anywhere yet. Three shapes exist,
and all three must go through the one new access rule:

**Shape 1 — "this conversation, owned by me"** (`where: { id, userId }`):

- `src/app/chat/layout.tsx:16` — the sidebar list (the ONLY query behind it;
  needs an OR over membership, and the row shape gains owner/shared fields).
- `src/app/chat/[id]/page.tsx:31` (`generateMetadata`) and `:49` (the thread
  loader) — two separate checks, both widen.
- `src/app/actions/conversations.ts:16` (`ownedConversation`, behind rename +
  pin), `:25-42` (`deleteConversationsWithStorage`, ownership baked into the
  where twice), `:81` / `:94` / `:115` (delete / bulk delete / delete all —
  stay owner-only; members LEAVE), `:133` (Rename with AI, own check).
- `src/app/api/chat/route.ts:282` (regenerate) and `:303` (send); `:377` the
  creator becomes owner (unchanged); `:466` + `:486` the two incognito memory
  exclusions (become "incognito OR shared").
- `src/app/api/chat/stream/route.ts:32`, `chat/stop/route.ts:32`,
  `chat/interject/route.ts:33`, `chat/answer/route.ts:53` — the four live-turn
  routes; each is the only thing binding a caller to the app-wide turn / ask /
  interjection registries, so each must admit members.
- `src/app/api/chat/incognito-cleanup/route.ts:31` — owner AND incognito;
  unchanged (incognito is never shared).
- `src/app/api/conversations/[id]/export/route.ts:20`,
  `src/app/api/followups/route.ts:38`, `src/app/api/search/route.ts:33`,
  `src/app/api/files/route.ts:66` (upload target check).

**Shape 2 — nested on a message** (`conversation: { userId }`):

- `src/app/actions/messages.ts:23` (`rateMessage`) and
  `src/app/api/tts/route.ts:43` (Listen).

**Shape 3 — files gated on the UPLOADER, not the chat** (`File.userId`). This
is the trap: the pool on disk is already per chat, but the rows and the
download route follow whoever created the file, and `pool-sync.ts:183`
stamps agent-generated files with the acting user's id — so in a shared chat
the owner could not download a file the assistant made during a member's
turn. All of these switch to "any member of the file's conversation":

- `src/app/api/files/[id]/route.ts:31` (download — the admin sudo exception
  at `:33-46` stays), `files/[id]/context/route.ts:27`,
  `files/status/route.ts:25` (files not owned by the caller silently drop
  out of the poll), `src/app/actions/files.ts:11` (`deleteFile`), and
  `src/app/api/chat/route.ts:400` (attaching uploaded ids to the turn —
  scoped by uploader, so a member's attachment would silently not attach).

**Already conversation-scoped, no change needed:** `storage.ts` pool paths,
`file-tools.ts` (`list_files` / `read_file`), `tools/present.ts`,
`tools/view-image.ts`, `chat-thread.ts` and `message-files.ts` (pure, no
authorisation — the gate stays in the callers), the admin viewer
(`admin/chats/[id]/page.tsx:26`, by id behind sudo).

**Identity that flows through tools:** `ToolCtx.userId` is the ACTING user
(`tools/types.ts:60`) — image quotas, generated-file rows, package tallies,
the agent proxy grant and usage all follow it, which is exactly decision 8
(charge the sender). Memory tools (`tools/memory.ts`) are strictly per user
and never conversation-aware; the exclusion lives in the chat route.

**Client shapes that gain fields:** `ConversationItem` (`sidebar.tsx:22` —
no owner/shared flag today), `UIMessage` (`message-bubble.tsx:50` — no
author), and the `meta` / `done` / `interjected` stream events (author).

**Schema facts that matter:** `messages` has no author column;
`usage_records.user_id` and `message_feedback.user_id` are nullable SET NULL
(the rater / sender survive deletion); `files.user_id` is required and
cascades with the USER — a removed member's uploads must therefore be
re-stamped or the cascade changed, or deleting that person's account would
delete files from someone else's chat. Decision: re-stamp to the owner when
a member is removed/leaves, and on account deletion.
