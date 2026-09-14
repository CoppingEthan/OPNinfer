/**
 * Reply text-to-speech (the hover "Listen" button) — Kokoro-FastAPI engine.
 *
 * The engine is an OpenAI-compatible `/v1/audio/speech` server (heavy compose
 * profile, like Whisper). `TTS_URL` unset/unreachable degrades to a clean 503
 * — the UI simply hides/disables the button. Synthesis STREAMS: the route
 * pipes chunked MP3 straight through, so playback starts while the rest of
 * the audio is still being generated (~2x realtime on CPU, ~35x on GPU).
 *
 * `speakableText` turns a markdown reply into something worth listening to:
 * code fences are announced rather than read character-by-character, link
 * targets and URLs are dropped, markup punctuation is stripped.
 */

export function ttsUrl(): string | null {
  const url = process.env.TTS_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

export function ttsVoice(): string {
  return process.env.TTS_VOICE?.trim() || "af_heart";
}

/** Character cap sent to the engine (~8k chars ≈ 9–10 min of speech). Long
 *  replies are cut at a sentence boundary near the cap. */
export const MAX_TTS_CHARS = 8_000;

/** Reduce a markdown reply to plain, speakable text. Pure — unit-tested. */
export function speakableText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: announce, never read (```lang\n...\n``` incl. unclosed).
  text = text.replace(/```[\s\S]*?(?:```|$)/g, " Code block omitted. ");

  // Images become their alt text; links keep only their label.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Bare URLs/autolinks are unreadable aloud.
  text = text.replace(/<https?:\/\/[^>\s]+>/g, " link ");
  text = text.replace(/https?:\/\/\S+/g, " link ");

  // Inline code keeps its content, drops the backticks.
  text = text.replace(/`([^`]*)`/g, "$1");

  // Tables: drop separator rows entirely; read cell text with soft pauses.
  text = text
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ")
        : line,
    )
    .join("\n");

  // Headings, blockquotes, list markers, horizontal rules.
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>+\s?/gm, "");
  text = text.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, "");
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");

  // Emphasis/strikethrough markers. Underscores only at word edges so
  // identifiers like memory_create survive.
  text = text.replace(/(\*\*|\*|~~)/g, "");
  text = text.replace(/(^|[\s(])_+/g, "$1").replace(/_+([\s).,!?:;]|$)/g, "$1");

  // Collapse whitespace into sentences.
  text = text.replace(/\s*\n+\s*/g, ". ").replace(/\.\s*\.\s*/g, ". ");
  text = text.replace(/\s{2,}/g, " ").trim();

  if (text.length > MAX_TTS_CHARS) {
    const slice = text.slice(0, MAX_TTS_CHARS);
    const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
    text = lastStop > MAX_TTS_CHARS / 2 ? slice.slice(0, lastStop + 1) : slice;
  }
  return text;
}

/** First segment stays tiny so the first audio lands after ~2s of CPU
 *  synthesis; later segments ramp up geometrically for efficiency. The ramp is
 *  sized so cumulative synthesis stays AHEAD of cumulative playback even at
 *  exactly 2x-realtime CPU (each segment finishes before the previous ones
 *  run out of audio), so playback never stalls mid-reply. */
export const FIRST_SEGMENT_CHARS = 80;
export const SEGMENT_CHARS = 600;

/** Per-segment char budget: 80, 140, 280, 560, then capped at 600. */
export function segmentLimit(index: number): number {
  if (index === 0) return FIRST_SEGMENT_CHARS;
  return Math.min(SEGMENT_CHARS, 140 * 2 ** (index - 1));
}

/**
 * Drop a leading ID3v2 tag from an MP3 buffer. Kokoro prefixes every response
 * with one; concatenated segments must carry it only ONCE or decoders hit
 * "Header missing" at each seam (they resync, but the join isn't clean).
 * Size field is synchsafe (7 bits per byte). Pure — tested.
 */
export function stripLeadingId3(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return bytes;
  }
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const offset = 10 + size;
  return offset < bytes.length ? bytes.subarray(offset) : bytes;
}

/**
 * Split speakable text into synthesis segments at sentence boundaries. The
 * route synthesises these SERIALLY and flushes each finished MP3 segment
 * immediately — playback starts after segment one while the rest is still
 * generating, and complete per-segment responses defeat any intermediary
 * buffering (Docker Desktop's port relay coalesces ~256 KB of a single
 * streamed response in dev; proxies can do the same in prod). Pure — tested.
 */
export function splitSpeech(text: string): string[] {
  // Sentence-ish units: up to a terminator run (or end of text).
  const units = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  const segments: string[] = [];
  let current = "";
  for (const unit of units) {
    const limit = segmentLimit(segments.length);
    if (current && current.length + unit.length > limit) {
      segments.push(current.trim());
      current = unit;
    } else {
      current += unit;
    }
    // A single unit longer than the limit ships as its own oversized segment
    // (never split mid-sentence — the voice would glitch).
    if (!current.trim()) current = "";
  }
  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}
