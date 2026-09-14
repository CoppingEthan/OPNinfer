# OPNinfer — Full End-to-End Test Plan

**Audience:** an engineer (or Claude Code) verifying that *every* OPNinfer
feature works, front to back, on a running instance. Version under test:
**0.3.0**.

**How to use this doc:** work top to bottom. Each test has a **Do**, an
**Expect**, and a **Pass/Fail** box. Nothing here needs source-code knowledge —
you drive the app the way a user would (browser + a few terminal commands).
Where a feature is hard to exercise by hand, there's a **ready-made harness**
in `scripts/` that does it against the live database/providers.

> **Golden rule:** the app must be *running* and *interacted with*. Launching it
> and reading logs is not a pass. Click the button, upload the file, read the
> reply.

---

## 0. Before you start

### 0.1 What you need

- The repo checked out, `.env` filled in (real provider keys for OpenAI,
  Anthropic, Google; a Tavily key; `AUTH_SECRET`, `OPNINFER_MASTER_KEY`,
  `SANDBOX_BROKER_TOKEN`).
- Docker Desktop running.
- Node 22 + pnpm (via corepack).
- The **test files** in `test-kit/` (see §0.4). If they're missing, regenerate
  them (§0.4).

### 0.2 Bring the stack up

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d          # pg + worker + gotenberg + sandboxd
docker compose -f docker-compose.dev.yml --profile heavy up -d   # + docling (OCR) + whisper (audio)
pnpm prisma migrate deploy
pnpm dev:https                                           # HTTPS so mic + secure-context APIs work
```

Open **https://localhost:3000** (accept the self-signed cert warning once).

> Use `pnpm dev:https`, not `pnpm dev` — the mic recorder and `crypto.randomUUID`
> need a secure context. `localhost` counts as secure over plain http too, but
> the mic specifically wants https.
>
> **Never run `pnpm build` while `pnpm dev` is running** — they share `.next`
> and you'll get "Cannot find module ./vendor-chunks/*" 500s. If that happens:
> stop dev, delete `.next`, restart dev.

**Sanity check the containers before testing:**

```bash
docker ps --format "{{.Names}}\t{{.Status}}"
```

You should see `opninfer-pg`, `-worker-1`, `-gotenberg-1`, `-sandboxd-1`, and
(with the heavy profile) `-docling-1`, `-whisper-1`, all "Up".

### 0.3 Two accounts to create

1. On first load you land on **/setup** → create the **admin** account.
2. As admin, go to **Admin → Users → Invite** and invite a second address; open
   the invite link (printed to the server console if no SMTP) and set a password
   for a **regular user**. You'll use this to prove regular users *don't* see
   admin things.

Keep one browser profile signed in as admin and a second (or an incognito
window) as the regular user.

### 0.4 The test files

Everything you'll upload lives in **`test-kit/files/`**, and there's a single
**`test-kit/opninfer-test-files.zip`** you can hand to anyone / upload in one go.

If the folder is empty (it's git-ignored — generated locally), rebuild it with
one command — `test-kit/gen.py` writes **every file** (text, Office, PDFs,
images, sqlite, video, the nested zip) using only the sandbox image, so you
need no Office/ffmpeg on the host:

```bash
docker run --rm -v "$PWD/test-kit:/out" opninfer-sandbox python3 /out/gen.py
```

The **one** exception is `voicemail.wav` (needs host text-to-speech). Any spoken
WAV works — record yourself saying *"the magic word for today is turquoise
elephant"*, or on Windows:

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile("test-kit/files/voicemail.wav")
$s.Speak("The magic word for today is turquoise elephant.")
$s.Dispose()
```

Then zip the lot for one-shot uploading:

```powershell
Compress-Archive test-kit/files/* test-kit/opninfer-test-files.zip -Force
```

**Each file hides a "planted fact"** so you can prove the assistant really read
it (not hallucinated). Reference table:

| File | Group it exercises | Planted fact to ask about |
|---|---|---|
| `data.csv` | passthrough / spreadsheet | Which product+region has the highest Q3 revenue? (**Blue Widget, North — £48,275**) |
| `inventory.xlsx` | spreadsheet (2 sheets) | What's the reorder level for the Walnut Table? (**10**); supplier lead time for Nordica AB? (**21 days**) |
| `notes.md` | passthrough (markdown) | What's the venue wifi password? (**granary-2026**) |
| `config.json` | passthrough (code/config) | Is `legacyCsvExport` on or off? (**off/false**); what port? (**7443**) |
| `fibonacci.py` | passthrough (code) | What is `MAGIC_CONSTANT`? (**8675309**) |
| `report.docx` | markitdown (Word) | What's the approved launch budget for Project Nightingale? (**£91,400**) |
| `slides.pptx` | markitdown (PowerPoint) | What's the operation codename? (**OSPREY**); win rate? (**24%**) |
| `report.pdf` | markitdown (text PDF) | What's the invoice total? (**$12,987.65**); invoice number? (**INV-2091**) |
| `scanned.pdf` | **docling OCR** (image-only PDF, 273 KB) | What's the REF on the scanned archive? (**KESTREL-42**) — *needs heavy profile* |
| `legacy.rtf` | gotenberg (LibreOffice → PDF) | Who won the east pier repair contract, and for how much? (**Meridian Marine, £14,750**) |
| `message.eml` | markitdown (email) | What's the new room for the quarterly sync? (**4B**); dial-in PIN? (**442-981**) |
| `contacts.db` | sqlite introspection | How many tables, and what are the foreign keys? (2 tables; `customers.company_id → companies.id`) |
| `photo.png` | **native vision** | What word is on the image? (**SUNFLOWER**) |
| `chart.webp` | native vision | Roughly how many bars, and which is tallest? (5 bars; the 4th) |
| `sticker.gif` | native vision / image dims | Describe it (concentric pink rings, animated) |
| `clip.mp4` | ffprobe metadata | How long is the clip and its resolution? (**~3 s, 320×240**) |
| `voicemail.wav` | **whisper STT** | What's the "magic word for today"? (**turquoise elephant**) — *needs heavy profile* |
| `archive.zip` | markitdown (zip walk) | What's the hidden keyword inside? (**COPPERFIELD**) |

Keep this table open while testing — it's your answer key.

---

## 1. Auth & account lifecycle

| # | Do | Expect | P/F |
|---|---|---|---|
| 1.1 | Fresh instance, visit `/` | Redirects to **/setup** (first-run admin bootstrap) | |
| 1.2 | Create the admin at /setup | Lands in the chat, signed in as admin | |
| 1.3 | Sign out (top-right avatar → Sign out), revisit `/` | Redirects to **/login**, not /setup | |
| 1.4 | Try to open `/admin` while signed out | Bounced to /login | |
| 1.5 | Admin → Users → Invite an email | Invite row appears; with no SMTP, the invite link is printed to the **server console** | |
| 1.6 | Open the invite link, set a password | Regular user created, auto-verified (dev), lands in chat | |
| 1.7 | As the **regular user**, look for admin UI | **No** admin/sliders icon in the sidebar; visiting `/admin` bounces to chat | |
| 1.8 | `/forgot-password` → enter the user's email | Reset link printed to console; the link sets a new password and logs you in | |
| 1.9 | Admin → Users → kebab on a user → Reset password / Disable | Disabled user can't log in; re-enable restores access | |
| 1.10 | Admin → Users → delete a throwaway user | Row goes; their chats vanish but usage history remains (see §11) | |

---

## 2. Core chat & the 4-role pipeline

First bind the models: **Admin → API** (add OpenAI, Anthropic, Google keys),
then **Admin → Models** (set the four roles — frontend / conversation /
escalation / failover). Use a different provider for failover than conversation
if you can.

| # | Do | Expect | P/F |
|---|---|---|---|
| 2.1 | Send "Hello, who are you?" | Streams a reply, word-by-word (paced reveal), with the assistant's configured name | |
| 2.2 | Ask something needing formatting ("show me a markdown table of the planets") | Table renders progressively as real markdown; code/blocks format as they complete | |
| 2.3 | Send a first message in a brand-new chat | A title (2–5 words + emoji) appears in the sidebar shortly after | |
| 2.4 | Leave the composer idle after a reply | 3 follow-up suggestions appear (frontend role) | |
| 2.5 | Ask a hard multi-step reasoning question | If an **escalation** model is set + conversation model chooses to, it hands off (you'll see it keep working); answer arrives | |
| 2.6 | If the conversation role has an **extended** reasoning level set, toggle **Think** on and ask again | Reply takes the higher reasoning level (Anthropic/Google show a live thinking shimmer) | |
| 2.7 | Copy button on a finished reply | Copies the markdown source | |
| 2.8 | Retry button on the last reply | Re-streams a fresh answer over the same question (no duplicate user message) | |
| 2.9 | 👍 / 👎 on a reply | Rating sticks (and is mirrored to the audit log) | |
| 2.10 | Force a transient error (e.g. temporarily put a bad key on the conversation role but a good failover) | It **fails over** to the failover role rather than erroring; a genuine 4xx (bad model id) is **surfaced**, not hidden | |

**Automated backstop:** `scripts/test-providers.ts` (raw provider round-trips)
and `scripts/test-tools-live.ts` (full chat + tool round-trip, all 3 providers).

---

## 3. Chat workspace UX

| # | Do | Expect | P/F |
|---|---|---|---|
| 3.1 | Drag the sidebar edge; collapse it | Width persists on reload; collapsed shows an icon rail | |
| 3.2 | Open Admin, note the nav width matches the chat sidebar | Both shells share the same width/collapsed state | |
| 3.3 | Chat kebab → Star | Chat moves to a Starred group | |
| 3.4 | Kebab → Rename; then **Rename with AI** | Manual rename works; AI rename generates a fresh title | |
| 3.5 | Kebab → Download JSON | Downloads the conversation as JSON | |
| 3.6 | Kebab → Select → tick several → bulk delete | Multi-select bar appears; selected chats delete together | |
| 3.7 | Account menu (top-right) → Settings → toggle light/dark | Theme flips instantly and persists | |
| 3.8 | Settings → upload a profile picture | Avatar updates in the top-right | |
| 3.9 | Settings → Delete all my chats | All the signed-in user's chats clear (usage stays) | |
| 3.10 | Search (sidebar) → type a word you know is in an old message | Full-text results across titles + message bodies; clicking opens the chat | |
| 3.11 | New chat, let a reply finish while the tab is **hidden/unfocused** | A soft two-note **chime** plays on completion | |
| 3.12 | Submit a second message *while a reply is still streaming* | It **queues** and auto-sends when the first finishes | |

---

## 4. Incognito chats

| # | Do | Expect | P/F |
|---|---|---|---|
| 4.1 | Top bar → Incognito | Opens a chat that does **not** appear in the sidebar list | |
| 4.2 | Chat a bit, then navigate away / close the tab | The incognito chat is **auto-deleted** (gone on return) | |
| 4.3 | Confirm memory is **not** written from an incognito chat | Nothing new appears in §7 memory list after an incognito session | |
| 4.4 | Admin → Usage after an incognito chat | Billing/usage rows **survive** (delete ≠ un-bill) | |

---

## 5. File ingestion & storage pools

Upload from `test-kit/files/`. Use the **answer key in §0.4** to verify reads.

| # | Do | Expect | P/F |
|---|---|---|---|
| 5.1 | Attach `data.csv` in a new chat (attaching creates the chat) | Chip shows; status goes pending → ready | |
| 5.2 | Ask "which product and region had the highest Q3 revenue?" | **Blue Widget, North, £48,275** — you see a live "Reading data.csv" status, and afterwards the file appears in the reply's **sources** | |
| 5.2b | Click any **ready** file chip | Opens a viewer showing the EXACT prepared text the assistant reads (`read_file` content), with token estimate + Copy + Download original | |
| 5.3 | Upload `inventory.xlsx`, ask for the Walnut Table reorder level & Nordica lead time | **10** and **21 days** (schema + sample, both sheets) | |
| 5.4 | Upload `report.docx`, ask the Project Nightingale budget | **£91,400** | |
| 5.5 | Upload `slides.pptx`, ask the operation codename + win rate | **OSPREY**, **24%** | |
| 5.6 | Upload `report.pdf`, ask the invoice total + number | **$12,987.65**, **INV-2091** | |
| 5.7 | Upload `legacy.rtf`, ask who won the pier contract & for how much | **Meridian Marine, £14,750** (gotenberg → PDF → markdown) | |
| 5.8 | Upload `message.eml`, ask the new room + dial-in PIN | **4B**, **442-981** | |
| 5.9 | Upload `contacts.db`, ask about tables + foreign keys | 2 tables; `customers.company_id → companies.id`; **no raw row dump** | |
| 5.10 | Upload `archive.zip`, ask for the hidden keyword | **COPPERFIELD** | |
| 5.11 | Upload `clip.mp4`, ask duration + resolution | **~3 s, 320×240** (ffprobe metadata, not a transcript) | |
| 5.12 | **(heavy profile)** Upload `scanned.pdf`, ask the archive REF | **KESTREL-42** (Docling OCR — thin-text large PDF escalates) | |
| 5.13 | Delete the chat, then check disk | The chat's pool folder under `storage/<tenant>/chats/<id>/` is removed | |
| 5.14 | Try to upload something over the admin size limit (Admin → Customise → Uploads) | Upload rejected mid-stream (413), partial file cleaned up | |

**Automated backstop:** `scripts/test-files-http.ts`, `test-ingestion-http.ts`,
`test-ingestion-c-http.ts` (sqlite), `test-ingestion-d-http.ts`,
`test-chat-files-http.ts`.

---

## 6. Native vision

| # | Do | Expect | P/F |
|---|---|---|---|
| 6.1 | Upload `photo.png`, ask "what word is written on this image?" | **SUNFLOWER** (image rides the turn natively — no separate model) | |
| 6.2 | Upload `chart.webp`, ask how many bars and which is tallest | 5 bars, the 4th tallest | |
| 6.3 | Attach 2–3 images at once, ask to compare | All are seen (≤6 images, ≤8 MB each) | |

---

## 7. Voice: mic dictation + STT

| # | Do | Expect | P/F |
|---|---|---|---|
| 7.1 | Click the mic in the composer, speak, stop | Live **waveform** while recording; on stop the transcript lands in the input | |
| 7.2 | **(heavy profile)** Confirm STT path | With whisper up, dictation transcribes via `POST /api/stt` | |
| 7.3 | Upload `voicemail.wav` as a file (heavy profile), ask "what's the magic word for today?" | **turquoise elephant** (worker Whisper transcript) | |
| 7.4 | Over plain http on a LAN IP (not localhost) | Mic is disabled/undefined — expected (secure-context only). Use https | |

**Automated backstop:** `scripts/test-stt-http.ts`.

---

## 8. Agentic tools (v0.3) — the headline

All toggled in **Admin → Tools**. Confirm each group is enabled there first.

### 8.1 Web (Tavily)

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.1.1 | Ask "search the web for the latest news about <a current topic> and summarise" | It calls web search, cites URLs/titles in the answer | |
| 8.1.2 | "Read <a specific article URL> and give me the key points" | Scrapes the page and summarises | |
| 8.1.3 | "Download this file into the chat: <a public raw file URL, e.g. a GitHub raw README>" | A new **chip** appears (kind=generated), ingested; you can then ask about its contents | |
| 8.1.4 | Try to make it download `http://169.254.169.254/...` or `http://localhost/...` | **Refused** — SSRF guard blocks private/metadata hosts | |

### 8.2 Memory (per-user, auto-injected)

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.2.1 | Tell it "remember that I prefer answers in British English and my name is Alex" | It stores a memory (memory_create) | |
| 8.2.2 | Start a **brand-new** chat, ask "what do you know about me?" | It recalls the preference/name (auto-injected block) | |
| 8.2.3 | "Forget my name" | memory_delete; new chat no longer recalls it | |
| 8.2.4 | Sign in as the **other** user, ask "what do you know about me?" | Nothing — memory is **per-user isolated** | |
| 8.2.5 | Do §8.2.1 inside an **incognito** chat | Memory is **not** written (incognito excluded) | |
| 8.2.6 | Admin → Tools → lower the memory budget, then try to store a long memory | Honest "over budget" tool error | |

### 8.3 view_image

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.3.1 | With `photo.png` already in the chat from earlier, later ask "look again at photo.png — what colour is the background?" | Re-examines on demand (view_image), answers **yellow** | |

### 8.4 Image generation (Gemini)

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.4.1 | "Generate an image of a red bicycle on a beach" | An image chip appears in the chat; it's a real Gemini render | |
| 8.4.2 | "Now edit that image to make the bicycle blue" | image_edit produces a new image from the last one | |
| 8.4.3 | "Blend photo.png and chart.webp into one image" | image_blend combines them | |
| 8.4.4 | Repeat generation past the weekly quota (Admin → Tools sets flash/pro limits — lower it to 1 to test fast) | Honest "quota exceeded" tool error, no crash | |
| 8.4.5 | Admin → Usage | Each image is a metered row (role **image**) with cost | |

### 8.5 Skills

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.5.1 | "Draft a professional email declining a meeting" (email-drafting skill) | It loads the skill (load_skill) and follows its structure | |
| 8.5.2 | "Turn these rough notes into clean meeting minutes: …" | meeting-notes skill applies | |
| 8.5.3 | Confirm skill assets stage into the pool without overwriting your edits | If a skill has assets, they appear as files but don't clobber same-named user files | |

### 8.6 Visualisation (inline charts)

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.6.1 | "Draw me a bar chart of these numbers: 5, 12, 8, 20, 15" | A live **chart renders inline** in the reply (sandboxed iframe), matching the theme — **no raw `@@@VIZ` markers leak** into the text | |
| 8.6.2 | Reload the page | The visualisation **persists** (stored in message meta) | |
| 8.6.3 | Toggle light/dark | The viz picks up theme colours | |

### 8.7 Sandbox (write / edit / run real code) — the crown jewel

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.7.1 | Upload `data.csv`, then "using Python, compute total revenue per product from data.csv and save a summary.txt" | It writes + **runs code in the sandbox**, creates `summary.txt` as a new chip you can open | |
| 8.7.2 | "Now make a matplotlib bar chart of revenue per product and save it as revenue.png" | Runs matplotlib in the sandbox, `revenue.png` appears as an image chip | |
| 8.7.3 | Ask it to `pip install` a small package and use it | Works (sandbox has egress internet) | |
| 8.7.4 | Ask it to reach the database/app internals (e.g. curl the app or the DB host) | **Fails** — sandbox can reach the internet but **not** the internal compose network | |
| 8.7.5 | Ask it to run an infinite loop / `sleep 999` | Killed by the timeout (no hang) | |
| 8.7.6 | Edit a file via the assistant ("change MAGIC_CONSTANT in fibonacci.py to 42"), then re-read it | edit_file applies the change; re-read shows 42; chip re-ingests | |
| 8.7.7 | Confirm isolation: it can only see **this** chat's files, and the `.opninfer` prepared-content dir is hidden inside the box | Only the current pool is mounted; artifacts masked by tmpfs | |

**Automated backstop (proves the whole security envelope in one go):**
```bash
node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-sandbox-tools.ts
```
Expect 21 checks green: artifact masking, read-only rootfs, egress works,
internal DNS blocked, timeout kill (exit 137), pip install.

### 8.8 Token-efficiency infra (progressive disclosure + curation)

The assistant starts each turn with the cheap tools + a "MORE TOOLS" directory
and activates heavy groups (web/image/sandbox/capability) **itself** via an
internal `enable_tools` call — no classifier can starve it.

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.8.1 | Ask "what tools do you have", then "and test 5 of them" | It actually **runs** ≥5 tools (including deferred ones like web/sandbox) — never claims only 2 are wired up | |
| 8.8.2 | Watch the status lines during a web question | No "enabling tools" noise — activation is invisible; you just see "Searching the web…" | |
| 8.8.3 | Harness proof | `scripts/test-tool-disclosure.ts` (self-enabling on the exact once-failing conversation) and `scripts/test-curation.ts` (~116k tokens → ~1.4k with facts intact) | |
| 8.8.4 | Admin → Usage after long tool chats | **curator** role rows appear alongside model roles | |

### 8.12 Live tool status + sources

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.12.1 | Ask a web question | Muted status lines stream in the moment ("Searching the web: …"), spinner on the active one | |
| 8.12.2 | After the reply | A **favicon "N sources" pill** sits next to copy/retry; clicking expands a numbered panel (favicon, title, domain) opening in new tabs | |
| 8.12.3 | Reload the page | Sources persist on the message | |
| 8.12.4 | Ask about an uploaded file | The file the assistant read appears as a **file source**; clicking it opens the exact-context viewer | |
| 8.12.5 | Harness proof | `scripts/test-sources-status.ts` + `scripts/test-anthropic-multi-tool.ts` | |

### 8.9 Client capabilities

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.9.1 | Admin → Tools → a client capability's card → enable it, and fill in whatever config it asks for | Saves; secret fields encrypted at rest | |
| 8.9.2 | In chat, ask something only that capability can answer | It discovers the deferred `capability` group, enables it, and calls the tool | |
| 8.9.3 | Disable the capability, ask again | Tool is gone (server-enforced) | |
| 8.9.4 | Give it config its schema rejects, save | Fails **closed** — tools stay off, no crash | |

**Automated backstop:** `scripts/test-capabilities.ts` (12 checks, incl. the
Admin → Tools page render).

### 8.10 Date/time

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.10.1 | "What time is it right now in Tokyo, and how many days until 2027-01-01?" | Correct IANA-zone time + correct day count (no host-zone drift) | |

### 8.11 Tool router group toggles

| # | Do | Expect | P/F |
|---|---|---|---|
| 8.11.1 | Admin → Tools → disable **web**, then ask it to search the web | It can't (tool absent), says so honestly | |
| 8.11.2 | Re-enable web | Search works again | |

---

## 9. Admin panel (all 10 pages)

| # | Page | Do | Expect | P/F |
|---|---|---|---|---|
| 9.1 | **API** | Add / rename / replace a provider key | Replacement is re-verified against the provider before saving | |
| 9.2 | **Models** | Bind the 4 roles + reasoning dropdowns | Saving persists; chat uses them | |
| 9.3 | **Users** | List shows lifetime tokens (in·out) per user | Numbers match Usage | |
| 9.4 | **Usage** | Totals, the live **line graph** + the **cost bar chart** (both range hour→year; hovering a cost bar shows exact $ + requests), by role/model/user, **CSV export** | Both charts render; tooltip shows real cost; CSV downloads | |
| 9.5 | **SMTP** | Configure + test-send | Test email sends (or logs, without a real server) | |
| 9.6 | **Customise** | Assistant name+logo, portal branding (logo + accent), usage-stats visibility, max upload size | Branding shows on login screen + chat; upload limit enforced (§5.14) | |
| 9.7 | **Tools** | Group toggles, Tavily key, image quotas, memory budget, sandbox status, capability cards | All the sub-tests in §8 depend on this page | |
| 9.8 | **Backups** | See §10 | | |
| 9.9 | **Logs** | Live app-log feed (SSE) | Actions you take elsewhere show up live | |
| 9.10 | **(nav)** | As the regular user, none of the above is reachable | `/admin/*` all bounce | |

**Automated backstop:** `scripts/test-usage-cost-chart.ts` (Usage page +
series API) and `scripts/test-capabilities.ts` (Admin → Tools page render).

---

## 10. Backup & restore

| # | Do | Expect | P/F |
|---|---|---|---|
| 10.1 | Admin → Backups → **Create backup** | A `.zip` is produced and listed | |
| 10.2 | Download it | Streams a zip containing `manifest.json`, `database.json`, `storage/…` | |
| 10.3 | Make a visible change (new chat, new memory), then **Restore** the backup | Data reverts to the snapshot; storage swaps back | |
| 10.4 | Restore a backup made with a **different** `OPNINFER_MASTER_KEY` | UI warns **master-key mismatch** (encrypted keys won't decrypt) | |
| 10.5 | Admin → Backups → set an auto-backup schedule (daily/weekly, retention N) | Config saves; `lastRunAt` updates when due; old backups pruned to N | |

**Automated backstop:** `scripts/test-backup.ts` and `scripts/test-backup-http.ts`
(round-trips the whole DB against the live schema).

---

## 11. Data lifecycle & billing integrity

| # | Do | Expect | P/F |
|---|---|---|---|
| 11.1 | Note a user's token totals, delete that user (Admin → Users) | Their chats/files vanish; **usage_records survive** (anonymised, role-tagged) | |
| 11.2 | Delete a single chat | Its messages + files + pool folder go; usage stays | |
| 11.3 | Confirm you cannot delete yourself or another admin from the UI | Delete hidden for admins + self | |

---

## 12. Concurrency & resilience (optional but recommended)

| # | Do | Expect | P/F |
|---|---|---|---|
| 12.1 | Open 5+ browser tabs / the two accounts, fire long replies simultaneously | All stream independently; no cross-talk, no stalls | |
| 12.2 | Start a long reply, then close the tab mid-stream | The upstream provider call is aborted (no leaked/hung request) | |
| 12.3 | Put a deliberately bad conversation key + good failover, blast a few chats | Each fails over cleanly; process never dies (crash guard) | |

---

## 13. Automated regression (run these to backstop the manual pass)

From the repo root, with the stack up and `.env` populated:

```bash
# Pure logic — no services, no cost:
pnpm typecheck
pnpm test                      # 54 unit tests

# Live harnesses (hit real DB / providers / sandbox — small provider cost):
node --env-file=.env --import tsx scripts/test-providers.ts
node --env-file=.env --import tsx scripts/test-reasoning.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-tools-live.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-web-tools.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-memory-tools.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-view-image.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-curation.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-tool-disclosure.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-sources-status.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-anthropic-multi-tool.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-usage-cost-chart.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-file-context-view.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-image-tools.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-skills.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-viz-http.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-sandbox-tools.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-capabilities.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-files-http.ts
node --env-file=.env --import tsx --loader ./scripts/shim-server-only.mjs scripts/test-backup-http.ts

# Full production build — ONLY with the dev server STOPPED (shared .next):
pnpm build
```

> The harnesses that import `server-only` modules need the loader shim
> (`--loader ./scripts/shim-server-only.mjs`) or they won't resolve under pnpm.
> The HTTP harnesses need the dev server running; set
> `NODE_TLS_REJECT_UNAUTHORIZED=0` first when hitting the self-signed https dev
> server.

---

## 14. Sign-off

- [ ] §1 Auth — all pass
- [ ] §2 Chat + pipeline — all pass
- [ ] §3 Workspace UX — all pass
- [ ] §4 Incognito — all pass
- [ ] §5 File ingestion — all pass
- [ ] §6 Vision — all pass
- [ ] §7 Voice/STT — all pass
- [ ] §8 Agentic tools — all pass
- [ ] §9 Admin — all pass
- [ ] §10 Backup/restore — all pass
- [ ] §11 Data lifecycle — all pass
- [ ] §12 Concurrency — all pass
- [ ] §13 Automated regression — green

**Record for any failure:** the step number, what you did, what you saw, the
relevant server-console/`Admin → Logs` output, and (if a tool) the
`Admin → Usage` row. That's enough to reproduce.
