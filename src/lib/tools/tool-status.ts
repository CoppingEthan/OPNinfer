/**
 * Human-readable "what the assistant is doing right now" labels for tool
 * calls, streamed to the chat UI the moment a tool is invoked. Pure module
 * (no imports) so it's unit-testable and can't join an ESM cycle.
 */

function parse(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** e.g. "https://api.github.com/repos/x" → "api.github.com" */
function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return clip(url, 40);
  }
}

/** Friendly present-tense status for a tool invocation ("Searching the web
 *  for "…""). Unknown tools (capabilities) fall back to a humanized name. */
export function toolStatusLabel(name: string, argsJson: string): string {
  const a = parse(argsJson);
  switch (name) {
    case "list_files":
      return "Checking the files in this chat";
    case "read_file":
      return str(a.name) ? `Reading ${str(a.name)}` : "Reading a file";
    case "view_image":
      return str(a.name) ? `Looking at ${str(a.name)}` : "Looking at an image";
    case "web_search":
      return str(a.query) ? `Searching the web: “${clip(str(a.query), 60)}”` : "Searching the web";
    case "web_search_and_read":
      return str(a.query)
        ? `Searching & reading: “${clip(str(a.query), 60)}”`
        : "Searching & reading the web";
    case "web_scrape": {
      const urls = Array.isArray(a.urls) ? a.urls.map(String) : [];
      if (urls.length === 1) return `Reading ${host(urls[0])}`;
      if (urls.length > 1) return `Reading ${urls.length} web pages`;
      return "Reading a web page";
    }
    case "download_file":
      return str(a.url) ? `Downloading from ${host(str(a.url))}` : "Downloading a file";
    case "image_generation":
      return "Generating an image";
    case "image_edit":
      return str(a.image) ? `Editing ${str(a.image)}` : "Editing an image";
    case "image_blend":
      return "Blending images";
    case "memory_view":
      return "Re-reading what I know about you";
    case "memory_update":
      return str(a.text) ? "Updating what I remember about you" : "Forgetting something";
    case "search_my_chats":
      return str(a.query) ? `Searching your past chats: “${clip(str(a.query), 60)}”` : "Searching your past chats";
    case "load_skill":
      return str(a.name) ? `Loading the ${str(a.name)} skill` : "Loading a skill";
    case "sandbox_task":
      // The outer call is a status line; the agent's own steps stream as
      // run blocks and status lines of their own underneath it.
      return str(a.task) ? `Working in the Sandbox: “${clip(str(a.task), 70)}”` : "Working in the Sandbox";
    case "date_time_now":
      return str(a.timezone) ? `Checking the time in ${str(a.timezone)}` : "Checking the date & time";
    case "date_time_diff": {
      // Distinct per-call labels: one turn often checks now AND a span, and
      // four identical "Checking the date & time" lines read as dithering.
      const from = str(a.from);
      const to = str(a.to);
      if (to && (!from || /^(now|today)$/i.test(from))) return `Counting the time until ${clip(to, 30)}`;
      if (from && to) return `Comparing ${clip(from, 24)} → ${clip(to, 24)}`;
      return "Calculating a time difference";
    }
    default:
      // Capability tools and anything future: "invoice_search" → "Invoice search".
      return clip(name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), 60);
  }
}
