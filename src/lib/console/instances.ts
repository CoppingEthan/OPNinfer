/**
 * Which portals this console watches, and how it reaches them.
 *
 * Every portal is its own compose project (`opninfer-<name>`) with its own
 * Postgres that is NOT published on the host — so the console joins each
 * project's docker network and connects to the database container by name
 * (`opninfer-<name>-db-1`, unique across the daemon, unlike the service alias
 * `db` which every project shares).
 *
 * It connects as a dedicated `console_ro` role that deploy.sh creates in each
 * database with SELECT and nothing else. That is the point of the whole
 * arrangement: the console cannot write to a client's portal because the
 * DATABASE refuses it, not because we were careful in the query layer. It also
 * means the console never holds a portal's real credentials, and never sees an
 * instance master key.
 *
 * Config is one plain variable per portal rather than a JSON blob, because
 * these are written by a shell script into a docker env file where JSON
 * quoting is a trap for no benefit:
 *
 *     CONSOLE_INSTANCES="acme globex northwind initech"
 *     CONSOLE_DB_ACME="postgresql://console_ro:…@opninfer-acme-db-1:5432/opninfer?…"
 *     CONSOLE_LABEL_ACME="chat.acme.example"
 *
 * Pure (env in, records out) so the naming rules are unit-tested.
 */

export interface ConsoleInstance {
  /** Short name, as used for the compose project and the env file. */
  name: string;
  /** What to show in the UI — the public domain when known, else the name. */
  label: string;
  /** Read-only connection string. */
  url: string;
}

/** `acme` → `ACME`, `ini-tech` → `INI_TECH`. Mirrors deploy.sh's env_suffix. */
export function envSuffix(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Read the portal list from an env map (the process env by default).
 *
 * A portal named in `CONSOLE_INSTANCES` with no connection string is DROPPED,
 * not carried as a broken entry: it means deploy.sh could not create the
 * read-only role there, and the console is more useful showing three portals
 * truthfully than four with one permanently erroring.
 */
export function parseInstances(
  env: Record<string, string | undefined> = process.env,
): ConsoleInstance[] {
  const names = (env.CONSOLE_INSTANCES ?? "")
    .split(/[\s,]+/)
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  const out: ConsoleInstance[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    const suffix = envSuffix(name);
    const url = env[`CONSOLE_DB_${suffix}`]?.trim();
    if (!url) continue;
    seen.add(name);
    out.push({
      name,
      label: env[`CONSOLE_LABEL_${suffix}`]?.trim() || name,
      url,
    });
  }
  return out;
}

/** The portals configured for this container. */
export function consoleInstances(): ConsoleInstance[] {
  return parseInstances();
}
