# OPNinfer — Feature-by-Feature Testing Checklist

Tick each item as you test it. `- [ ]` → not yet · `- [x]` → works · add a note
inline for anything half-baked or a UX change you want.

> Reference items by number (e.g. "let's do 7.4") and I'll dig into that one —
> verify it live, explain how it's built, flag anything weak, propose UX
> improvements, and implement changes you approve.

**Legend:** `[ ]` untested · `[x]` good · `[~]` works but wants a change (note it) · `[!]` broken

---

## 1. Chat basics
- [x] **1.1** Send a message → streaming reply (paced word-by-word reveal)
- [x] **1.2** Markdown in replies — ask for a table, a code block, a bulleted list
- [x] **1.3** "Think" toggle (if the conversation role has an extended reasoning level) — harder answer
- [x] **1.4** Live thinking shimmer (Anthropic/Google) while it reasons
- [x] **1.5** Escalation — ask something genuinely hard OR just say "escalate to the powerful model" (an explicit ask is now always honored — fixed + regression-tested after it refused once)
- [x] **1.6** Failover — rig-verified 2026-07-19 (test-failover.ts, 8/8): a TRANSIENT failure (unreachable endpoint) switches cleanly to the failover model ("Switched to the failover model." + real reply + role=failover usage + appLog); a BAD KEY (401) is deliberately NOT failed over — it surfaces as an honest config error (masking would hide admin mistakes). Config swapped + restored automatically by the rig.
- [x] **1.7** Retry a reply (↻) — re-answers the same turn
- [x] **1.8** Copy a reply (⧉) — pastes as markdown
- [x] **1.9** Thumbs up / down on a reply → entry appears in **Admin → Feedback** with an AI "why" analysis (new page)
- [x] **1.10** Completion chime — start a reply, switch tabs; soft ding when it finishes
- [x] **1.11** Queue a message — send a 2nd message while the 1st is still streaming (auto-sends after)
- [x] **1.12** Follow-up suggestions — leave the composer idle after a reply
- [x] **1.13** Scroll freedom while streaming — auto-follows smoothly (no jumps); scroll up mid-reply → stays exactly put; ↓ button appears; click it → glides down + resumes following; scrolling back to the bottom yourself also re-arms it
- [x] **1.14** Mid-turn steering — while it's running TOOLS (research/sandbox), type a correction → the button is SEND (not stop), the chip flips to "Steering the task:", the bubble jumps above the streaming reply, and the same answer honors it; during a plain prose reply it queues as before ("Scheduled:")
- [x] **1.15** Resumable streams — start a long reply, switch to another chat (or refresh, or open the same chat in a second tab), come back mid-reply → the response is streaming again right where it was (missed part washes in fast, then live); finishes normally, exactly one reply, and the stop button still stops it

## 2. Workspace & navigation
- [x] **2.1** Resize the sidebar (drag edge) + collapse it (persists on reload)
- [x] **2.2** New chat
- [x] **2.3** Chat kebab: Star
- [x] **2.4** Chat kebab: Rename
- [x] **2.5** Chat kebab: Rename with AI
- [x] **2.6** Chat kebab: Download JSON
- [x] **2.7** Chat kebab: Select → multi-select → bulk delete
- [x] **2.8** Search (⌘K / sidebar) — full-text across titles + message bodies
- [x] **2.9** Account menu → theme (light/dark)
- [x] **2.10** Account menu → profile picture upload
- [x] **2.11** Account menu → delete all my chats
- [x] **2.12** Account menu → sign out
- [x] **2.13** Incognito chat — top-bar button; hidden from sidebar; auto-deletes on leave

## 3. Files — upload & ingestion
- [x] **3.1** Upload a single file → chip shows, spinner → ready
- [x] **3.2** Upload multiple files at once
- [x] **3.3** Big file (>10 MB, e.g. a phone photo) — uploads fully (recent fix)
- [x] **3.4** Click a ready file chip → **see the exact text the AI reads** (context viewer)
- [x] **3.5** Attachment renders **on the user message**, not pinned above the composer
- [x] **3.6** CSV / spreadsheet — ask about a value; it uses schema + sample rows
- [x] **3.7** Word / PowerPoint / text PDF — ask about the contents
- [x] **3.8** Scanned PDF (image-only) — OCR (needs the `heavy` profile / Docling)
- [x] **3.9** SQLite `.db` — ask about tables / foreign keys (schema only, no data dump)
- [x] **3.10** Video — ask duration / resolution (ffprobe metadata)
- [x] **3.11** Zip — ask what's inside
- [x] **3.12** **Manifest inlining** — attach a small doc + ask "what's attached?" → summarises ALL of them without a tool round-trip
- [x] **3.13** Delete a chat → its files are removed from disk
- [x] **3.14** Send while a file is still processing → "Processing <file>…" status line, reply only starts once it's ready and actually uses the content (great with voice notes)

## 4. Vision
- [x] **4.1** Upload an image → "what's in this image?" (native vision)
- [x] **4.2** Big image → still readable (auto-downscaled before the model)
- [x] **4.3** `view_image` — ask it to "look again at <file>" later in the chat
- [x] **4.4** Multiple images in one message → compare them

## 5. Voice
- [x] **5.1** Mic dictation — click mic, speak, stop → live waveform → transcript in composer
- [x] **5.2** Upload a voice recording → transcript (needs `heavy` profile / Whisper)

## 6. Web tools
- [x] **6.1** Web search — "search the web for <current topic>" → cites sources
- [x] **6.2** Web scrape — "read <a specific URL> and summarise"
- [x] **6.3** Web search + read (composite) — "look up and read about X"
- [x] **6.4** Download a file from a URL into the chat (e.g. a GitHub raw README) → becomes a chip
- [x] **6.5** SSRF guard — ask it to download `http://localhost/...` or `169.254.169.254` → refused
- [x] **6.6** **Sources panel** — after a web reply, the favicon "N sources" pill → expand → click through
- [x] **6.7** File sources — after it reads an uploaded file, that file shows in sources (opens the context viewer)

## 7. Images (generation)
- [x] **7.1** Image generation — "generate an image of …" → **placeholder box (right aspect ratio) → blur-in → done**
- [x] **7.2** Time estimate — the placeholder shows "~Ns remaining" (learns from past speeds)
- [x] **7.3** Aspect ratio — ask for 16:9 / 9:16 / 1:1 → box + image match
- [x] **7.4** Image edit — "edit that image to …" (uses the previous image). Source is now auto-downscaled before Gemini (uploads stay full-res on disk): standard quality → normal tier ~1414px, "max" quality → pro tier 2048px. Big phone photos (>8 MB) now work instead of being rejected; PNG transparency is preserved.
- [x] **7.5** Image blend — "blend <img A> and <img B>" (2–4 sources, same normal/pro source compression as 7.4)
- [x] **7.6** Hover a generated image → download button (top-right) + expand
- [x] **7.7** Click a generated image → full-size lightbox
- [x] **7.8** Right-click a generated image → browser menu (save/copy) works
- [x] **7.9** Prompt shown inside the generating box + on the finished image
- [x] **7.10** Weekly quota — (admin lowers it) → honest "quota reached" message
- [x] **7.11** Generated image saved to the chat's files + survives reload (as the image card, not a file card) — DB-verified in chat 328d368a: 4 generated rows (ready) on disk, each reply carries meta.images, no duplicate meta.fileIds

## 8. Memory
- [x] **8.1** "Remember that …" → stored
- [x] **8.2** New chat → "what do you know about me?" → recalls it
- [x] **8.3** "Forget …" → gone in a new chat
- [x] **8.4** Per-user isolation — a different user doesn't see your memory
- [x] **8.5** Incognito — telling it something in incognito is NOT remembered
- [x] **8.6** (admin) Memory budget — lower it → "over budget" error on a long memory
- [x] **8.7** Settings → **Assistant memory** — see everything it knows about you; × a single item; chat to adjust ("forget my old job title") → list updates live

## 9. Skills
- [x] **9.1** "Draft a professional email declining a meeting" → loads email-drafting skill
- [x] **9.2** "Turn these notes into meeting minutes: …" → meeting-notes skill
- [x] **9.3** A visualization request → visualize skill informs the chart design

## 10. Visualizations
- [x] **10.1** "Draw a bar chart of 5, 12, 8, 20, 15" → **live chart inline** (sandboxed), no raw markers leak
- [x] **10.2** Reload the page → the chart persists
- [x] **10.3** Toggle light/dark → chart picks up theme colours
- [x] **10.4** In DARK mode the chart's panel is dark, not a white box with pale text (owner bug 2026-09-04 — the frame's colour scheme didn't match the page's) — harness-verified in both themes by pixel (test-viz-dark); owner eyeball

## 11. Sandbox (the agent tier — v0.4, replaces the old code sandbox)
*Everything below runs through `sandbox_task`: a full agent in the chat's own container. Enable it first: Admin → Tools → Sandbox (subscription or org API key).*
- [ ] **11.1** Delegation — "use the Sandbox to write a Python script that … and run it" → a "Working in the Sandbox: …" line, then the agent's steps as live code/console blocks — harness-verified (test-sandbox-task); owner eyeball for feel
- [ ] **11.2** The 80% steering — a substantial request WITHOUT saying "Sandbox" ("build me a spreadsheet of X from the attached CSV") still delegates
- [ ] **11.3** A trivial request ("what's the capital of France?") does NOT delegate
- [ ] **11.4** Deliverable presented — the finished file appears as a card (or inline if an image); working files stay masked
- [ ] **11.5** **Resume** — "now change X to Y" continues the SAME job (same files edited, agent remembers why) — harness-verified incl. across a container recycle
- [ ] **11.6** `fresh` — an unrelated new task starts a new session
- [ ] **11.7** **Steer mid-run** — type a correction while it works → "Steering the task" chip, the agent takes it, the reply honours it — harness-verified (test-interject)
- [ ] **11.8** **Stop** mid-run → ends within a couple of seconds; the next message does NOT restart the stopped job — harness-verified
- [ ] **11.9** The agent asks YOU a question (AskUserQuestion) → the normal question card; answering resumes the run
- [ ] **11.10** Data analysis — upload a CSV, "compute totals per category and save a chart PNG" → inline chart
- [ ] **11.11** pip install — "install <pkg> and use it" (has internet egress)
- [ ] **11.12** Internal-network blocked — "curl the database / app" → fails (isolated)
- [ ] **11.13** Per-run limits — Admin → Tools → Sandbox: max minutes / max turns are honoured (a `sleep 600` job stops at the minute cap with an honest message)
- [ ] **11.14** Isolation — two chats: the second cannot see the first's files or history — harness-verified (spike-agent-container)
- [ ] **11.15** Subscription mode — "Check sign-in" shows the account signed in INSIDE the container and fills the plan-usage bars straight away (real percentages, matching the Claude app); they refresh after every run
- [ ] **11.16** API-key mode — pick a stored Anthropic key; runs work; Admin → Usage shows real cost rows for `agent` — harness-verified (test-agent-proxy)
- [ ] **11.17** Usage — on a subscription, agent rows show $0.00 with a "saved" value on Usage and in the weekly report; averages don't drop
- [ ] **11.18** **Failover** (2026-09-02) — subscription mode with a Fallback key set: if the plan is spent or the sign-in is lost, the chat shows "switching to the organisation's API key", the job still finishes, Admin → Logs has an error row (and an alert email if SMTP alerts are on), Usage bills it as API — harness-verified (test-agent-failover, forces a real sign-out)
- [ ] **11.19** **Design graphics** (2026-09-02) — "Build me 4 Facebook advert PNGs for a coffee shop" → the question card (Build it properly · recommended / Quick AI concept image) → choose build → four exact-size PNGs built from HTML, inline, no AI image generation; "change the red to blue" edits the same designs — harness-verified (test-design-graphics 16/16); owner eyeball for design quality
- [ ] **11.20** **What the agent reaches for** — ask the Sandbox to pip-install something unusual; Admin → Sandbox → "What the agent reaches for" lists it marked "not in image" — harness-verified
- [ ] **11.22** **Folded steps** (2026-09-02) — while a Sandbox job runs, every step shows; once the reply finishes they fold into "Worked through N steps" (click to expand, click again to fold); a reload starts folded — harness-verified (test-agent-run-ux 13/13); owner eyeball
- [ ] **11.23** **Files where they were handed over** — presented images/cards sit at the point in the steps where the agent presented them (visible even when folded), not above the whole reply — harness-verified
- [ ] **11.24** **Live code** — while the agent writes a file, the 5-line preview grows as it types from the first second (was one burst at the end until the CLI was told to stream tool input, 2026-09-02) — harness-verified (first content within 3s, updates spread over seconds); `scripts/probe-agent-code-stream.ts` prints the timings if it ever looks wrong again
- [ ] **11.25** **Re-presented image refreshes** — "change the red to blue" on a design keeps the same filename; the new version shows immediately in the new reply without a page reload — harness-verified (new ?v= on the image URL)
- [ ] **11.26** **File cards** (2026-09-02) — presented files show as Claude.ai-style cards: coloured type tile, readable title, "Kind · EXT", Download + caret menu (Open in new tab / View contents / real filename), "Download all" for several, a soft staggered entrance; images still render inline, not as cards — screenshot-checked light/dark; owner eyeball
- [ ] **11.27** **Plan alerts** (2026-09-02) — with SMTP error alerts on, an email arrives when the session or weekly window crosses 90% and again when the plan refuses; once per window, not on every run — probe-verified (probe-plan-alerts: 45 → 91 → 94 → 100 → 100 + week 92 raises exactly nearing, limit, week-nearing)
- [ ] **11.28** **Test emails** (2026-09-02) — Admin → Sandbox → "Send test: 90% warning" and "Send test: limit reached" arrive marked [TEST] with an amber banner and the real wording; Admin → SMTP → weekly "Send one now" arrives marked [TEST] and its Claude-plan section shows sessions, the plan reading, API fall-backs and the most-installed packages
- [ ] **11.29** **Connected services (MCP)** (2026-09-03) — on the server: `./deploy.sh agent-mcp <instance> add figma https://mcp.figma.com/mcp`, then `./deploy.sh agent-mcp <instance> login figma` (open the link, approve, paste the full redirect address back, even though that page shows a connection error); Admin → Sandbox → Connected services lists figma as Signed in and "Check connections" says Connected; ask the assistant about a Figma file by link → it goes to the Sandbox and the steps read "Using Figma: …"; another instance's page shows none set up — harness-verified up to the sign-in (test-agent-mcp 17/17: real command, real volume, CLI reports needs-auth from inside the container); the sign-in itself done and proven in production 2026-09-04 (broker sees the token, `claude mcp list` Connected, a run-shaped strict-mode probe connected with 42 Figma tools); the chat about a Figma file is the owner's eyeball; the alert path is harness-verified (a dead token → Check connections says Needs a sign-in and an error row lands, which the alert email sends on); no claude.ai connector ever appears, and their tools are refused by the permission layer regardless
- [ ] **11.21** **Sandbox admin page** (2026-09-02) — Admin → Tools shows only the enable switch; a "Sandbox" tab appears in the admin menu once enabled (and vanishes when disabled) with service status, configuration, plan usage and the packages table; flipping the switch never resets the settings — harness-verified (test-admin-sandbox-page 18/18)
- [x] **11.14** **Live run feedback** (2026-07-14) — while the model writes code a 5-line rolling preview streams in ("Writing fib.py"), then a live console tail while it runs ("Running…") — harness-verified (test-tool-run-ui, both phases proven live via MutationObserver); owner eyeball for feel
- [x] **11.15** **Collapsed run chips** — on completion the block collapses to `file.py +N −M` and `0.1s · N lines` (· exit code / timed out on failure); click expands the full code + console output
- [x] **11.16** Run chips **survive reload** (meta.toolRuns) with stats + expandable code/output intact
- [x] **11.17** **File presentation** (2026-07-19) — a multi-file task ("write gen.py that makes results.csv, run it, give me only the csv") shows ONLY the deliverable card; working files stay masked in the workspace — harness-verified (test-present-files 9/9); owner eyeball
- [x] **11.18** **Late presentation** — "now give me gen.py as well" → the earlier turn's file is presented onto the NEW reply
- [x] **11.19** **Presented images render INLINE** — a matplotlib chart the model shows you appears as the image (blur-in card, lightbox, download), not a grey file card; persists on reload

## 12. Other tools
- [x] **12.1** Date/time — "what time is it in Tokyo, and days until 2027-01-01?"
- [x] **12.2** **Live tool status** — muted "Searching the web…/Running…" lines appear as it works; narration between tool rounds renders **interleaved in true order** (prose → status → prose), and the lines **persist on reload** in the same positions (2026-07-19, harness-verified: test-activity-interleave 6/6)
- [x] **12.3** **Progressive disclosure** — "what tools do you have" then "test 5 of them" → it actually runs them (never claims it only has 2)
- [x] **12.4** **Tool-budget exhaustion** — a heavy research turn (many sequential searches) still ends in a real answer, never watched-it-search-then-silence (fixed + regression-tested)
- [x] **12.5** **Proactive tools** — an implied need (e.g. "actually in <town>" after a news question) → it just searches, never "want me to search?" (fixed + regression-tested)

## 13. Admin panel (admin login)
- [x] **13.1** API — add / rename / replace a provider key (re-verified on replace)
- [x] **13.2** Models — bind the 4 roles + reasoning dropdowns
- [x] **13.3** Users — list, invite, approve, reset password, disable, delete; lifetime tokens per user
- [x] **13.4** Usage — full dashboard: ONE range selector (hour→all) drives everything; KPI cards with **vs-previous deltas** + cache hit rate + avg cost/req; token + cost charts; **by model/user/role/provider** tables (share bars); **recent-activity feed**; auto-refresh; CSV export
- [x] **13.5** SMTP — configure + test-send
- [x] **13.6** Customise — assistant name/logo, portal branding + accent, usage-stats visibility, max upload size
- [x] **13.7** Tools — group toggles, Tavily key, image quotas, memory budget, sandbox status, capability cards
- [x] **13.8** Backups — create, download, restore, auto-backup schedule
- [x] **13.9** Logs — live application log (SSE); **two views** (2026-07-19): **Chats** (per-reply feed: user + avatar, when, model, in/cached/out tokens, cost, duration, tools, escalated badge) and **Raw** (every event; click a row → full details JSON) — harness-verified (test-admin-logs 7/7); owner eyeball
- [x] **13.10** Feedback — health strip (total, % positive, 7-day 👍/👎), All/👍/👎 filters, per-entry AI "why" + expandable exchange; entries survive chat deletion

## 14. Auth & accounts
- [x] **14.1** First-run /setup (fresh instance) → creates the admin
- [x] **14.2** Login / logout
- [x] **14.3** Invite a user → open the link → set password → lands in chat
- [x] **14.4** Forgot password → reset link → new password
- [x] **14.5** Regular user can't reach /admin (bounced)

## 15. Under the hood (for you, not end-users)
- [x] **15.1** `logs/dev.log` — verbose firehose of every request / LLM call / tool call / error — swept 2026-07-19: 281 llm req/resp pairs, 287 tool calls, chat/upload/warn/error entries all present with truncated previews; ZERO secret-pattern or base64-blob leaks; 20 MB rotation in place
- [x] **15.2** Backup/restore round-trip integrity — re-run 2026-07-19 against the live DB (42 convos, 132 messages incl. today's meta.activity/toolRuns): full destructive restore, identical counts, Bytes/Decimal/BigInt/updatedAt all intact (test-backup.ts)
- [x] **15.3** Concurrency — three users streaming simultaneously (4.1s three-way overlap): each reply carries only its own codeword, saved to its own conversation, usage attributed per user — 11/11 (test-concurrency.ts)

## 16. Client capabilities (instance-enabled tool bundles)
*No client capability ships in the public product — `src/lib/capabilities/local.ts`
is an empty list. These checks apply to whichever capabilities a particular
deployment adds through it; a deployment that has some should keep its own
specific checks in its `OPERATIONS.md`.*
- [ ] **16.1** Enable the capability in Admin → Tools, then ask the assistant something only it can answer — the model should discover the deferred `capability` group, enable it, and use the tool without being told to
- [ ] **16.2** Toggle the capability off → both the tool and the group vanish from what the model is offered (server-enforced, not just hidden)
- [ ] **16.3** Sense-check what it returns against the source system — counts and extremes should match
- [ ] **16.4** Give it config its schema rejects → it fails **closed**: tools stay off, nothing crashes
- [ ] **16.5** The card renders with no special-casing in the Tools page — including its own "Data source" line, if it declares one

## 17. Clarifying questions (the ask_user card) — new 2026-08-17
*Harness `scripts/test-ask-user.ts` passes 37/37 against a real model, incl. the
1-of-3 stepper, reload persistence and Stop. These are the UX judgements only
you can make.*
- [ ] **17.1** Ask something with a real fork in it ("write me a poem about the
      sea — haiku or limerick, I haven't said which") → card appears above the
      composer, the reply visibly pauses, picking an option resumes THAT reply
- [ ] **17.2** Does it ask at the right times? It should NOT ask permission, ask
      about things it could infer, or ask when the files/memory already answer.
      If it over-asks or under-asks, that's a steering fix in the tool
      description (`src/lib/tools/ask.ts`) — tell me which way it erred
- [ ] **17.3** Multi-question ask ("I have preferences about three things…") →
      "1 of 3" stepper, arrows step back/forward, one answer message at the end
- [ ] **17.4** "Something else" → type your own answer; it's marked *(typed)* in
      the record and the reply honours it
- [ ] **17.5** Skip a question → the assistant picks a default and SAYS which
- [ ] **17.6** "Or reply directly…" → type into the composer instead of picking;
      it answers the question showing and skips the rest
- [ ] **17.7** Number keys 1–4 pick an option; Escape dismisses the card
- [ ] **17.8** Reload mid-question → card still there, still answerable
- [ ] **17.9** Reload after answering → question + your answer both still shown
- [ ] **17.10** Press Stop while a question is up → reply winds down, and the
      chat still accepts your next message (no stuck "already generating")
- [ ] **17.11** Ignore a card for 5 minutes → the assistant answers anyway with a
      stated default, rather than hanging
- [ ] **17.12** Admin → Tools → untick "Clarifying questions" → it stops asking
      and answers with assumptions instead
- [ ] **17.13** Visual check in light AND dark, and on a phone-width window

## 18. What's new panel + tab titles (2026-08-21)
- [ ] **18.1** First look after this ships → the **What's new** panel opens over
      your chat by itself, showing only the LATEST release (not the history)
- [ ] **18.2** Close it → it does not come back on reload. Close the TAB without
      dismissing it instead → it should still be waiting next time
- [ ] **18.3** Account menu → **What's new** → reopens it with every release,
      and closing it that way changes nothing
- [ ] **18.4** Read it in light AND dark, and on a phone-width window; a long
      release should scroll inside the panel, not the page
- [ ] **18.5** Browser tab shows the chat's own title; switch chats → it follows
- [ ] **18.6** Start a brand-new chat → the tab renames itself the moment the
      chat gets its emoji title, without a reload
- [ ] **18.7** Rename a chat (and Rename with AI) while it is open → the tab
      renames with it
- [ ] **18.8** An incognito chat's subject never appears in the tab title
- [ ] **18.9** Answer a clarifying question → your answer shows ONLY inside the
      question card, not as a separate message above it; still true after a
      reload, and the assistant still remembers it in a later message

## 19. Shared chats (v0.5, 2026-09-04) — needs TWO accounts (two browsers, or one normal + one private window)
- [ ] **19.1** In a chat with at least one reply, the top bar shows **Share**
      → the People panel lists you as Owner with a search box; add a colleague
      → they appear as a member and the button becomes **People · 2**
- [ ] **19.2** On the colleague's screen (no reload) the chat appears in a
      **Shared** section of the sidebar with your avatar, plus a short notice
- [ ] **19.3** They open it: your messages carry your name and avatar; your
      People panel shows a green dot beside them while they have it open
- [ ] **19.4** They send a message → it appears on YOUR screen with their name,
      and the reply streams on both screens at the same time
- [ ] **19.5** Ask for something long; while it streams, BOTH of you send a
      message → both chips show on both screens ("Scheduled — you / Bob"),
      in the order sent; each runs afterwards as its author with its own reply
- [ ] **19.6** They attach a file and ask about it → the assistant reads it;
      you can open/download it from their message (and Download all etc.)
- [ ] **19.7** Trigger a question card (ask it to ask you) → the OTHER person
      answers → the reply honours it and the record says "Answered by …"
- [ ] **19.8** Thumbs: you 👍, they 👎 the same reply → each sees their own;
      Admin → Feedback shows both, naming the rater
- [ ] **19.9** Edit: you may edit your own message only while nobody else has
      written after it (the pencil disappears otherwise); Retry works for both
- [ ] **19.10** The member's kebab offers **Leave**, never Delete or Select;
      their People panel has no search box, only "Leave chat"
- [ ] **19.11** Either person renames the chat → the other's sidebar and tab
      title follow live; search finds it for both; Download (JSON) shows authors
- [ ] **19.12** While you are on another chat, they send → an unread dot on the
      row; opening it clears the dot
- [ ] **19.13** Remove them from the People panel → their open screen says they
      no longer have access, the chat leaves their sidebar, their file stays
      with the chat; with nobody left the chat drops out of the Shared section
- [ ] **19.14** Delete a shared chat → everyone's screen says so and it is gone
      for all. Delete all my chats (settings) → leaves chats shared WITH you
- [ ] **19.15** Incognito chats have no Share button; a shared chat never uses
      your personal memory (ask it what it remembers about you)
- [ ] **19.16** Admin → Chats: the row says "shared with N"; the viewer labels
      who wrote what
- [ ] **19.17** Visual check in light AND dark, and on a phone-width window:
      the author labels, the Shared section, the People panel

## 20. Memory v2 (0.5.1, 2026-09-04) — learns from quiet chats, four editable notes
- [ ] **20.1** In a chat, mention your role, how you like answers and a dated
      decision WITHOUT saying "remember" → nothing changes yet. Leave the chat
      alone for 30+ minutes → Settings → Assistant memory has filled in About
      you / How you like replies / Your work (in dev, `MEMORY_PASS_IDLE_MINUTES=1`
      shortens the wait)
- [ ] **20.2** Mention a health matter in the same chat → it is NOT kept
- [ ] **20.3** New chat: "what's my job and how do I like answers?" → recalled
- [ ] **20.4** "I've moved to sales — remember that" → About you says sales and
      no longer marketing (replaced, not added). "Forget my job" → gone
- [ ] **20.5** "When did we decide X?" about something from an earlier chat →
      it searches your past chats (status line), answers, and links the chat
- [ ] **20.6** Settings → Assistant memory: edit a note and Save → the next chat
      uses it; "Forget everything" empties all four
- [ ] **20.7** Pause learning (settings) → "remember that…" gets "memory is
      paused"; a quiet chat is not read. Unpause → learning resumes
- [ ] **20.8** Incognito chat and a shared chat → nothing from them is ever
      kept, even after 30 minutes
- [ ] **20.9** Admin → Tools → User memory: pause for everyone; note size;
      untick "search past chats" → the assistant can no longer look back
- [ ] **20.10** Admin → Usage: the memory pass shows under its own role
      ("memory"), costing pennies
- [ ] **20.11** Existing memories from before the update appear as bullet lines
      in About you; the next quiet chat sorts them into the right notes
- [ ] **20.12** Visual check of the memory section in light AND dark

## 21. Long chats: compaction + message order (0.6.0, 2026-09-10)

- [ ] **21.1** Admin → Models → Limits shows "Compact conversations at" (96,000)
      and "Keep recent" (20,000); saving a pair that makes no sense (keep more
      than half the trigger, or a trigger above Max input tokens) is refused
      with a plain message, not silently changed
- [ ] **21.2** Set the trigger low (say 20,000) in a long chat and send a
      message → "Summarising earlier messages…" shows in the thinking line for
      a few seconds, then the reply arrives; a thin "Earlier messages
      summarised for the assistant" line appears part-way up the chat and
      every message is still there above it
- [ ] **21.3** Ask about something from ABOVE the line (a name, a number, a
      draft you built) → it still knows
- [ ] **21.4** Retry the last reply → the line stays where it was. Edit a
      message from ABOVE the line → the line disappears (the chat is short
      again); a later long stretch brings it back
- [ ] **21.5** Admin → Chats → that chat: the same line, plus a fold-out
      "The assistant sees the first N messages only as a summary" with the
      summary text
- [ ] **21.6** Admin → Usage: the summarisation shows under its own role
      ("compaction"), on the front-end model, costing pennies
- [ ] **21.7** A chat brought over from Open WebUI (a 2025 date) opens with
      every question ABOVE its answer — including the first pair
- [ ] **21.8** Put the trigger back to 96,000 afterwards

## 22. On a phone: install to the home screen (0.6.2, 2026-09-14)

Needs a REAL phone over https — a service worker and "Add to Home Screen" only
exist in a secure context, so a plain-http LAN address will show none of this.

- [ ] **22.1** iPhone, Safari → Share → **Add to Home Screen**: the icon is the
      portal's own logo on a white tile (not a screenshot of the page), and the
      name underneath is the assistant's, shortened — not "OPNinfer"
- [ ] **22.2** Open it from the home screen: **no address bar**, and it lands
      on the chat (or the login screen first, then the chat)
- [ ] **22.3** Sign in and send a message from the installed app — streaming,
      the stop button and attachments all behave as they do in the browser
- [ ] **22.4** The composer sits **above the home indicator**, not under it, on
      a notched iPhone; the background still reaches the screen edges
- [ ] **22.5** Android, Chrome → the ⋮ menu offers **Install app** (or a prompt
      appears); installed, the icon is round/masked without a white ring around
      the logo
- [ ] **22.6** With the app open, put the phone in **aeroplane mode** and pull
      to refresh / reopen it: a plain "You're offline" card with a **Try again**
      button, not the browser's error page. Turn the signal back on, tap Try
      again → straight back into the chat
- [ ] **22.7** Admin → Customise: upload a different portal logo, then re-add
      the app to the home screen → the new logo is the icon
- [ ] **22.8** Admin → Customise: rename the assistant → a fresh install uses
      the new name

---

### How I'll help per item
When you pick one, I'll: confirm it works (live), explain how it's built, point
out anything half-baked, propose concrete UX improvements, and implement changes
you approve — verifying each with a live check.
