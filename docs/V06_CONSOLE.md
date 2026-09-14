# The operator console — design record

**Status:** built and **deployed 2026-09-07** (all four portals plus the
console on port 3000). One real bug on the way: see "The env files must not
look like a portal" below. Owner asked for "an admin dashboard for all client portals, just
an overview page with stats… never need to write from this admin dashboard,
just read please, and also doesn't need anything like smtp as that is all
managed per client portal."

This is the survival document for the console, in the same spirit as
`V04_AGENT_TIER.md` and `V05_SHARED_CHATS.md`: the decisions, why they went
that way, and the traps found while building it.

---

## What it is

One page per question, across every portal on the host at once:

| Page | Answers |
|---|---|
| Overview | What is the whole estate doing right now — spend, people, errors, ingestion health, the shared Claude plan |
| Usage | Tokens and cost, the portals' own dashboard over the merged data, plus who the spend belongs to |
| Activity | What the assistants actually did — tools, and what came out of them |
| People | Every account on every portal, with what it has used |
| Feedback | Every thumbs-rated reply, with the portal's own "why" analysis |
| Sandbox | The shared plan, fallback spend, agent errors, what it reached for |
| Logs | Every portal's application log, merged and sorted by time |

It reads. It never writes. Two of those views cannot exist inside a single
portal at all — the shared Claude plan and the estate-wide spend split — and
those are the reason the console is worth having rather than four browser tabs.

---

## The decisions

### 1. The same image, run twice — not a second project

`OPNINFER_MODE=console` (`src/lib/mode.ts`) turns the app into the console:
middleware serves only `/console` and 404s every portal route, the root layout
stops reading branding, and no scheduler starts. A portal 404s `/console` in
the same way.

The alternative was a separate Next app in the repo. Rejected: it would
double the image build (~84s of compile) on every deploy, duplicate the UI
kit, and let the two drift. As it stands the usage dashboard is *literally the
same React component* the portals render, pointed at a different endpoint —
they cannot disagree, and anything added to it lands on both pages.

The one cost is that a portal image contains console code. Middleware refuses
it, `lib/console/guard.ts` refuses it again, and the console layout refuses it
a third time. `mode.test.ts` pins all three from the source, because a portal
quietly serving `/console` would have no symptom you would go looking for.

### 2. No database of its own

Owner's choice. Accounts live in `instances/console/console.env` as
`email:argon2-hash` pairs, written by `./deploy.sh console-password`. Sessions
are the existing Auth.js JWTs, which need no storage.

That removes a whole Postgres container from a 7.4 GB box, and with it the
invites, verification and password resets the owner explicitly did not want.
The trade is that changing a password means running a command and
redeploying — fine for one or two people.

Nothing else changes: same argon2id, same login-guard backoff, same cookie
namespacing (the console runs as `OPNINFER_INSTANCE=console`, so it can be
held open beside all four portals — the bug fixed on 2026-09-05).

### 3. Direct database reads, as a role that CANNOT write

The console joins each portal's compose network and connects to its Postgres
as `console_ro` — a role deploy.sh creates there with `SELECT` and nothing
else, plus `ALTER DEFAULT PRIVILEGES` so future migrations' tables are covered
without anyone remembering to re-grant.

Read-only is therefore a property of the **database**, not of our query layer.
`test-console.ts` proves it by trying an `INSERT` and asserting Postgres
refuses it (`42501 permission denied`). The alternative — a read-only HTTP API
on each portal — would have meant app changes on every portal, a token to
manage, and a new endpoint per view.

Connections are by **container** name (`opninfer-<name>-db-1`), not the `db`
service alias: every project has a `db`, and this one container is attached to
all of their networks at once.

Pools are capped at 2 connections per portal. Those connections come out of
the same `max_connections` a client's portal is using to serve chats; the
console must never be why a portal cannot get one.

### 4. A portal that cannot be read is shown as such

`fanOut` never rejects. A portal that is down, mid-deploy, or running a schema
the console's client does not know yet comes back as an error row, an amber
banner names it, and every other portal still renders. The moment you most
want this dashboard is the moment something is wrong; a total that silently
excludes one of four portals is worse than no total.

Connection errors are scrubbed before display — Prisma quotes the whole
datasource URL, password included, and this text reaches a browser.

### 5. Adding a portal must not mean editing the console

`deploy.sh` regenerates `instances/console/portals.env` on every run from
`instances/*.env`, creating the read-only role as it goes. The console's own
secrets live in a second file that is written once and never rewritten.
Compose loads both.

---

## Traps found while building it

**The Sandbox agent's narration is indistinguishable from a tool label.**
`bridge.ts` turns each of the agent's text blocks into `{kind:"status",
label}` — the same shape a tool status line has. The first screenshot of the
Activity page was almost entirely one-off sentences ("All four render cleanly
— no clipped text…") with the real tools pushed off the bottom. They are now
separated by SHAPE (`labels.ts`): every label this app generates is a short
imperative phrase — none reaches 60 characters, runs to eight words, contains
a sentence break, or ends in a full stop. That last rule is the one that
catches the short ones like "Now let's render all four to PNG."

**Tool names are not logged anywhere queryable.** `app_log` records only how
many tools a reply used. So the console reports two different qualities of
evidence and says which is which: exact counts from what a reply persists for
its own re-rendering (`meta.toolRuns[].tool`, `meta.images`, `meta.sources`,
`meta.viz`, `meta.asks`, `meta.fileIds`), and the status lines bucketed. It
deliberately does not claim to recover a tool name it cannot: `read_file` and
a single-URL `web_scrape` both render as "Reading X", and those share one
honestly-named row rather than being guessed into two.

**A merged chart needs one bucket grid.** Each portal's `buildUsageSummary`
would pick its own grid for "all" (derived from ITS first record), and four
series on four time bases cannot be summed. The console resolves one common
window from the earliest record anywhere and passes it to every portal.

**An email is unique only WITHIN a portal.** The merged people breakdown tags
each row with its portal; without that, one person with accounts on two
portals silently becomes one row and the totals stop adding up.

**`passwordChangedAt` is stamped only by a reset.** Never by accepting an
invite. That makes it the "this person has arrived" signal after a migration
and nothing much otherwise — so the People page shows it plainly. An early
version painted every normally-invited user amber for a column they could
never satisfy.

**`lastActiveAt` is imported from Open WebUI.** For migrated accounts it is
OWUI's own value, so a date older than that portal's cutover is history, not a
sign-in here. Said on the page, not just in a comment.

**The console's env files must not look like a portal** — the one that
reached production. They were written into `instances/`, which deploy.sh
treats as the PORTAL list: it picks the first match as the env file for the
image BUILD, loops over them to deploy, and scans them for free ports.
`console-portals.env` sorts alphabetically first, so the build ran with an env
file that has no `SANDBOX_BROKER_TOKEN` and died on

```
error while interpolating services.sandboxd.environment.SANDBOX_BROKER_TOKEN:
required variable SANDBOX_BROKER_TOKEN is missing a value
```

It only broke on the SECOND deploy — the first created the files — which is
the worst shape of breakage: the change that caused it had already been
declared a success. The build failing is at least the safe end of the deploy
(nothing is drained or recreated yet), so the portals were untouched.

They live in `instances/console/` now, invisible to that glob, and
`migrate_console_env` moves an old layout across BEFORE anything globs — by
the time `deploy_console` runs, the build has already failed on them.
`test-deploy-functions.sh` pins both halves: the migration keeps the
operator's password hash, and `ls instances/*.env | head -1` picks a real
portal afterwards.

**Two dev servers share `.next`.** Running the console beside the portal in
dev overwrote the portal's webpack chunks — the documented "500 on every
route" failure. `next.config.ts` now honours `NEXT_DIST_DIR`, unset in every
build and deploy.

---

## Proof

- Unit: `operators.test.ts` (9), `instances.test.ts` (6), `labels.test.ts`
  (12), `merge.test.ts` (8), `mode.test.ts` (8) — the last reads middleware,
  the guard, the layout and `auth.ts` from source, because none of it can be
  executed outside a running container.
- `scripts/test-deploy-functions.sh` — the read-only role grants SELECT and
  nothing else (asserted against a recorded SQL log, with a negative control),
  a portal it cannot prepare is left out rather than aborting the deploy, and
  the env-suffix rule still agrees with the TypeScript that consumes it.
- `scripts/test-console.ts` — 31 live checks: the role cannot write, the two
  modes refuse each other's routes, an operator signs in and a wrong password
  does not, the overview's numbers match a direct query, every page renders
  (with a negative control proving the markers are real), and signing out ends
  the session.
- `scripts/shot-console.ts` — screenshots every page light and dark into
  `logs/`, for eyeballing.

## Left open

- **Deployed 2026-09-07.** Still to do: `./deploy.sh console-password` to set
  a sign-in, and the owner's visual pass.
- **No version bump.** The portals get no user-visible change, and
  `CHANGELOG.md` deliberately says nothing: it ships inside the shared app
  image and every USER sees it, so an operator-only feature has no business
  in it (the 0.4.0 rule).
- **The console is HTTP on port 3000**, for the reverse proxy or the LAN. If
  it is ever given a public hostname, set `AUTH_URL` in `instances/console/console.env`
  so the cookies become `__Secure-`/`__Host-` prefixed.
- **Polling, not SSE.** Four SSE connections into four client databases held
  open for the life of a tab is a lot of standing cost for something a few
  seconds of staleness cannot hurt.
