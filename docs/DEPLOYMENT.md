# Deploying OPNinfer

One script handles first-time setup **and** every update, for **every portal
instance on the host**: [`deploy.sh`](../deploy.sh). It installs Docker itself
if it is missing (the official `get.docker.com` script), so a fresh Ubuntu box
needs nothing but git access to the repository.

```bash
git clone https://github.com/CoppingEthan/OPNinfer.git
cd OPNinfer
./deploy.sh
```

**First run** checks for Docker, then walks you through creating your
instances. Each instance is a fully isolated portal — its own database, file
storage, admin, provider keys and secrets — defined by one generated env file
in `instances/<name>.env`. For each you give a short name, its public domain,
and a local port (auto-suggested: 3001, 3002, …). The script builds the images
once, starts the shared engines, and brings every instance up. Migrations apply
automatically, per instance.

**To update everything**, run the same command again:

```bash
./deploy.sh          # git pull + rebuild once + update every instance
./deploy.sh add      # add another instance later
```

Updates never touch data or regenerate env files: each instance's master key,
sessions, database and files are preserved.

> **Back up each instance's `OPNINFER_MASTER_KEY`** (in `instances/<name>.env`).
> Without it, that instance's stored provider keys cannot be decrypted.

## How it is laid out

- **One checkout, N instances.** Every instance is its own Docker Compose
  project (`opninfer-<name>`): Postgres, a migrator, the app, the ingestion
  worker and the sandbox broker, with its own named volumes
  (`opninfer-<name>_pgdata`, `opninfer-<name>_storage`). Instances cannot see
  each other's data.
- **Shared engines, one copy for all.** Gotenberg (Office→PDF), Docling (OCR),
  Whisper (speech-to-text) and Kokoro (text-to-speech) run **once**, in the
  `opninfer-engines` stack. They are always on, and shared safely because they
  are stateless converters that store nothing. Tune them in `engines.env`
  (`WHISPER_MODEL`, a GPU `TTS_IMAGE`, …).
- **Your reverse proxy terminates TLS.** There is no bundled TLS server. Each
  instance publishes plain HTTP on its port, bound to `0.0.0.0`, so a proxy
  elsewhere on the network can reach it. Point each site at
  `http://<host>:<port>`.
- **An operator console**, optional and on by default, runs the same image with
  `OPNINFER_MODE=console` on port 3000: one read-only view across every portal
  on the host. It has no database of its own and connects to each portal with a
  Postgres role that holds `SELECT` and nothing else. `./deploy.sh
  console-password` sets a sign-in; `OPNINFER_SKIP_CONSOLE=1` turns it off.

## Reverse-proxy requirements, per site

- Forward the `Host` and `X-Forwarded-Proto` headers — auth redirects depend on
  them, and each instance's `AUTH_URL` is its public HTTPS domain.
- **Disable response buffering.** Chat streams over Server-Sent Events, and a
  buffering proxy turns a live reply into a long silence followed by a wall of
  text.
- Allow request bodies at least as large as the upload limit (default 50 MB).
- Generous read and idle timeouts — a reply can legitimately stream for
  minutes, and an agent run for longer.

## Sizing

Each portal is single-process by design: in-memory model cache, stream
registry and log listeners, and a local storage volume. **Scale up** (CPU, RAM,
and `connection_limit` on `DATABASE_URL`) and add portals side by side on the
same host, rather than clustering one portal.

Budget roughly 1 GB of RAM and one CPU per *concurrent* Sandbox agent run, on
top of the 2 GB each agent container reserves. The engine images are large
(~23 GB for all four), so give the Docker data root room.

## The Sandbox's credentials

The agent tier can be paid for two ways, set per instance in **Admin → Tools**:

- **The organisation's API key.** The key never enters the container — a
  credential proxy injects it and meters the real usage Anthropic reports.
- **A Claude subscription.** Sign in with Anthropic's own flow, per instance:

  ```bash
  ./deploy.sh agent-token <instance>   # a long-lived token (recommended)
  ./deploy.sh agent-logout <instance>  # take an instance off the plan
  ```

  Prefer `agent-token`. The alternative (`agent-login`) writes a credential
  that refreshes every few hours and is shared by every chat container, so the
  containers race to refresh it and lose each other's sign-in. A long-lived
  token has nothing to refresh. The one measured cost is that plan-usage
  percentages stop being readable; runs are unaffected.

**Connected services (MCP)** are set up per instance with Claude Code's own
commands, so only that instance's agents get them:

```bash
./deploy.sh agent-mcp <instance> add figma https://mcp.figma.com/mcp
./deploy.sh agent-mcp <instance> login figma
```

## Backups

**Admin → Backups** snapshots a whole instance — the database plus every stored
file — into a single downloadable zip, on demand or on a schedule (daily or
weekly, with a retention count). Restore by uploading a zip; it replaces all
current data and files.

Backups are written under the storage volume (`<storage>/backups`), so they
survive updates — but that is the same disk, so **copy them off the box** for
real disaster recovery.

Restoring onto a *different* instance needs the **same `OPNINFER_MASTER_KEY`**,
or the encrypted provider keys will not decrypt. The UI warns you when the
backup's key fingerprint differs from the instance's.

## Housekeeping

Every deploy prunes untagged images, exited containers older than a day, and
old build cache, and prints `docker system df` so the disk is never a surprise.
It never prunes tagged images or volumes — those are the engine images and your
instance data. `OPNINFER_SKIP_CLEANUP=1` turns it off.

## When something is wrong

`deploy.sh` verifies its own work rather than reporting success it has not
checked: migrations exited cleanly, the app answers HTTP, the ingestion worker
actually reached its database, the sandbox broker is listening, and the shared
engines respond. A failure prints a red list and exits non-zero.

That check list exists because "the containers started" is not "it works" — an
ingestion worker once sat unable to reach its database for eight days while
every container reported healthy.
