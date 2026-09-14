# syntax=docker/dockerfile:1

# OPNinfer production image (spec §1/§11). Multi-stage:
#   deps     – install dependencies from the lockfile
#   schema   – + the Prisma schema and migrations (a tiny layer on deps)
#   builder  – + the generated client and the source; builds the Next server
#   migrator – runs `prisma migrate deploy` (one-shot service), from `schema`
#   runner   – minimal runtime image serving the standalone build
#
# Debian-slim (glibc) is used rather than Alpine so the Prisma query engine and
# the @node-rs/argon2 native binding run without musl/openssl surprises.
#
# BUILD SPEED — every one of these was measured on the production VM, and every
# one is easy to undo by accident. A release took 385s to build before any of
# it, and 184s after the first pass:
#   1. NEVER `chown -R` the whole app. 144s on its own, and because a chown
#      rewrites every file it duplicated the entire image into a second layer,
#      which then had to be exported and unpacked too (645 MB → 490 MB). Set
#      ownership with `COPY --chown` and chown only the few directories that
#      need it.
#   2. Nothing that changes often may sit above `pnpm install`. `COPY prisma`
#      did, so a release containing one migration file reinstalled every
#      dependency: 126.7s, plus a full re-export of the migrator image.
#   3. STAGES SHARE LAYERS; COPYING BETWEEN THEM DOES NOT. `builder` copying
#      node_modules out of `deps` cost 42s of layer writing per build to
#      recreate what already existed. `FROM deps` costs nothing.
#   4. The migrator is `FROM schema`, NOT from a stage carrying the generated
#      Prisma client. `migrate deploy` doesn't need the client, and keeping it
#      out means a schema change re-exports a few kilobytes instead of a ~1 GB
#      dependency tree — 132s of export+unpack, down to seconds.
#   5. `pnpm build` keeps Next's compiler cache in a BuildKit cache mount.
#   6. `.dockerignore` decides what `COPY . .` writes. Letting the whole repo in
#      cost 22s a build and put every instance's master key in a build layer.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
# openssl is required by the Prisma query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- deps: install node_modules from the lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store     pnpm install --frozen-lockfile

# ---- schema: the Prisma schema and migrations, and nothing else ----
# A tiny layer on top of `deps`, kept SEPARATE from `prisma generate` on
# purpose. `prisma migrate deploy` needs the schema and the migration files; it
# does not need the generated client. Splitting them means a release that adds
# one migration re-exports a few kilobytes into the migrator image instead of
# the whole ~1 GB dependency tree — which cost 132s of exporting and unpacking
# on the production host (2026-08-23).
FROM deps AS schema
COPY prisma ./prisma

# ---- builder: build the standalone server ----
# `FROM schema`, not `FROM base` + a copy of node_modules: copying ~1 GB of
# dependencies into a fresh stage cost 42s of layer writing on the production
# host's disk, every build, to reproduce what already existed a stage earlier.
FROM schema AS builder
ENV BUILD_STANDALONE=1
# Before `COPY . .`, so an ordinary source change doesn't regenerate an
# identical client. It depends on prisma/schema.prisma alone, which is already
# here.
RUN pnpm prisma generate
COPY . .
# Next's own compiler cache, persisted between deploys by BuildKit. It is build
# scratch only — nothing from it ends up in the image.
RUN --mount=type=cache,id=next-build,target=/app/.next/cache     pnpm build

# ---- migrator: applies migrations, then exits ----
# `FROM schema`: node_modules (for the prisma CLI) plus the schema and
# migrations — everything `migrate deploy` needs and nothing more. Notably NOT
# the generated client, which is what keeps this image's layers stable across a
# schema change.
FROM schema AS migrator
# `migrate deploy` applies committed migrations without prompting (prod-safe).
CMD ["pnpm", "prisma", "migrate", "deploy"]

# ---- runner: minimal runtime ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next.js standalone output bundles only the server + traced node_modules.
# `--chown` here is what lets us skip a recursive chown further down.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Skills are read from disk at runtime (L2 loads + asset staging).
COPY --from=builder --chown=node:node /app/skills ./skills
# Release notes are read from disk at runtime (the What's new panel). The
# standalone build traces JS imports only, so a plain file has to be copied
# explicitly — miss this and the panel is silently empty in production while
# working perfectly in dev. Asserted by src/lib/changelog.test.ts.
COPY --from=builder --chown=node:node /app/CHANGELOG.md ./CHANGELOG.md

# Only the directories the runtime writes to, and only the directories
# themselves — their contents already belong to `node` from the COPYs above.
# /app/storage is the persisted upload location (a volume in compose).
RUN mkdir -p /app/storage /app/.next/cache \
  && chown node:node /app /app/.next /app/.next/cache /app/storage
USER node

EXPOSE 3000
CMD ["node", "server.js"]
