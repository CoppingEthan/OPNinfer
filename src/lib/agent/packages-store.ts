import "server-only";
import { db } from "@/lib/db";
import { devLog } from "@/lib/dev-log";
import { brokerGet } from "./broker";
import type { PackageUse } from "./packages";

/**
 * The tally behind Admin → Tools → "What the agent reaches for" (owner ask,
 * 2026-09-02): every install / external fetch the Sandbox agent attempts is
 * one row; the panel shows the top ones over a window, marked against what
 * the image already ships (`fetchImagePackages`).
 */

export async function recordPackageUses(
  uses: PackageUse[],
  ctx: { conversationId: string; userId?: string | null },
): Promise<void> {
  if (uses.length === 0) return;
  try {
    await db.agentPackageUse.createMany({
      data: uses.map((u) => ({
        kind: u.kind,
        name: u.name.slice(0, 200),
        conversationId: ctx.conversationId,
        userId: ctx.userId ?? null,
      })),
    });
  } catch (e) {
    devLog("warn", "agent", "package-use tally failed", { error: String(e) });
  }
}

export interface PackageTally {
  kind: string;
  name: string;
  uses: number;
  chats: number;
  lastAt: Date;
}

/** Top package/download names over the last `days` (0 = all time). */
export async function topPackageUses(opts: { days: number; limit: number }): Promise<PackageTally[]> {
  const since = opts.days > 0 ? new Date(Date.now() - opts.days * 86_400_000) : new Date(0);
  const rows = await db.$queryRaw<
    { kind: string; name: string; uses: bigint; chats: bigint; last_at: Date }[]
  >`
    SELECT kind, name, COUNT(*) AS uses, COUNT(DISTINCT conversation_id) AS chats, MAX(created_at) AS last_at
    FROM agent_package_uses
    WHERE created_at >= ${since}
    GROUP BY kind, name
    ORDER BY uses DESC, last_at DESC
    LIMIT ${opts.limit}
  `;
  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    uses: Number(r.uses),
    chats: Number(r.chats),
    lastAt: r.last_at,
  }));
}

/** What the image ships — served by sandboxd from /etc/opninfer/packages.json
 *  (generated at build from the installed state). Null when the broker is
 *  unreachable or the image predates the manifest. */
export interface ImagePackages {
  python: string[];
  node: string[];
  apt: string[];
  tools: string[];
}

export async function fetchImagePackages(): Promise<ImagePackages | null> {
  // Through the shared broker client (2026-09-03): this used to read a
  // SANDBOX_URL variable nothing sets and fall back to localhost — right on
  // the dev box, wrong in every production container (the manifest was
  // "unavailable" on the live admin page for that reason alone).
  const body = await brokerGet<Partial<ImagePackages>>("/packages");
  if (!body) return null;
  return {
    python: body.python ?? [],
    node: body.node ?? [],
    apt: body.apt ?? [],
    tools: body.tools ?? [],
  };
}

/** Is a tallied use already satisfied by the image? (Pure; exported for tests.) */
export function inImage(use: { kind: string; name: string }, image: ImagePackages | null): boolean | null {
  if (!image) return null;
  switch (use.kind) {
    case "pip":
      return image.python.includes(use.name.replace(/[-_.]+/g, "-").toLowerCase());
    case "npm":
      return image.node.includes(use.name);
    case "apt":
      return image.apt.includes(use.name);
    default:
      return null; // downloads/clones are not "in" an image
  }
}
