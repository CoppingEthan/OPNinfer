/**
 * Release notes — parsing and the "should this interrupt the user" rules.
 *
 * PURE on purpose (no `server-only`, no DB, no fs): whether a panel pops up
 * over someone's chat is a judgement call with awkward edges — a fresh
 * account, a downgrade, a CHANGELOG entry written before the release it
 * describes — and every one of those is cheaper to unit-test than to discover
 * in production. The server action supplies the file contents and the stored
 * "last seen" value; everything decided about them happens here.
 */

/** One release, as parsed out of CHANGELOG.md. */
export interface Release {
  /** Normalised version string, e.g. "0.3.2" (any leading "v" is dropped). */
  version: string;
  /** Whatever followed the version on the heading line, e.g. "2026-07-30". */
  date?: string;
  /** Top-level bullet points, in document order. */
  items: string[];
}

/**
 * Compare two version strings. Returns <0 if a is older, 0 if equal, >0 if a
 * is newer — the usual `Array.sort` contract.
 *
 * Tolerant by design: a stray "v" prefix, a different number of segments
 * ("0.4" vs "0.4.0"), and a pre-release suffix ("0.4.0-rc1", which ranks BELOW
 * the plain 0.4.0) all compare sensibly. Anything genuinely unparsable sorts
 * as 0 rather than throwing — a malformed heading must not break the chat.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const cleaned = v.trim().replace(/^v/i, "");
    const [core, pre] = cleaned.split("-", 2);
    const parts = core.split(".").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { parts, pre: pre ?? "" };
  };

  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Same numeric core: a pre-release is older than the plain release.
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Does this heading name a version we can compare? */
const VERSION_HEADING = /^##\s+\[?v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)\]?\s*(?:[—–\-:]\s*(.*))?$/;

/**
 * Parse CHANGELOG.md into releases, newest first.
 *
 * Everything before the first version heading (the file's own title and
 * preamble) is ignored, as is any `##` heading with no parsable version —
 * which is what lets an "Unreleased" section sit in the file while work is in
 * progress without ever being shown to a user.
 */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  let collecting = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (/^##\s/.test(line)) {
      const match = VERSION_HEADING.exec(line);
      if (match) {
        current = { version: match[1], items: [] };
        const date = match[2]?.trim();
        if (date) current.date = date;
        releases.push(current);
      } else {
        current = null; // e.g. "## Unreleased" — parsed over, never shown.
      }
      collecting = false;
      continue;
    }
    if (/^#\s/.test(line)) {
      current = null;
      collecting = false;
      continue;
    }
    if (!current) continue;

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      current.items.push(bullet[1].trim());
      collecting = true;
      continue;
    }
    // An indented continuation line belongs to the bullet above it; a blank
    // line or plain prose ends the run.
    if (collecting && /^\s+\S/.test(line) && current.items.length > 0) {
      current.items[current.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    collecting = false;
  }

  return releases
    .filter((r) => r.items.length > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * The releases a user has not seen yet, newest first.
 *
 * Two rules earn their keep here:
 *
 * - A release NEWER than the running app is never returned. Notes are written
 *   before the deploy that ships them, so without this the panel would
 *   announce features the instance does not have yet.
 * - `lastSeen === null` means a brand-new (or pre-existing) account, and gets
 *   ONLY the latest release. Someone opening the portal for the first time
 *   does not want the full history in their face; they want to know the panel
 *   exists, which one release does just as well.
 */
export function releasesSince(
  releases: Release[],
  lastSeen: string | null | undefined,
  currentVersion: string,
): Release[] {
  const shipped = releases
    .filter((r) => compareVersions(r.version, currentVersion) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (shipped.length === 0) return [];
  if (!lastSeen) return shipped.slice(0, 1);
  return shipped.filter((r) => compareVersions(r.version, lastSeen) > 0);
}

/**
 * Should the panel pop itself open over the user's chat?
 *
 * Only when there is something shipped that they have not seen. A user who is
 * somehow ahead of the instance (restored backup, rolled-back deploy) sees
 * nothing rather than being shown old notes as if they were new.
 */
export function shouldShowWhatsNew(
  releases: Release[],
  lastSeen: string | null | undefined,
  currentVersion: string,
): boolean {
  return releasesSince(releases, lastSeen, currentVersion).length > 0;
}
