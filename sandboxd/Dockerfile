# OPNinfer sandboxd — the sandbox broker. Deliberately tiny: one file, one
# dependency, the ONLY container holding the Docker socket.
FROM node:22-bookworm-slim
WORKDIR /sandboxd
# The lockfile is load-bearing (audit 2026-09-05): this is the one container
# holding the Docker socket, and without it dockerode and its transitives
# resolved to whatever was current on deploy day.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Named explicitly, so a new module MUST be added here — an import that
# resolves in dev and is absent from the image takes the whole broker
# down at boot (scripts/test-cred-sync.sh asserts each one is listed).
COPY index.mjs credentials.mjs cred-sync.sh ./
ENV NODE_ENV=production
CMD ["node", "index.mjs"]
