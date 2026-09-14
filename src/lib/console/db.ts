import "server-only";
import { PrismaClient } from "@prisma/client";
import { consoleInstances, type ConsoleInstance } from "./instances";

/**
 * One Prisma client per portal database, for the read-only console.
 *
 * Prisma rather than a raw driver because the schema is RIGHT HERE — the
 * console and the portals ship from the same repo, so the generated client
 * already matches every table it reads and the aggregate helpers
 * (`groupBy`, `aggregate`) come for free. The pools are deliberately small:
 * this is a dashboard doing a handful of aggregate queries, next to portals
 * that need their connections for live chat.
 *
 * Anchored on `globalThis` for the same reason `db.ts` is — dev hot-reload,
 * and Next instantiating a module once per route bundle, would otherwise open
 * a fresh pool per portal per bundle.
 */
const cache: Map<string, PrismaClient> = ((
  globalThis as { __oiConsoleClients?: Map<string, PrismaClient> }
).__oiConsoleClients ??= new Map());

/** How long any one portal gets before it is reported as unreachable. */
const QUERY_TIMEOUT_MS = 10_000;

function clientFor(inst: ConsoleInstance): PrismaClient {
  const existing = cache.get(inst.name);
  if (existing) return existing;
  const client = new PrismaClient({
    datasourceUrl: withPoolCap(inst.url),
    log: ["error"],
  });
  cache.set(inst.name, client);
  return client;
}

/**
 * Keep each portal's pool tiny. A dashboard refresh fans out across every
 * portal at once, and those connections come out of the SAME Postgres
 * `max_connections` the portal's own app is using to serve chats — the
 * console must never be why a client's portal can't get a connection.
 */
function withPoolCap(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=2&pool_timeout=10`;
}

/** What one portal returned — or why it didn't. */
export interface InstanceResult<T> {
  instance: ConsoleInstance;
  data: T | null;
  /** Present when this portal could not be read; every other portal still is. */
  error: string | null;
}

/**
 * Run a read against every configured portal, concurrently.
 *
 * Never rejects. A portal that is down, mid-deploy, or running a schema the
 * console's client doesn't know yet comes back as an `error` row and the page
 * renders the rest — an overview that blanks because one of four clients is
 * restarting is worse than useless, since the moment you most want to look at
 * it is exactly when something is wrong.
 */
export async function fanOut<T>(
  run: (db: PrismaClient, instance: ConsoleInstance) => Promise<T>,
  instances: ConsoleInstance[] = consoleInstances(),
): Promise<InstanceResult<T>[]> {
  return Promise.all(
    instances.map(async (instance) => {
      try {
        const data = await withTimeout(run(clientFor(instance), instance), instance.name);
        return { instance, data, error: null };
      } catch (e) {
        return { instance, data: null, error: describe(e) };
      }
    }),
  );
}

function withTimeout<T>(p: Promise<T>, name: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${name} did not answer within ${QUERY_TIMEOUT_MS / 1000}s`)),
        QUERY_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

/**
 * A short, safe description of a failure.
 *
 * Prisma's connection errors quote the whole datasource URL, PASSWORD
 * INCLUDED, and this text is rendered in a browser — so anything that looks
 * like a connection string is replaced rather than shown.
 */
function describe(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "<database url>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .slice(0, 300);
}
