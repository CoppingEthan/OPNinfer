import "server-only";
import { fanOut } from "./db";
import { tallyActivity } from "./labels";

/**
 * What the assistants actually DID, across every portal.
 *
 * Tool names are not logged as such by the portals — `app_log` records only
 * how MANY tools a reply used — so this reads the replies themselves. Two
 * different qualities of evidence, kept apart on purpose:
 *
 *   EXACT — the JSON a reply persists for its own re-rendering:
 *     `meta.toolRuns[].tool` (the Sandbox family, by real tool name),
 *     `meta.images`, `meta.sources`, `meta.viz`, `meta.asks`, `meta.fileIds`.
 *     These are counts of things that definitely happened.
 *
 *   INFERRED — the status lines the user saw (`meta.activity`), bucketed by
 *     `labels.ts`. Good for volume and shape; it cannot always name the tool
 *     (a file read and a single-page web scrape both render as "Reading X"),
 *     and it says so rather than guessing.
 *
 * All of it comes from indexed windows over `messages` — never the whole
 * table, which on a migrated portal holds multi-megabyte `meta` columns.
 */

export interface ActivityCount {
  key: string;
  count: number;
}

export interface PortalActivity {
  /** Assistant replies in the window — the denominator for everything else. */
  replies: number;
  /** Replies that used at least one tool. */
  repliesWithTools: number;
  /** Bucketed status lines (inferred). */
  did: ActivityCount[];
  /** Sandbox agent steps, by real tool name (exact). */
  sandboxTools: ActivityCount[];
  /** Countable outcomes a reply leaves behind (exact). */
  produced: {
    images: number;
    webSources: number;
    visualisations: number;
    questionsAsked: number;
    filesPresented: number;
    sandboxRuns: number;
  };
}

export const ACTIVITY_RANGES = {
  week: { label: "7 days", ms: 7 * 86_400_000 },
  month: { label: "30 days", ms: 30 * 86_400_000 },
  quarter: { label: "90 days", ms: 90 * 86_400_000 },
} as const;
export type ActivityRangeKey = keyof typeof ACTIVITY_RANGES;
export function parseActivityRange(v: string | null | undefined): ActivityRangeKey {
  return v && v in ACTIVITY_RANGES ? (v as ActivityRangeKey) : "month";
}

export interface ActivityView {
  range: ActivityRangeKey;
  portals: { portal: string; label: string; activity: PortalActivity }[];
  combined: PortalActivity;
  errors: { portal: string; error: string }[];
}

export async function getActivity(range: ActivityRangeKey): Promise<ActivityView> {
  const since = new Date(Date.now() - ACTIVITY_RANGES[range].ms);

  const results = await fanOut(async (db) => {
    const [replies, labels, tools, produced] = await Promise.all([
      db.$queryRaw<{ total: bigint; withTools: bigint }[]>`
        select count(*)::bigint as total,
               count(*) filter (
                 where jsonb_typeof(meta -> 'activity') = 'array'
                   and jsonb_array_length(meta -> 'activity') > 0
               )::bigint as "withTools"
        from messages
        where role = 'assistant' and created_at >= ${since}
      `,
      db.$queryRaw<{ label: string; n: bigint }[]>`
        select a ->> 'label' as label, count(*)::bigint as n
        from messages m
        cross join lateral jsonb_array_elements(m.meta -> 'activity') a
        where m.role = 'assistant'
          and m.created_at >= ${since}
          and jsonb_typeof(m.meta -> 'activity') = 'array'
          and a ->> 'kind' = 'status'
          and a ->> 'label' is not null
        group by 1
      `,
      db.$queryRaw<{ tool: string; n: bigint }[]>`
        select r ->> 'tool' as tool, count(*)::bigint as n
        from messages m
        cross join lateral jsonb_array_elements(m.meta -> 'toolRuns') r
        where m.role = 'assistant'
          and m.created_at >= ${since}
          and jsonb_typeof(m.meta -> 'toolRuns') = 'array'
          and r ->> 'tool' is not null
        group by 1
      `,
      db.$queryRaw<
        {
          images: bigint;
          sources: bigint;
          viz: bigint;
          asks: bigint;
          files: bigint;
          runs: bigint;
        }[]
      >`
        select
          coalesce(sum(case when jsonb_typeof(meta -> 'images') = 'array'
                            then jsonb_array_length(meta -> 'images') end), 0)::bigint as images,
          coalesce(sum(case when jsonb_typeof(meta -> 'sources') = 'array'
                            then jsonb_array_length(meta -> 'sources') end), 0)::bigint as sources,
          coalesce(sum(case when jsonb_typeof(meta -> 'viz') = 'array'
                            then jsonb_array_length(meta -> 'viz') end), 0)::bigint as viz,
          coalesce(sum(case when jsonb_typeof(meta -> 'asks') = 'array'
                            then jsonb_array_length(meta -> 'asks') end), 0)::bigint as asks,
          coalesce(sum(case when jsonb_typeof(meta -> 'fileIds') = 'array'
                            then jsonb_array_length(meta -> 'fileIds') end), 0)::bigint as files,
          coalesce(sum(case when jsonb_typeof(meta -> 'toolRuns') = 'array'
                            then jsonb_array_length(meta -> 'toolRuns') end), 0)::bigint as runs
        from messages
        where role = 'assistant' and created_at >= ${since}
      `,
    ]);

    const p = produced[0];
    const activity: PortalActivity = {
      replies: Number(replies[0]?.total ?? 0),
      repliesWithTools: Number(replies[0]?.withTools ?? 0),
      // Expand each label back to one entry per occurrence would be wasteful;
      // bucket the DISTINCT labels and carry their counts through instead.
      did: bucketWeighted(labels.map((r) => ({ key: r.label, count: Number(r.n) }))),
      sandboxTools: tools
        .map((r) => ({ key: r.tool, count: Number(r.n) }))
        .sort((a, b) => b.count - a.count),
      produced: {
        images: Number(p?.images ?? 0),
        webSources: Number(p?.sources ?? 0),
        visualisations: Number(p?.viz ?? 0),
        questionsAsked: Number(p?.asks ?? 0),
        filesPresented: Number(p?.files ?? 0),
        sandboxRuns: Number(p?.runs ?? 0),
      },
    };
    return activity;
  });

  const portals = results
    .filter((r) => r.data)
    .map((r) => ({ portal: r.instance.name, label: r.instance.label, activity: r.data! }));

  return {
    range,
    portals,
    combined: combine(portals.map((p) => p.activity)),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}

/** Bucket already-counted labels (`tallyActivity` counts raw occurrences). */
function bucketWeighted(rows: ActivityCount[]): ActivityCount[] {
  const expanded = new Map<string, number>();
  for (const { key, count } of rows) {
    // One representative pass through the classifier per DISTINCT label, then
    // add its real count — the alternative (repeating the string `count`
    // times) would allocate millions of entries on a busy portal.
    const bucket = tallyActivity([key])[0]?.key ?? key;
    expanded.set(bucket, (expanded.get(bucket) ?? 0) + count);
  }
  return [...expanded.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function combine(list: PortalActivity[]): PortalActivity {
  const merge = (rows: ActivityCount[][]): ActivityCount[] => {
    const m = new Map<string, number>();
    for (const set of rows) for (const r of set) m.set(r.key, (m.get(r.key) ?? 0) + r.count);
    return [...m.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  return {
    replies: list.reduce((n, a) => n + a.replies, 0),
    repliesWithTools: list.reduce((n, a) => n + a.repliesWithTools, 0),
    did: merge(list.map((a) => a.did)),
    sandboxTools: merge(list.map((a) => a.sandboxTools)),
    produced: {
      images: list.reduce((n, a) => n + a.produced.images, 0),
      webSources: list.reduce((n, a) => n + a.produced.webSources, 0),
      visualisations: list.reduce((n, a) => n + a.produced.visualisations, 0),
      questionsAsked: list.reduce((n, a) => n + a.produced.questionsAsked, 0),
      filesPresented: list.reduce((n, a) => n + a.produced.filesPresented, 0),
      sandboxRuns: list.reduce((n, a) => n + a.produced.sandboxRuns, 0),
    },
  };
}
