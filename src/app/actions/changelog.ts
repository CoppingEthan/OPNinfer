"use server";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { APP_VERSION } from "@/lib/version";
import { appLog } from "@/lib/applog";
import { parseChangelog, releasesSince, type Release } from "@/lib/changelog";

/**
 * The What's new panel's server half: read CHANGELOG.md off disk, decide what
 * this user has not seen, and record that they've seen it.
 *
 * The dismissal stamp is ALWAYS the server's own APP_VERSION, never anything
 * the client sends. A browser that could name its own "seen" version could
 * claim to have seen a version that doesn't exist yet and quietly suppress
 * every future release note.
 *
 * DEPLOYMENT NOTE: CHANGELOG.md is a plain file, and the Next standalone build
 * ships only what the Dockerfile COPYs — the import tracer never sees it. The
 * Dockerfile copies it explicitly and src/lib/changelog.test.ts asserts that
 * line, because the failure mode is invisible: readFile throws, we treat it as
 * "no notes yet", and the panel is permanently empty in production while
 * working perfectly in dev.
 */

const CHANGELOG_PATH = path.join(process.cwd(), "CHANGELOG.md");

/** Parsed notes, held in memory. Re-read only when the file itself changes,
 *  so a dev edit shows up without a restart while production reads disk once. */
let cache: { key: string; releases: Release[] } | null = null;
/** Warn about an unreadable file ONCE — this runs on every chat mount. */
let warned = false;

async function loadReleases(): Promise<Release[]> {
  try {
    const info = await stat(CHANGELOG_PATH);
    const key = `${info.mtimeMs}:${info.size}`;
    if (cache?.key === key) return cache.releases;
    const releases = parseChangelog(await readFile(CHANGELOG_PATH, "utf8"));
    cache = { key, releases };
    warned = false;
    return releases;
  } catch (error) {
    // No notes shipped (or unreadable) — the panel simply never appears. Logged
    // through appLog rather than devLog so this leaves a trace in production,
    // where it is exactly the symptom an admin would otherwise have nothing to
    // go on for ("the panel is empty and nothing is wrong").
    if (!warned) {
      warned = true;
      void appLog("warn", "app", "could not read CHANGELOG.md — What's new is empty", {
        details: {
          path: CHANGELOG_PATH,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return [];
  }
}

export interface WhatsNewData {
  /** The running app version — what a dismissal will be stamped with. */
  version: string;
  /** Releases to show, newest first. Empty means nothing to show. */
  releases: Release[];
}

/**
 * What this user has not seen yet. Empty `releases` = don't pop the panel.
 * A first-time viewer (no stamp) gets only the latest release, not the whole
 * history — see `releasesSince`.
 */
export async function getWhatsNew(): Promise<WhatsNewData> {
  const user = await requireUser();
  const [releases, row] = await Promise.all([
    loadReleases(),
    db.user.findUnique({
      where: { id: user.id },
      select: { lastSeenVersion: true },
    }),
  ]);
  return {
    version: APP_VERSION,
    releases: releasesSince(releases, row?.lastSeenVersion, APP_VERSION),
  };
}

/**
 * Everything shipped, for someone who opened the panel deliberately from the
 * account menu — that's a request for the history, not an interruption.
 */
export async function getReleaseHistory(): Promise<WhatsNewData> {
  await requireUser();
  const releases = await loadReleases();
  return {
    version: APP_VERSION,
    releases: releasesSince(releases, "0", APP_VERSION),
  };
}

/**
 * Record that the user has seen the notes. Called on DISMISSAL, not on
 * display: closing the tab without reading them means seeing them next time.
 */
export async function markWhatsNewSeen(): Promise<void> {
  const user = await requireUser();
  await db.user.update({
    where: { id: user.id },
    data: { lastSeenVersion: APP_VERSION },
  });
}
