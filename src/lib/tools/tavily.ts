import "server-only";
import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";

/**
 * Tavily API client (web search + page extraction). The API key is an
 * admin-managed service secret: stored encrypted (AES-256-GCM, master key)
 * in the `web_tools_config` setting — NOT a provider credential, so it never
 * appears in model-role dropdowns — with a TAVILY_API_KEY env fallback for
 * local dev. Admin UI for it lands on the Tools page (v0.3 step 10).
 */

const BASE = "https://api.tavily.com";
const TIMEOUT_MS = 30_000;

export interface WebToolsConfig {
  /** base64 of encrypt(api key); absent = rely on env fallback. */
  tavilyKeyEncrypted?: string;
}

export async function getTavilyKey(): Promise<string | null> {
  const cfg = await getSetting<WebToolsConfig>("web_tools_config");
  if (cfg?.tavilyKeyEncrypted) {
    try {
      return decrypt(Buffer.from(cfg.tavilyKeyEncrypted, "base64"));
    } catch {
      /* wrong master key — fall through to env */
    }
  }
  return process.env.TAVILY_API_KEY?.trim() || null;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Tavily ${path} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

export interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
}

export interface TavilySearchResponse {
  results?: TavilySearchResult[];
  images?: { url?: string; description?: string }[] | string[];
  answer?: string;
}

export function tavilySearch(
  apiKey: string,
  query: string,
  opts: { maxResults: number; fullContent: boolean; images: boolean },
): Promise<TavilySearchResponse> {
  return post<TavilySearchResponse>("/search", {
    api_key: apiKey,
    query,
    max_results: opts.maxResults,
    search_depth: opts.fullContent ? "advanced" : "basic",
    include_raw_content: opts.fullContent ? "markdown" : false,
    include_images: opts.images,
    include_image_descriptions: opts.images,
    topic: "general",
  });
}

export interface TavilyExtractResponse {
  results?: { url?: string; raw_content?: string }[];
  failed_results?: { url?: string; error?: string }[];
}

export function tavilyExtract(
  apiKey: string,
  urls: string[],
): Promise<TavilyExtractResponse> {
  return post<TavilyExtractResponse>("/extract", {
    api_key: apiKey,
    urls,
    extract_depth: "basic",
  });
}
