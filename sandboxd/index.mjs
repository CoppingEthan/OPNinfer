/**
 * OPNinfer sandboxd — the sandbox broker ("guard hut").
 *
 * This tiny service is the ONLY thing holding the Docker socket. The app asks
 * it, over a shared-secret internal HTTP API, to run the Sandbox agent
 * (Claude Code) in per-chat containers; ALL policy is enforced HERE, not in
 * the app:
 *
 *   - image allowlist (exactly AGENT_IMAGE)
 *   - conversation id must be a UUID; mounts are exactly that chat's pool
 *     (/workspace) and that chat's agent-state directory (~/.claude)
 *   - the operator's sign-in is the ONE shared thing: a named volume beside
 *     the state dir, symlinked in (see linkAgentCredential)
 *   - tmpfs over /workspace/.opninfer (prepared artifacts stay invisible)
 *   - egress-only network (or none) — never the internal compose network
 *   - hard caps: memory / cpus / pids, cap-drop ALL, no-new-privileges,
 *     read-only rootfs (+ tmpfs /tmp and home)
 *   - warm per-conversation containers, idle-reaped; full sweep at boot
 *
 * v0.4: the old one-command-at-a-time exec tier was retired; only the agent
 * tier remains. The boot sweep still removes any pre-upgrade containers that
 * carry this instance's label.
 *
 * API (Authorization: Bearer $SANDBOX_BROKER_TOKEN):
 *   POST   /sandboxes/:convId/agent/attach   duplex stdio (see wire.ts in the app)
 *   POST   /sandboxes/:convId/agent/signal   { signal: "INT" | "TERM" | "KILL" }
 *   DELETE /sandboxes/:convId/agent
 *   GET    /health
 *   GET    /packages                       what the agent image ships
 *   GET    /agent-mcp[?fresh=1]            connected services (MCP) — see agentMcpConfig
 */

import { createServer } from "node:http";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Docker from "dockerode";
import { isUsableCredential } from "./credentials.mjs";

const docker = new Docker(); // /var/run/docker.sock

// --- configuration -----------------------------------------------------------
const TOKEN = process.env.SANDBOX_BROKER_TOKEN ?? "";
if (!TOKEN) {
  console.error("[sandboxd] SANDBOX_BROKER_TOKEN is required");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 8070);
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";
/**
 * Which PORTAL this broker belongs to.
 *
 * Deliberately separate from TENANT: the tenant id is the storage directory
 * name (`<tenant>/chats/<id>`) and deploy.sh writes "default" for every
 * instance, so renaming it would orphan every existing pool on disk. This one
 * exists purely to keep one portal's containers distinguishable from
 * another's on a shared Docker daemon.
 */
const INSTANCE = process.env.OPNINFER_INSTANCE ?? TENANT;
/** Dev: host path of the storage tree (bind mounts). */
const STORAGE_HOST_ROOT = process.env.STORAGE_HOST_ROOT ?? "";
/** Prod: named volume + subpath mounts (Docker Engine >= 26). */
const STORAGE_VOLUME = process.env.STORAGE_VOLUME ?? "";
/** "egress" (default: internet yes, internal network no) or "none". */
const NETWORK_MODE = process.env.SANDBOX_NETWORK ?? "egress";
/**
 * Every portal on the host runs its own sandboxd against the same Docker
 * daemon. Instance-scoped names, labels and networks are what keep each
 * portal's reaper from removing the others' running containers.
 */
const EGRESS_NETWORK = `opninfer_sandbox_egress_${INSTANCE}`;
const LABEL = "opninfer.sandbox";
/** Value of that label — the instance, so a sweep only ever sees its own. */
const LABEL_VALUE = INSTANCE;

/**
 * Agent tier ("Sandbox"): a long-lived Claude Code process the app's Agent
 * SDK harness attaches to over bidirectional stdio. A PERSISTENT named volume
 * holds the operator's subscription /login (it must survive recycling); the
 * per-chat state directory holds everything else. No per-command timeout —
 * runs are long and interactive; the ceiling below is an orphan backstop,
 * not the run budget, which the app owns.
 */
const AGENT_IMAGE = process.env.AGENT_IMAGE ?? "opninfer-agent";
const AGENT_CONFIG_VOLUME =
  process.env.AGENT_CONFIG_VOLUME ?? `opninfer-agent-config-${INSTANCE}`;
const AGENT_MEMORY = process.env.AGENT_MEMORY ?? "2g";
const AGENT_CPUS = Number(process.env.AGENT_CPUS ?? 2);
const AGENT_PIDS = Number(process.env.AGENT_PIDS ?? 256);
const AGENT_IDLE_SECONDS = Number(process.env.AGENT_IDLE_SECONDS ?? 1800);
/** Orphan backstop on one attach (seconds) — kills a CLI whose harness died
 *  without cleaning up. Generous: the app enforces the real per-run budget. */
const AGENT_MAX_SECONDS = Number(process.env.AGENT_MAX_SECONDS ?? 3600);
const AGENT_SIGNALS = new Set(["INT", "TERM", "KILL"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memBytes = (s) => {
  const m = String(s).match(/^(\d+)([kmg]?)$/i);
  if (!m) return 2 * 1024 ** 3;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
};

/** `agent:<convId>` → last activity ms (for the idle reaper). */
const activity = new Map();
/** `agent:<convId>` → open exec attaches (a live run, never reaped as idle). */
const attached = new Map();

// --- docker helpers ------------------------------------------------------------

async function ensureEgressNetwork() {
  if (NETWORK_MODE !== "egress") return "none";
  try {
    await docker.getNetwork(EGRESS_NETWORK).inspect();
  } catch {
    // Plain bridge: containers get internet egress but sit on their own
    // network — the compose internal network (db/app/engines) is unreachable.
    await docker.createNetwork({ Name: EGRESS_NETWORK, Driver: "bridge" }).catch(() => {});
  }
  return EGRESS_NETWORK;
}

function agentContainerName(convId) {
  return `oi-agent-${INSTANCE}-${convId}`;
}

/** A per-chat directory from the storage tree: bind in dev, named-volume
 *  subpath in prod (the app must have created it — Docker won't). */
function storageMount(rel, target) {
  return STORAGE_HOST_ROOT
    ? {
        Type: "bind",
        Source: `${STORAGE_HOST_ROOT.replace(/[\\/]+$/, "")}/${rel}`,
        Target: target,
      }
    : {
        Type: "volume",
        Source: STORAGE_VOLUME,
        Target: target,
        VolumeOptions: { Subpath: rel },
      };
}

async function ensureAgentContainer(convId) {
  const name = agentContainerName(convId);
  const existing = docker.getContainer(name);
  try {
    const info = await existing.inspect();
    if (info.State.Running) return existing;
    try {
      await existing.start();
      return existing;
    } catch (e) {
      // A container that won't start must not be left behind to 409 every
      // later attach on its name.
      console.error(`[sandboxd] agent ${convId}: stale container wouldn't start (${e.message}) — recreating`);
      await existing.remove({ force: true }).catch(() => {});
    }
  } catch {
    /* doesn't exist — create below */
  }

  const network = await ensureEgressNetwork();
  const poolMount = storageMount(`${TENANT}/chats/${convId}`, "/workspace");
  // ISOLATION: this chat's own ~/.claude. The CLI keys transcripts by working
  // directory and every agent container uses /workspace, so a single shared
  // config dir would file every chat's history under one key — work, personal
  // and private in the same directory. One per conversation instead, which
  // also means resume survives container recycling.
  const stateMount = storageMount(`${TENANT}/agent/${convId}`, "/home/sandbox/.claude");

  const container = await docker.createContainer({
    name,
    Image: AGENT_IMAGE, // allowlist — the only image this broker can ever run
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    Labels: { [LABEL]: LABEL_VALUE, "opninfer.conv": convId, "opninfer.kind": "agent" },
    HostConfig: {
      // Depth order matters: tmpfs home first, then this chat's state dir on
      // top at ~/.claude, then the SHARED credential volume beside it. Only
      // the credential is shared between chats — see linkAgentCredential.
      Mounts: [
        poolMount,
        {
          Type: "tmpfs",
          Target: "/home/sandbox",
          // 1777 (sticky, world-writable): a --mount tmpfs defaults to a
          // ROOT-OWNED 750 dir, which uid-1000 can't even traverse — the CLI
          // died on an unreachable $CLAUDE_CONFIG_DIR before saying a word.
          // Ownership can't be set here (TmpfsOptions has no uid/gid), so
          // /tmp-style permissions it is; the container is single-user.
          TmpfsOptions: { SizeBytes: 1024 ** 3, Mode: 0o1777 },
        },
        stateMount,
        {
          Type: "volume",
          Source: AGENT_CONFIG_VOLUME,
          Target: "/home/sandbox/.claude-shared",
          // READ-ONLY for the agent (audit 2026-09-05). Writable, any chat's
          // agent could plant an MCP server in the shared .claude.json that
          // every other chat then ran, or wipe the sign-in. The CLI's token
          // refresh replaces the symlink in the chat's OWN state dir with a
          // regular file; the broker copies that back into the volume itself
          // (captureRefreshedCredential) — the container never can.
          ReadOnly: true,
        },
      ],
      Tmpfs: {
        "/workspace/.opninfer": "rw,size=64m", // prepared artifacts stay masked
        "/tmp": "rw,size=512m",
      },
      // The org-API-key path points the CLI at the app's credential proxy
      // via host.docker.internal. Docker Desktop resolves that name itself;
      // a Linux host needs this mapping (Engine 20.10+).
      ExtraHosts: ["host.docker.internal:host-gateway"],
      ReadonlyRootfs: true,
      Memory: memBytes(AGENT_MEMORY),
      MemorySwap: memBytes(AGENT_MEMORY),
      NanoCpus: Math.round(AGENT_CPUS * 1e9),
      PidsLimit: AGENT_PIDS,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: network,
      RestartPolicy: { Name: "no" },
    },
  });
  try {
    await container.start();
  } catch (e) {
    await container.remove({ force: true }).catch(() => {});
    const hint = /cannot access path|subpath|no such file/i.test(e.message ?? "")
      ? " (the conversation's storage or agent-state directory is missing — the app should create both before requesting an agent)"
      : "";
    throw new Error(`could not start the agent container: ${e.message}${hint}`);
  }
  // A refreshed pair left behind by a run that ended without its sync (a
  // crash, a reaped container) is picked up here before the link is remade.
  await captureRefreshedCredential(container, convId);
  await linkAgentCredential(container, convId);
  return container;
}

// --- tar (in memory, single entry) -------------------------------------------
// dockerode moves files as tar archives (getArchive / putArchive). These two
// helpers cover the one-file case without a dependency: a 512-byte header
// (name, mode, uid/gid, size and mtime in octal, checksum, type flag), the
// data padded to 512, and two zero blocks at the end.

function parseSingleTarEntry(buf) {
  if (!buf || buf.length < 512) return null;
  const header = buf.subarray(0, 512);
  if (header.every((b) => b === 0)) return null;
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
  const type = String.fromCharCode(header[156]);
  const data = buf.subarray(512, 512 + size);
  return { name, size, type, data };
}

function buildSingleTarEntry(name, data, { mode = 0o600, uid = 1000, gid = 1000 } = {}) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "utf8");
  header.write(uid.toString(8).padStart(7, "0") + "\0", 108, 8, "utf8");
  header.write(gid.toString(8).padStart(7, "0") + "\0", 116, 8, "utf8");
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8"); // checksum field is spaces while summing
  header[156] = "0".charCodeAt(0); // regular file
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024, 0)]);
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * The broker-side half of the sign-in sync (audit 2026-09-05). The CLI
 * refreshes the plan's token every ~8 h and writes the new pair with a
 * temp file + rename — which replaces the symlink in the chat's state dir
 * with a REGULAR file. With the shared volume mounted read-only in every
 * chat container, only the broker can carry that file back: read it out of
 * the container, insist it is a credentials JSON (never the link target as
 * text that a restore once left there), and write it into the volume
 * through a throwaway container. Anthropic rotates refresh tokens, so a
 * pair left behind is the ONLY valid one — losing it signs the instance out.
 */
async function captureRefreshedCredential(container, convId) {
  let entry;
  try {
    const tar = await container.getArchive({ path: "/home/sandbox/.claude/.credentials.json" });
    entry = parseSingleTarEntry(await readAll(tar));
  } catch (e) {
    if (e?.statusCode !== 404) console.error(`[sandboxd] agent ${convId}: credential read failed: ${e.message}`);
    return false;
  }
  if (!entry || entry.type !== "0") return false; // no file, or still the symlink — nothing refreshed
  let parsed;
  try {
    parsed = JSON.parse(entry.data.toString("utf8"));
  } catch {
    return false;
  }
  // Both tokens must actually be there. A FAILED refresh rewrites this file
  // with them blanked, and copying that back would wipe the instance's
  // sign-in for every other chat — see sandboxd/credentials.mjs.
  if (!isUsableCredential(parsed)) {
    console.log(`[sandboxd] agent ${convId}: ignoring a credential file with no usable tokens (a failed refresh) — the shared sign-in is left alone`);
    return false;
  }
  try {
    const probe = await docker.createContainer({
      Image: AGENT_IMAGE,
      Cmd: ["true"],
      Labels: { [LABEL]: LABEL_VALUE, "opninfer.kind": "probe" },
      HostConfig: {
        NetworkMode: "none",
        CapDrop: ["ALL"],
        Mounts: [{ Type: "volume", Source: AGENT_CONFIG_VOLUME, Target: "/shared" }],
      },
    });
    try {
      await probe.putArchive(buildSingleTarEntry(".credentials.json", entry.data), { path: "/shared" });
    } finally {
      await probe.remove({ force: true }).catch(() => {});
    }
    console.log(`[sandboxd] agent ${convId}: refreshed sign-in synced back to the shared volume`);
    return true;
  } catch (e) {
    console.error(`[sandboxd] agent ${convId}: credential sync-back failed: ${e.message}`);
    return false;
  }
}

/**
 * Give this chat's private config dir access to the ONE shared thing: the
 * operator's sign-in.
 *
 * A symlink rather than a copy, deliberately — an OAuth login refreshes
 * itself, and a copy would strand the new token in a container that is about
 * to be reaped, logging the instance out at an arbitrary future moment. The
 * link means a refresh writes straight back to the shared volume.
 *
 * Everything ELSE in ~/.claude (transcripts, history, project config) stays
 * per-conversation. Notably `.claude.json` is NOT linked: it is keyed by
 * working directory, every container uses /workspace, so sharing it would put
 * one chat's prompt history in front of another chat.
 */
/** The credential sync/link script (cred-sync.sh — the comment there says
 *  why). Read from its own file so scripts/test-cred-sync.sh exercises the
 *  exact bytes the broker runs. */
const CRED_SYNC_SH = readFileSync(new URL("./cred-sync.sh", import.meta.url), "utf8");

async function linkAgentCredential(container, convId) {
  try {
    const exec = await container.exec({
      Cmd: ["sh", "-c", CRED_SYNC_SH],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    await new Promise((resolve) => {
      stream.on("end", resolve);
      stream.on("error", resolve);
      stream.resume();
    });
    const code = (await exec.inspect()).ExitCode;
    if (code !== 0) console.error(`[sandboxd] agent ${convId}: credential link exited ${code}`);
  } catch (e) {
    // Not fatal here: the CLI will say "Not logged in", which is a far
    // clearer symptom than a container that refuses to start.
    console.error(`[sandboxd] agent ${convId}: credential link failed: ${e.message}`);
  }
}

/** Read the request until the first newline: returns [headerLine, remainder].
 *  Everything after that newline is the CLI's stdin and must not be consumed
 *  here — it belongs to the attach pipe. */
function readHeaderLine(req) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) {
        req.off("data", onData);
        req.pause();
        resolve([buf.slice(0, nl).toString("utf8"), buf.slice(nl + 1)]);
      } else if (buf.length > 65_536) {
        req.off("data", onData);
        reject(new Error("attach header too large"));
      }
    };
    req.on("data", onData);
    req.once("end", () => resolve([buf.toString("utf8"), Buffer.alloc(0)]));
    req.once("error", reject);
  });
}

/**
 * Bidirectional attach: run `claude <args>` in the chat's agent container,
 * with the request body (after the header line) as its stdin and the response
 * as NDJSON envelopes — {"o":base64} stdout, {"e":base64} stderr, then one
 * {"exit":code}. stdout/stderr must be demuxed here (a docker exec
 * multiplexes them) because the app hands stdout to the Agent SDK, which
 * parses it as a control stream — a stray stderr byte would corrupt it.
 */
async function handleAgentAttach(req, res, convId) {
  const [headerLine, remainder] = await readHeaderLine(req);
  let header;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return json(res, 400, { error: "invalid attach header" });
  }
  if (!Array.isArray(header.args) || !header.args.every((a) => typeof a === "string")) {
    return json(res, 400, { error: "attach header needs args: string[]" });
  }
  const env = [];
  if (header.env && typeof header.env === "object") {
    for (const [k, v] of Object.entries(header.env)) {
      if (typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env.push(`${k}=${v}`);
    }
  }

  const container = await ensureAgentContainer(convId);
  const key = `agent:${convId}`;
  activity.set(key, Date.now());
  // An open attach is a live run, however quiet: a long silent tool call
  // must not be reaped as "idle" mid-exec (audit 2026-09-05). Counted down
  // when the exec stream ends.
  attached.set(key, (attached.get(key) ?? 0) + 1);

  let stream;
  let exec;
  try {
    exec = await container.exec({
      // The orphan backstop, not the run budget — see AGENT_MAX_SECONDS.
      Cmd: ["timeout", "-s", "KILL", String(AGENT_MAX_SECONDS), "claude", ...header.args],
      Env: env,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/workspace",
    });
    stream = await exec.start({ hijack: true, stdin: true });
  } catch (e) {
    // Say WHY — "container is not running" alone cost a debugging round.
    // State/ExitCode tells you whether it died at boot or was reaped.
    let state = "unknown";
    try {
      const s = (await container.inspect()).State;
      state = `${s.Status} exit=${s.ExitCode} oom=${s.OOMKilled} err=${s.Error || "-"}`;
    } catch {
      /* gone entirely */
    }
    console.error(`[sandboxd] agent ${convId}: exec failed (${e.message}); container state: ${state}`);
    return json(res, 500, { error: `agent exec failed: ${e.message} (container: ${state})` });
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });

  const send = (obj) => {
    try {
      res.write(JSON.stringify(obj) + "\n");
    } catch {
      /* client gone — the CLI winds down on its own stdin EOF */
    }
  };
  const out = {
    write: (b) => {
      activity.set(key, Date.now());
      send({ o: b.toString("base64") });
    },
  };
  const err = { write: (b) => send({ e: b.toString("base64") }) };
  docker.modem.demuxStream(stream, out, err);

  // stdin: the buffered remainder first, then the live request tail.
  if (remainder.length > 0) stream.write(remainder);
  req.on("data", (chunk) => {
    activity.set(key, Date.now());
    stream.write(chunk);
  });
  // App closed its side (SDK graceful shutdown = stdin EOF): half-close so
  // the CLI sees EOF and exits cleanly.
  req.on("end", () => stream.end());
  // App connection died entirely: same story — EOF is the wind-down signal.
  req.on("error", () => stream.end());
  req.resume();

  stream.on("end", async () => {
    let code = -1;
    try {
      code = (await exec.inspect()).ExitCode ?? -1;
    } catch {
      /* container gone */
    }
    // A token the CLI refreshed during this run must reach the shared volume
    // before anything else runs: the broker copies it (the volume is
    // read-only inside the container), then the link is remade.
    await captureRefreshedCredential(container, convId);
    await linkAgentCredential(container, convId);
    activity.set(key, Date.now());
    attached.set(key, Math.max(0, (attached.get(key) ?? 1) - 1));
    send({ exit: code });
    res.end();
  });
  stream.on("error", () => {
    attached.set(key, Math.max(0, (attached.get(key) ?? 1) - 1));
    send({ exit: -1 });
    res.end();
  });
}

/** Signal the CLI inside the agent container (interrupt/terminate) without
 *  tearing the warm container down. */
async function signalAgent(convId, signal) {
  const container = docker.getContainer(agentContainerName(convId));
  const exec = await container.exec({
    Cmd: ["pkill", `-${signal}`, "-f", "claude"],
    AttachStdout: false,
    AttachStderr: false,
  });
  await exec.start({});
}

async function destroyAgent(convId) {
  activity.delete(`agent:${convId}`);
  try {
    await docker.getContainer(agentContainerName(convId)).remove({ force: true });
  } catch {
    /* not running */
  }
}

/** Boot + periodic sweep: remove labelled containers that outlived their use.
 *  At boot (`all`) EVERY container carrying this instance's label goes —
 *  including any pre-v0.4 exec-tier sandbox left over from before the
 *  upgrade, which nothing else would ever reap now. */
async function sweep(all = false) {
  try {
    const list = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${LABEL_VALUE}`] },
    });
    for (const c of list) {
      // Throwaway probe containers (readFromAgentImage) are removed by their
      // caller; one caught here between exit and removal is tidied quietly,
      // never logged as a "reaped idle agent undefined". A RUNNING probe is
      // mid-read and must be left alone.
      if (c.Labels["opninfer.kind"] === "probe") {
        if (all || c.State !== "running") await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
        continue;
      }
      const convId = c.Labels["opninfer.conv"];
      const key = `agent:${convId}`;
      const last = activity.get(key) ?? 0;
      if (!all && (attached.get(key) ?? 0) > 0) continue; // a run is attached — quiet is not idle
      if (all || Date.now() - last > AGENT_IDLE_SECONDS * 1000) {
        await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
        activity.delete(key);
        if (!all) console.log(`[sandboxd] reaped idle agent ${convId}`);
      }
    }
  } catch (e) {
    console.error("[sandboxd] sweep error:", e.message);
  }
}

// --- http ------------------------------------------------------------------------

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const got = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Run one short command in a throwaway container from the agent image and
 * return its stdout. docker.run streams the container's stdout into `sink`
 * while it runs — the documented dockerode pattern (container.logs() returns
 * a different shape per version). Offline, read-only rootfs, capped.
 */
async function readFromAgentImage(cmd, hostConfig = {}) {
  const chunks = [];
  const sink = new Writable({
    write(d, _enc, cb) {
      chunks.push(Buffer.from(d));
      cb();
    },
  });
  const [result, container] = await docker.run(AGENT_IMAGE, cmd, sink, {
    Tty: true, // raw bytes, no stream framing
    Labels: { [LABEL]: LABEL_VALUE, "opninfer.kind": "probe" },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      Memory: 64 * 1024 * 1024,
      PidsLimit: 16,
      ...hostConfig,
    },
  });
  await container.remove({ force: true }).catch(() => {});
  const text = Buffer.concat(chunks).toString("utf8");
  if (result && result.StatusCode) throw new Error(`probe exited ${result.StatusCode}: ${text.slice(0, 200)}`);
  return text;
}

let packagesCache = null; // { imageId, data }
async function imagePackages() {
  const { Id } = await docker.getImage(AGENT_IMAGE).inspect();
  if (packagesCache && packagesCache.imageId === Id) return packagesCache.data;
  const data = JSON.parse((await readFromAgentImage(["cat", "/etc/opninfer/packages.json"])).trim());
  packagesCache = { imageId: Id, data };
  return data;
}

/**
 * Connected services (MCP) for this instance (2026-09-03) — read out of the
 * agent credential volume, which is Claude Code's OWN config: `.claude.json`
 * (user-scope `mcpServers`, written by `claude mcp add -s user`) and
 * `.credentials.json` (`mcpOAuth`, written by `claude mcp login`). The
 * reader runs INSIDE a container from the agent image with the volume
 * mounted read-only and reduces each stored token to a boolean — the token
 * itself never leaves the volume. Cached a minute; `?fresh=1` bypasses (the
 * admin page), so a just-run `agent-mcp add` shows up on reload.
 */
const AGENT_MCP_READER = [
  'const fs = require("fs");',
  'const d = "/home/sandbox/.claude";',
  'const j = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };',
  'const c = j(d + "/.claude.json"), k = j(d + "/.credentials.json");',
  'const servers = c.mcpServers && typeof c.mcpServers === "object" ? c.mcpServers : {};',
  'const store = k.mcpOAuth && typeof k.mcpOAuth === "object" ? k.mcpOAuth : {};',
  'const oauth = {};',
  'for (const [key, v] of Object.entries(store)) if (v && (v.refreshToken || v.accessToken)) oauth[key.split("|")[0]] = true;',
  'process.stdout.write(JSON.stringify({ servers, oauth }));',
].join("\n");
let mcpCache = null; // { at, data }
async function agentMcpConfig(fresh) {
  if (!fresh && mcpCache && Date.now() - mcpCache.at < 60_000) return mcpCache.data;
  const text = await readFromAgentImage(["node", "-e", AGENT_MCP_READER], {
    Memory: 192 * 1024 * 1024, // node, not cat
    PidsLimit: 32,
    Mounts: [{ Type: "volume", Source: AGENT_CONFIG_VOLUME, Target: "/home/sandbox/.claude", ReadOnly: true }],
  });
  const data = JSON.parse(text.trim() || "{}");
  mcpCache = { at: Date.now(), data };
  return data;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, agents: activity.size, image: AGENT_IMAGE });
    }
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    // What the agent image ships (owner ask, 2026-09-02): the manifest
    // written at build time, read out of a throwaway container from the
    // SAME image the agents run — never from this broker's own host — and
    // cached per image id so a rebuild is picked up without a restart.
    if (req.method === "GET" && req.url === "/packages") {
      try {
        return json(res, 200, await imagePackages());
      } catch (e) {
        return json(res, 503, { error: `manifest unavailable: ${e.message}` });
      }
    }
    // Connected services (MCP) from the instance's credential volume — see
    // agentMcpConfig. Never the tokens.
    if (req.method === "GET" && /^\/agent-mcp(\?|$)/.test(req.url ?? "")) {
      try {
        return json(res, 200, await agentMcpConfig(/[?&]fresh=1/.test(req.url)));
      } catch (e) {
        return json(res, 503, { error: `agent config unavailable: ${e.message}` });
      }
    }

    const attach = req.url?.match(/^\/sandboxes\/([0-9a-f-]{36})\/agent\/attach$/i);
    if (req.method === "POST" && attach) {
      const convId = attach[1].toLowerCase();
      if (!UUID_RE.test(convId)) return json(res, 400, { error: "bad conversation id" });
      // `return await`, NOT `return`: a bare returned promise's rejection
      // escapes this try/catch entirely — it became an unhandled rejection
      // that took the whole BROKER down on the first attach error (found
      // live: every sandbox on the host restarted because one agent
      // container had stopped).
      return await handleAgentAttach(req, res, convId);
    }

    const sig = req.url?.match(/^\/sandboxes\/([0-9a-f-]{36})\/agent\/signal$/i);
    if (req.method === "POST" && sig) {
      const convId = sig[1].toLowerCase();
      if (!UUID_RE.test(convId)) return json(res, 400, { error: "bad conversation id" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000) return json(res, 413, { error: "body too large" });
      }
      let signal = "TERM";
      try {
        signal = String(JSON.parse(raw || "{}").signal ?? "TERM").replace(/^SIG/, "");
      } catch {
        /* default */
      }
      if (!AGENT_SIGNALS.has(signal)) return json(res, 400, { error: "bad signal" });
      await signalAgent(convId, signal).catch(() => {});
      return json(res, 200, { ok: true });
    }

    const delAgent = req.url?.match(/^\/sandboxes\/([0-9a-f-]{36})\/agent$/i);
    if (req.method === "DELETE" && delAgent) {
      const id = delAgent[1].toLowerCase();
      if (!UUID_RE.test(id)) return json(res, 400, { error: "bad conversation id" });
      await destroyAgent(id);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[sandboxd] request error:", e);
    return json(res, 500, { error: String(e.message ?? e).slice(0, 300) });
  }
});

// A Sandbox run is ONE request held open for its whole life: the CLI's stdin
// rides the request body (see agentAttach), so from Node's point of view the
// request is never "fully received" until the run ends. Node's http server
// has closed any request still incomplete after FIVE MINUTES by default
// since v18 (`requestTimeout`, checked every 30 s) — which killed every run
// longer than that at 5:00–5:30, mid-command, with nothing in any log
// (found live 2026-09-10: two containers torn down at 5m10s and 5m22s while
// a hung download ran; earlier cut-offs for three other people matched).
// The per-run budget is the admin's `maxMinutes`, enforced by the app; the
// broker must not impose a second, invisible one. headersTimeout stays as a
// slow-loris guard (it only covers the headers, which arrive at once).
server.requestTimeout = 0;
server.headersTimeout = 60_000;

await sweep(true); // fresh start: no orphans from a previous life
setInterval(() => void sweep(false), 60_000).unref();

server.listen(PORT, () => {
  console.log(
    `[sandboxd] listening on :${PORT} network=${NETWORK_MODE} ` +
      `storage=${STORAGE_HOST_ROOT ? `bind:${STORAGE_HOST_ROOT}` : `volume:${STORAGE_VOLUME}`} ` +
      `agent=${AGENT_IMAGE} agent-config=${AGENT_CONFIG_VOLUME} ` +
      `caps=${AGENT_MEMORY}/${AGENT_CPUS}cpu/${AGENT_PIDS}pids idle=${AGENT_IDLE_SECONDS}s`,
  );
});
