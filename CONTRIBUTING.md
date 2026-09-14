# Contributing to OPNinfer

Thanks for looking. This is a real product that people's work depends on, so
the bar here is "would I want to be on call for this", not "does it run".

## Getting it running

```bash
corepack enable && pnpm install
cp .env.example .env          # then fill in AUTH_SECRET + OPNINFER_MASTER_KEY
                              # (openssl rand -base64 32 each)
docker compose -f docker-compose.dev.yml up -d   # Postgres, ingestion worker,
                                                 # Gotenberg, sandboxd
pnpm db:migrate
pnpm dev                      # http://localhost:3000 → /setup creates the first admin
```

Add `--profile heavy` to the compose command for OCR, speech-to-text and
text-to-speech. Provider API keys go in the app (Admin → API), never in a
message or an issue.

**Read [`CLAUDE.md`](CLAUDE.md) before changing anything.** It is the project's
real brief: the architecture map, every subsystem, and — most valuable — a long
*Conventions & gotchas* section where each entry is a bug that actually
happened, with the evidence and the fix. Most surprises you will hit are
already written down there.

## What "done" looks like here

```bash
pnpm typecheck      # tsc --noEmit — safe to run while dev is up
pnpm test           # vitest, ~800 unit tests
pnpm build          # NEVER while pnpm dev is running — they share .next
```

Beyond that, three habits this codebase leans on. They are worth adopting
because between them they have caught nearly every real bug:

1. **Pure logic goes in a unit test.** Anything that can be a function of its
   inputs — a parser, an ordering rule, a budget, a policy decision — is pulled
   out and tested without a server. `src/lib/*.test.ts` is full of these.

2. **A failure with no runtime symptom gets pinned from the SOURCE.** Some
   mistakes produce no error anywhere: a route left inside the auth matcher
   that a browser fetches without credentials, a file the Dockerfile forgets to
   copy that only breaks in production, a permission check that silently stops
   being reachable. Where that is true, the test reads the source file and
   asserts the line is still there. See `pwa.test.ts`, `changelog.test.ts`,
   `mode.test.ts`.

3. **Anything about live behaviour gets a harness in `scripts/`, with a
   negative control.** These are not part of `pnpm test` — they start their own
   dev server on their own port and drive a real browser (and sometimes a real
   model). The discipline that matters is the control: after proving the thing
   works, break it deliberately and prove the check goes red. A check that has
   never failed has not been shown to test anything. `scripts/test-pwa.ts`
   unregisters its own service worker to prove the offline page really came
   from it.

If you are fixing a bug, the fix and the regression belong in the same pull
request, and the message should say what the bug actually did to somebody.

## Scope

Some things are settled and will be declined, so you don't waste your time:

- **Anthropic subscription OAuth.** Routing third-party users through a Pro or
  Max plan's OAuth token breaches Anthropic's terms. Console API keys are the
  only supported path. This is a licensing line, not a missing feature.
- **Per-user model pickers, model whitelists, bring-your-own-keys.** OPNinfer
  is deliberately a centrally-administered assistant; all three existed in v0.1
  and were removed on purpose.
- **Horizontal scaling as a drive-by change.** The stream registry, model cache
  and log listeners are in-process by design. Making them distributed is a real
  project, not a patch — open an issue first.

Client-specific tooling doesn't belong here either. A capability built for one
organisation lives in that organisation's own private downstream repository and
is registered through `src/lib/capabilities/local.ts`, which is an empty list
upstream. If you want something like that for yourself, that file is the seam —
see its comment.

## Contribution terms

By opening a pull request you confirm that:

- the work is yours to give (you wrote it, or you have the right to submit it),
  and you are not knowingly including anyone else's code or patents;
- you licence it to the project and to everyone who receives the project under
  the **GNU AGPL-3.0**, the licence this repository uses; and
- you additionally grant the maintainer a perpetual, worldwide, royalty-free
  licence to use your contribution under other terms as well.

That last point is the one that needs explaining, because it is unusual to see
stated plainly. OPNinfer is also run as private, client-branded deployments
that are not distributed publicly. Without that grant, an accepted contribution
would pull those deployments into AGPL obligations they cannot meet, so the
contribution would have to be declined — which helps nobody. The grant does not
take anything away from you: you keep the copyright in your work, and it stays
available to everyone under AGPL-3.0 in this repository, permanently.

If you are contributing on behalf of an employer, please make sure you have
their sign-off before opening the pull request.

## Reporting a security problem

Don't open an issue. See [`SECURITY.md`](SECURITY.md).
