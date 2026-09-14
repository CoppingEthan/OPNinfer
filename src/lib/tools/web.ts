import "server-only";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { db } from "@/lib/db";
import { getMaxUploadBytes } from "@/lib/settings";
import { saveFileToPool, UploadTooLargeError } from "@/lib/storage";
import { formatBytes } from "@/lib/format";
import type { ToolDef } from "@/lib/providers/types";
import type { SourceRef, ToolCtx, ToolOutput } from "./types";
import { getTavilyKey, tavilySearch, tavilyExtract } from "./tavily";
import {
  inferFilename,
  isForbiddenHostname,
  isPrivateIp,
  truncateText,
} from "./web-helpers";

/**
 * Web tools (v0.3 step 2). Search + scrape via Tavily; `download_file` runs
 * APP-side (never in the sandbox) so it works even with sandbox internet off,
 * with an SSRF guard so the model can't be tricked into fetching internal
 * services. Downloads land in the conversation pool as `kind=generated`
 * pending rows — the ingestion worker prepares them like any upload.
 */

const PER_RESULT_CHARS = 4_000;
const SEARCH_TOTAL_CHARS = 15_000;
const PER_PAGE_CHARS = 8_000;
const SCRAPE_TOTAL_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Cap sources per tool call — the UI aggregates across calls. */
const MAX_SOURCES = 20;

/** Build a deduped source list from URL+title pairs (drops empties). */
function toSources(items: { url?: string; title?: string }[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const item of items) {
    const url = (item.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, ...(item.title ? { title: item.title } : {}) });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

export const WEB_SEARCH_DEF: ToolDef = {
  name: "web_search",
  description:
    "Search the web for current information. Returns titles, URLs and content snippets. Set include_full_content for deeper page text on each hit.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      num_results: {
        type: "number",
        description: "How many results (1-10, default 3).",
      },
      include_full_content: {
        type: "boolean",
        description: "Include extended page content per result (slower, more tokens).",
      },
      include_images: {
        type: "boolean",
        description: "Also return relevant image URLs (download_file can fetch them).",
      },
    },
    required: ["query"],
  },
};

export const WEB_SCRAPE_DEF: ToolDef = {
  name: "web_scrape",
  description:
    "Read the full content of specific web pages (up to 5 URLs). Use after web_search when you need a page's actual text.",
  parameters: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Absolute http(s) URLs to read (max 5 per call).",
      },
    },
    required: ["urls"],
  },
};

export const WEB_SEARCH_AND_READ_DEF: ToolDef = {
  name: "web_search_and_read",
  description:
    "Search the web AND read the top result's full page in one step. Prefer this when you'll obviously need the page content, to save a round-trip.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      num_results: { type: "number", description: "How many results to list (1-5, default 3)." },
    },
    required: ["query"],
  },
};

export const DOWNLOAD_FILE_DEF: ToolDef = {
  name: "download_file",
  description:
    "Download a file from a URL into this conversation's files (documents, images, archives, GitHub tarballs — anything). The file is stored, prepared for reading, and becomes available to list_files/read_file and the user.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the file." },
      filename: {
        type: "string",
        description: "Optional name to save as (defaults to the server-provided or URL name).",
      },
    },
    required: ["url"],
  },
};

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

const NOT_CONFIGURED =
  "Error: web tools aren't configured on this server (missing Tavily API key — an admin can add it).";

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function executeWebSearch(args: Record<string, unknown>): Promise<string | ToolOutput> {
  const key = await getTavilyKey();
  if (!key) return NOT_CONFIGURED;
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: query is required.";
  const maxResults = clampInt(args.num_results, 1, 10, 3);

  const data = await tavilySearch(key, query, {
    maxResults,
    fullContent: args.include_full_content === true,
    images: args.include_images === true,
  });

  const results = data.results ?? [];
  if (results.length === 0) return `No results for "${query}".`;

  const sections = results.map((r, i) => {
    const body = r.raw_content
      ? truncateText(r.raw_content, PER_RESULT_CHARS)
      : (r.content ?? "").slice(0, 600);
    return `${i + 1}. ${r.title ?? "Untitled"}\n   URL: ${r.url ?? "?"}\n${body}`;
  });
  let out = `Web search results for "${query}":\n\n${sections.join("\n\n")}`;

  const images = (data.images ?? [])
    .map((img) => (typeof img === "string" ? { url: img } : img))
    .filter((img) => img.url);
  if (images.length > 0) {
    out += `\n\nImages:\n${images
      .map((img) => `- ${img.url}${"description" in img && img.description ? ` — ${img.description}` : ""}`)
      .join("\n")}`;
  }
  return {
    text: truncateText(out, SEARCH_TOTAL_CHARS),
    sources: toSources(results),
  };
}

export async function executeWebScrape(args: Record<string, unknown>): Promise<string | ToolOutput> {
  const key = await getTavilyKey();
  if (!key) return NOT_CONFIGURED;
  const urls = Array.isArray(args.urls)
    ? args.urls.map(String).filter((u) => /^https?:\/\//i.test(u)).slice(0, 5)
    : [];
  if (urls.length === 0) return "Error: provide 1-5 absolute http(s) URLs.";

  const data = await tavilyExtract(key, urls);
  const ok = data.results ?? [];
  const failed = data.failed_results ?? [];

  const sections = ok.map(
    (r) => `## ${r.url}\n\n${truncateText(r.raw_content ?? "(no content extracted)", PER_PAGE_CHARS)}`,
  );
  if (failed.length > 0) {
    sections.push(
      `Failed to read: ${failed.map((f) => `${f.url} (${f.error ?? "error"})`).join(", ")}`,
    );
  }
  return {
    text: truncateText(
      `Read ${ok.length}/${urls.length} page(s):\n\n${sections.join("\n\n")}`,
      SCRAPE_TOTAL_CHARS,
    ),
    sources: toSources(ok),
  };
}

export async function executeWebSearchAndRead(
  args: Record<string, unknown>,
): Promise<string | ToolOutput> {
  const key = await getTavilyKey();
  if (!key) return NOT_CONFIGURED;
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: query is required.";
  const maxResults = clampInt(args.num_results, 1, 5, 3);

  const search = await tavilySearch(key, query, {
    maxResults,
    fullContent: false,
    images: false,
  });
  const results = search.results ?? [];
  if (results.length === 0) return `No results for "${query}".`;

  const list = results
    .map((r, i) => `${i + 1}. ${r.title ?? "Untitled"} — ${r.url ?? "?"}\n   ${(r.content ?? "").slice(0, 300)}`)
    .join("\n");

  const topUrl = results[0]?.url;
  let page = "";
  if (topUrl) {
    try {
      const extract = await tavilyExtract(key, [topUrl]);
      page = extract.results?.[0]?.raw_content ?? "";
    } catch {
      page = "";
    }
  }
  const pageSection = page
    ? `\n\n--- Full content of top result (${topUrl}) ---\n\n${truncateText(page, PER_PAGE_CHARS)}`
    : "\n\n(Could not read the top result's page.)";
  return {
    text: truncateText(`Results for "${query}":\n${list}${pageSection}`, SCRAPE_TOTAL_CHARS),
    sources: toSources(results),
  };
}

/** SSRF-guarded fetch: http(s) only, public addresses only, every redirect
 *  hop re-validated. Returns the final response (body unconsumed). */
async function fetchPublicUrl(rawUrl: string): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new Error(`Invalid URL: ${current}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http(s) URLs are allowed.");
    }
    if (url.username || url.password) {
      throw new Error("URLs with credentials are not allowed.");
    }
    if (isForbiddenHostname(url.hostname)) {
      throw new Error("That address is not reachable from here.");
    }
    // Resolve and reject private/internal addresses (incl. cloud metadata).
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && !url.hostname.includes(":")) {
      const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
      if (addrs.length === 0) throw new Error(`Could not resolve ${url.hostname}.`);
      if (addrs.some((a) => isPrivateIp(a.address))) {
        throw new Error("That address is not reachable from here.");
      }
    } else if (isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new Error("That address is not reachable from here.");
    }

    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "user-agent": "OPNinfer/0.3 (+file download tool)" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect (${res.status}) without a location.`);
      res.body?.cancel().catch(() => {});
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}.`);
    return res;
  }
  throw new Error("Too many redirects.");
}

export async function executeDownloadFile(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string | ToolOutput> {
  const rawUrl = String(args.url ?? "").trim();
  if (!rawUrl) return "Error: url is required.";

  const max = await getMaxUploadBytes();
  let res: Response;
  try {
    res = await fetchPublicUrl(rawUrl);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "download failed."}`;
  }

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) {
    res.body?.cancel().catch(() => {});
    return `Error: file is ${formatBytes(declared)} — over this server's ${formatBytes(max)} limit.`;
  }
  if (!res.body) return "Error: the server sent no content.";

  const requested = typeof args.filename === "string" && args.filename.trim()
    ? args.filename.trim()
    : inferFilename(rawUrl, res.headers.get("content-disposition"));

  let stored;
  try {
    stored = await saveFileToPool(
      ctx.conversationId,
      requested,
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      max,
    );
  } catch (e) {
    if (e instanceof UploadTooLargeError) return `Error: ${e.message}`;
    return `Error: could not save the file: ${e instanceof Error ? e.message : e}`;
  }

  const row = await db.file.create({
    data: {
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      filename: stored.storedName,
      mimeType: res.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream",
      sizeBytes: BigInt(stored.sizeBytes),
      storagePath: stored.storagePath,
      kind: "generated",
      // status defaults to pending — the ingestion worker prepares it.
    },
  });

  return {
    text:
      `Downloaded "${row.filename}" (${formatBytes(stored.sizeBytes)}, ${row.mimeType}) ` +
      `into this conversation's files. It is being prepared for reading — use ` +
      `list_files to see its status, then read_file to read it. The user can ` +
      `download it from the chat.`,
    sources: toSources([{ url: rawUrl, title: row.filename }]),
    // A user-requested download IS the deliverable — hand it over directly.
    presented: [row.filename],
  };
}
