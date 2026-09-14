/**
 * LLM-side provenance notes for replayed history.
 *
 * Tool rounds are not persisted, so a replayed conversation shows only the
 * final assistant text. Without a marker the model can conclude it never
 * searched and "disown" its own sourced reply — observed live: it apologized
 * for "inventing" headlines it had in fact web-searched moments earlier.
 * The note is appended to the assistant message content sent to the MODEL
 * only; it is never stored or rendered in the UI.
 */

export interface SourceLike {
  url: string;
  title?: string;
  kind?: "web" | "file";
  fileId?: string;
}

/** Cap the listed URLs so a many-source reply stays a few dozen tokens. */
const MAX_WEB_URLS = 8;
const MAX_FILE_NAMES = 6;

export function provenanceNote(meta: unknown): string | null {
  const sources = (meta as { sources?: SourceLike[] } | null)?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const web = sources.filter((s) => s && (s.kind ?? "web") === "web" && s.url);
  const files = sources.filter((s) => s && s.kind === "file");
  const parts: string[] = [];
  if (web.length > 0) {
    const urls = web.slice(0, MAX_WEB_URLS).map((s) => s.url);
    const more = web.length > MAX_WEB_URLS ? ` (+${web.length - MAX_WEB_URLS} more)` : "";
    parts.push(`live web search — sources: ${urls.join(", ")}${more}`);
  }
  if (files.length > 0) {
    const names = files.slice(0, MAX_FILE_NAMES).map((s) => s.title || "attached file");
    parts.push(`reading attached file(s): ${names.join(", ")}`);
  }
  if (parts.length === 0) return null;

  return (
    `\n\n[provenance note: this reply was produced using ${parts.join("; ")}. ` +
    `The content above was retrieved live when it was written — use the web tools ` +
    `again (search, or scrape a listed URL) if the user needs fresher or deeper detail.]`
  );
}

/** Append the provenance note to a replayed assistant turn's content. */
export function annotateAssistantContent(content: string, meta: unknown): string {
  const note = provenanceNote(meta);
  return note ? content + note : content;
}


/**
 * A turn the user STOPPED before it produced any prose leaves an assistant
 * row with empty content — and empty assistant rows are dropped from replay
 * (providers reject them). To the model, the user's request then appears to
 * have had NO reply at all, so it quietly picks the job back up on the next
 * message. Seen live with the Sandbox: "reply with just the word: ready"
 * after a Stop restarted the stopped 120-second job.
 *
 * This is the replay text for such a row — LLM-side only, never rendered —
 * so the transcript says what actually happened.
 */
export const STOPPED_TURN_NOTE =
  "[The assistant's reply here was stopped by the user before it produced an answer. The request above was NOT completed. Do not resume or retry it unless the user asks again.]";

export function stoppedTurnNote(meta: unknown): string | null {
  return meta && typeof meta === "object" && (meta as { stopped?: unknown }).stopped === true
    ? STOPPED_TURN_NOTE
    : null;
}
