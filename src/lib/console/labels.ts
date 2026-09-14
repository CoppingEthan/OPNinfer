/**
 * Turning a reply's stored activity labels into something you can count.
 *
 * WHY THIS IS NOT JUST A GROUP BY. Tool NAMES are not persisted anywhere
 * queryable: a reply keeps `meta.activity` — the human status lines the user
 * saw ("Searching the web: “hay fever”", "Reading report.csv") — and, for the
 * Sandbox family only, `meta.toolRuns[].tool`. So the console reports two
 * different things and says which is which:
 *
 *   - exact tool names, from `toolRuns` and from the JSON markers a reply
 *     leaves behind (`meta.images`, `meta.sources`, `meta.viz`, `meta.asks`);
 *   - and these labels, normalised, as "what the assistant did".
 *
 * Normalising means stripping the part that varies — the query, the filename,
 * the host — so a thousand distinct lines collapse into the dozen kinds of
 * work they represent. It deliberately does NOT claim to recover the tool
 * name, because it can't always: `web_scrape` on a single URL produces
 * "Reading api.github.com" and `read_file` produces "Reading report.csv", and
 * nothing in the string tells them apart. Those share one bucket, honestly
 * named, rather than being guessed into two.
 *
 * Pure (string in, string out) — see `labels.test.ts`. The label templates it
 * mirrors live in `src/lib/tools/tool-status.ts`; if one changes there, the
 * unknown bucket grows rather than anything breaking.
 */

/** Fixed labels that already say exactly one thing. */
const EXACT: Record<string, string> = {
  "Checking the files in this chat": "Listed the chat's files",
  "Searching the web": "Searched the web",
  "Searching & reading the web": "Searched & read the web",
  "Reading a web page": "Read a web page",
  "Downloading a file": "Downloaded a file",
  "Generating an image": "Generated an image",
  "Editing an image": "Edited an image",
  "Blending images": "Blended images",
  "Re-reading what I know about you": "Re-read its memory",
  "Updating what I remember about you": "Updated its memory",
  "Forgetting something": "Updated its memory",
  "Searching your past chats": "Searched past chats",
  "Loading a skill": "Loaded a skill",
  "Working in the Sandbox": "Worked in the Sandbox",
  "Checking the date & time": "Checked the date & time",
  "Calculating a time difference": "Checked the date & time",
  "Reading a file": "Read a file or web page",
  "Looking at an image": "Looked at an image",
};

/** Prefix → bucket, longest prefix first (checked in order). */
const PREFIXES: [string, string][] = [
  ["Searching & reading:", "Searched & read the web"],
  ["Searching the web:", "Searched the web"],
  ["Searching your past chats:", "Searched past chats"],
  ["Working in the Sandbox:", "Worked in the Sandbox"],
  ["Downloading from ", "Downloaded a file"],
  ["Checking the time in ", "Checked the date & time"],
  ["Counting the time until ", "Checked the date & time"],
  ["Comparing ", "Checked the date & time"],
  ["Loading the ", "Loaded a skill"],
  ["Looking at ", "Looked at an image"],
  ["Editing ", "Edited an image"],
  ["Updating what I remember", "Updated its memory"],
  // Both `read_file` and a single-URL `web_scrape` render as "Reading X", and
  // a filename and a hostname are not distinguishable — one honest bucket.
  ["Reading ", "Read a file or web page"],
];

/** What the Sandbox agent's own commentary is filed under. */
export const NARRATION = "Narrated its progress (Sandbox)";

/**
 * Is this the agent talking, rather than a tool label?
 *
 * The Sandbox agent's narration goes into the SAME activity log as tool
 * status lines, with no structural difference (`bridge.ts` turns each text
 * block into `{kind:"status", label}`) — so on a busy portal the table filled
 * with one-off sentences like "All four rendered cleanly — now let me check
 * each for clipping." and the actual tools were pushed off the bottom.
 *
 * They are told apart by SHAPE, which is reliable because every label this
 * app generates is a short imperative phrase: none reaches 60 characters,
 * none runs to eight words, none contains a sentence break, and — the rule
 * that catches the short ones like "Now let's render all four to PNG." —
 * none ends in a full stop. Anything that does is prose, and prose here
 * means the agent.
 */
function looksLikeNarration(s: string): boolean {
  if (/[.!?]["'’”)\]]?$/.test(s)) return true; // a finished sentence
  if (/[.!?]\s/.test(s)) return true; // more than one sentence
  if (s.length > 60) return true; // longer than any label we emit
  return s.split(/\s+/).length >= 8; // a sentence, not a label
}

/**
 * The kind of work a stored status label represents.
 *
 * Anything unrecognised but label-SHAPED keeps its own text: an unfamiliar
 * short line is usually a capability tool — `invoice_search` renders as
 * "Invoice search" — and those are worth seeing by name.
 */
export function activityBucket(label: string): string {
  const s = label.trim();
  if (!s) return "Something else";
  const exact = EXACT[s];
  if (exact) return exact;
  for (const [prefix, bucket] of PREFIXES) {
    if (s.startsWith(prefix)) {
      // "Reading 3 web pages" is web_scrape, not a file — the only case where
      // the tail settles an otherwise-shared prefix.
      if (prefix === "Reading " && /^Reading \d+ web pages$/.test(s)) return "Read a web page";
      return bucket;
    }
  }
  if (looksLikeNarration(s)) return NARRATION;
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

/** Count labels into buckets, commonest first. */
export function tallyActivity(labels: string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of labels) {
    const k = activityBucket(l);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
