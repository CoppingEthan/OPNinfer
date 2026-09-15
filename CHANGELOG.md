# Changelog

Release notes shown in-app by the **What's new** panel (account menu → What's
new). Newest first.

Four rules for writing these, because they are read by CLIENTS, not by us:

1. **Plain and short.** One line per item, in the words a user would use. No
   internals — no tool names, model names, file names, or how it works. If a
   line needs a comma-heavy explanation, it belongs in `CLAUDE.md` instead.
2. **Never mention a client-specific capability.** This file ships inside the
   shared app image, so every portal shows the same notes — a feature built for
   one client must not appear on another client's screen.
   **Nor anything admin-only.** Every user sees this panel; admin settings,
   billing and cost reporting are not their concern and read as noise (or as
   things they can't find). Admin-facing changes belong in `CLAUDE.md`.
3. **Headings must read `## <version> — <date>`** or the panel skips them. A
   heading with no version (`## Unreleased`) is ignored on purpose, so work in
   progress can be written up early and given its version when the release is
   cut. Notes for a version newer than the running app are never shown either.
4. **Roll security work, fixes and anything behind the scenes into ONE line.**
   Only things a user can SEE AND USE get a line of their own. Everything else
   — hardening, bug fixes, performance, infrastructure — becomes a single
   *"General security, feature and UX updates."* An itemised list of fixes
   reads as "this was unreliable and now isn't", which is not what anyone
   wants to learn about the tool they rely on; an itemised list of security
   work tells every reader where the locks are; and no user ever needs to know
   which feature was broken. (Owner rule, 2026-09-07, after 0.5.2's notes
   listed a whole audit's findings.)

## 0.7.0 — 2026-09-15

- **Folders** — group your chats into folders in the sidebar.
- **Workflows** — write down how you like a job done once, and the assistant
  follows it. Pick one for a single message from the + button.
- **Preview files beside the chat** — open a document on the right, laid out the
  way Word, Excel or PowerPoint would show it. Spreadsheets appear as tables,
  and a file updates in place as the assistant changes it.
- General security, feature and UX updates.

## 0.6.2 — 2026-09-14

- **Add it to your phone** — the assistant installs to your home screen with its
  own icon, and opens full screen without the address bar.
- **Offline** — a clear message when your phone loses signal, instead of a
  browser error page.
- General security, feature and UX updates.

## 0.6.1 — 2026-09-10

- General security, feature and UX updates.

## 0.6.0 — 2026-09-10

- **Long chats stay quick** — once a conversation gets very long, the
  assistant keeps a summary of the older messages and works from that plus
  your recent ones. Your whole chat stays on screen; a thin line shows where
  the summary begins.
- **Messages in the right order** — some chats brought over from the old
  system could show a reply above the question it answered. Fixed.
- General security, feature and UX updates.

## 0.5.2 — 2026-09-07

- General security, feature and UX updates.

## 0.5.1 — 2026-09-04

- **A memory that actually remembers** — the assistant now keeps four short
  notes about you (who you are, how you like replies, your work, rules you've
  given) and fills them in itself from what you tell it, quietly, once a chat
  has been quiet for half an hour. Tell it "remember…" or "forget…" any time.
- **See and edit what it knows** — Settings → Assistant memory shows the four
  notes as text you can change, with a pause switch and a "Forget everything"
  button.
- **"What did we decide about…?"** — the assistant can look back through your
  own earlier chats and tell you, with a link to the chat.
- Health, religion, politics, money and ID details are never kept unless you
  ask it to remember them. Incognito and shared chats are never remembered.
- Charts and diagrams drawn in the chat now match dark mode — they no longer
  sit on a white panel with unreadable light text.

## 0.5.0 — 2026-09-04

- **Share a chat with colleagues** — open the People button in any chat to
  add someone from your organisation. Everyone in the chat sees the same
  replies as they are written, every message shows who wrote it, and anyone
  can send, attach files, answer the assistant's questions or line up a
  message for when the current reply finishes. Shared chats sit in their own
  "Shared" section in the sidebar; only the person who started a chat can
  add or remove people or delete it, and anyone else can leave.
- **Scheduled messages now survive a refresh** — a message you send while
  the assistant is still replying is held for you and sent the moment it
  finishes, even if you close the tab.
- **Chats you share never use your personal memory** — what the assistant
  remembers about you stays private to your own chats.

## 0.4.1 — 2026-09-02

- **Real graphics, not just pictures** — adverts, social posts, posters, flyers
  and mockups are built as proper designs at the exact size, with crisp text,
  and can be tweaked afterwards ("make it blue"). You're asked once whether
  you want that or a quick concept image.
- **Tidier replies** — the steps the assistant worked through fold away once
  it has finished (click to see them), and files and images appear at the
  point they were handed over.
- **Watch it write** — code now appears as it is being written, not all at
  once when it finishes.
- **Updated images show straight away** — a design you asked to change no
  longer shows the old version until you refresh the page.
- **Chat titles are back** for conversations that were being left untitled.
- **Clearer file hand-overs** — files you're given show as cards with a
  coloured type icon, a readable name and a Download menu, plus "Download
  all" when there are several.

## 0.4.0 — 2026-09-01

- **A workspace that does the work** — ask for something substantial (a
  report, a set of images, a spreadsheet built from your files, a piece of
  code) and the assistant hands it to the Sandbox: it writes and runs code in
  its own private space, checks its own results, and presents you the
  finished files. You watch it work as it goes.
- **It remembers the job** — say "now make it blue" and the same work is
  picked up where it left off, not started again from scratch.
- **Redirect it, or stop it, mid-task** — type while it's working and the
  correction goes straight into the job; Stop ends it within a second.
- **Every chat is separate** — one chat's work is never visible to another.

## 0.3.3 — 2026-08-22

- **It asks instead of guessing** — when your request could mean two different
  things, you get a quick multiple-choice question and the answer picks up
  exactly where it left off.
- **What's new** — this panel. It appears once after each update, and you can
  reopen it any time from the account menu.
- **Chat names in your browser tab** — a row of open chats is readable again.
- **Long jobs get further** — big multi-step tasks are less likely to stop part
  way and ask you to say "continue".
- **Fixes** — tasks that run code now start reliably in a brand-new chat, and a
  couple of admin settings that quietly refused to save now do.

## 0.3.2 — 2026-07-30

- **An assistant that sounds like your business** — your admin can give it
  standing instructions that apply to every reply.
- **A weekly summary for admins** — spend, problems and system health, emailed
  every Friday.
- **Updates no longer interrupt you** — if an update starts while you are
  typing, your message is handed back rather than lost, and a reply already in
  progress is allowed to finish.

## 0.3.1 — 2026-07-29

- **Long answers are no longer cut short** — replies that used to stop
  mid-sentence, or fail to produce a promised file, now finish.
- **Uploaded files are read properly** — attachments were not being processed;
  they are again.
- **Admins can look at a chat to help** — if you report a problem, an admin can
  open that conversation. Incognito chats are never included.
- **Someone is told when something breaks** — the portal now emails an admin
  when it hits a problem, instead of failing quietly.
- Long links no longer stretch a message off the side of the screen.

## 0.3.0 — 2026-07-20

- **It can do things, not just talk** — search the web and read pages, remember
  what matters to you, create and edit images, write and run code, build charts
  and produce files you can download.
- **Watch it work** — code and output appear live as it goes, and tidy away
  into something you can reopen.
- **Listen to a reply** — a Listen button reads any answer aloud.
- **Change your mind** — edit one of your earlier messages and run again from
  there.
- **Leave and come back** — a reply keeps going if you switch chats, refresh,
  or close the tab, and is waiting when you return.
- **Redirect it mid-task** — type while it is working and it takes the
  correction into the job it is already doing.

## 0.2.0 — 2026-07-08

- **Attach anything** — documents, spreadsheets, presentations, PDFs, code,
  audio and video. It reads them properly rather than guessing from the name.
- **It can see images** you send it.
- **Talk instead of typing** — record a message and it is transcribed for you.

## 0.1.3 — 2026-07-02

- **Backups** — the whole portal can be saved and restored, automatically on a
  schedule.

## 0.1.2 — 2026-06-30

- **A proper workspace** — a resizable chat list with search, starring,
  renaming and tidying up.
- **Incognito chats** that delete themselves when you leave.
- **Make it yours** — light or dark, and a profile picture.
- **On every reply** — copy, retry, and a thumbs up or down that tells us what
  is working.
- **Small comforts** — a chime when a reply lands in a tab you are not looking
  at, and messages you send while it is busy are sent for you.
