import { auth } from "@/auth";
import { db } from "@/lib/db";
import { messageWhereFor } from "@/lib/chat-access";
import { appLog } from "@/lib/applog";
import { devLog } from "@/lib/dev-log";
import { speakableText, splitSpeech, stripLeadingId3, ttsUrl, ttsVoice } from "@/lib/tts";

export const dynamic = "force-dynamic";
// Streamed audio must never be buffered or cached.
export const fetchCache = "force-no-store";

/**
 * GET /api/tts?messageId=… — read an assistant reply aloud (the hover Listen
 * button). Looks up the message (owner-scoped), reduces the markdown to
 * speakable text, and PIPES the Kokoro engine's chunked MP3 straight through —
 * playback starts on the first chunks (~0.3s TTFB) while the rest of the audio
 * is still being synthesised (~2.7x realtime on CPU, far faster on GPU).
 *
 * GET (not POST) so a plain <audio>/Audio element can be pointed at it — the
 * session cookie rides along and the browser handles progressive playback.
 * 503 when the engine isn't configured/running (heavy profile off) — the UI
 * hides the button via the server-passed flag, so users never see a dead one.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const engine = ttsUrl();
  if (!engine) {
    return Response.json(
      { error: "Text-to-speech isn't enabled on this server." },
      { status: 503 },
    );
  }

  const messageId = new URL(req.url).searchParams.get("messageId") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
    return Response.json({ error: "messageId required." }, { status: 400 });
  }

  // Access rides the conversation join — a chat you own or are a member of.
  const message = await db.message.findFirst({
    where: {
      id: messageId,
      role: "assistant",
      ...messageWhereFor(session.user.id),
    },
    select: { content: true },
  });
  if (!message) {
    return Response.json({ error: "Message not found." }, { status: 404 });
  }

  const text = speakableText(message.content);
  if (!text) {
    return Response.json({ error: "Nothing to read aloud." }, { status: 422 });
  }

  // Segmented synthesis: sentences are packed into a SMALL first segment then
  // larger ones, each synthesised as its own complete engine request and
  // flushed to the client the moment it finishes. Playback starts after
  // segment one (~1–2s of CPU synthesis) while later segments generate in the
  // background — and because every flush is a complete response body upstream,
  // no intermediary (Docker Desktop's dev port relay, reverse proxies) can sit
  // on the stream the way it can with one long chunked response. Same-encoder
  // MP3 segments concatenate into a single playable stream.
  const segments = splitSpeech(text);
  const voice = ttsVoice();
  const userId = session.user.id;

  const synthesize = async (input: string, signal: AbortSignal): Promise<Uint8Array> => {
    const res = await fetch(`${engine}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", voice, input, response_format: "mp3" }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`engine ${res.status}: ${detail}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  // Synthesise segment 1 BEFORE responding: a failure here still becomes an
  // honest JSON error (502/503) instead of an empty audio stream.
  let firstChunk: Uint8Array;
  try {
    firstChunk = await synthesize(segments[0], req.signal);
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 204 });
    const message = e instanceof Error ? e.message : String(e);
    await appLog(
      message.startsWith("engine") ? "error" : "warn",
      "tts",
      "TTS synthesis failed.",
      { userId, details: { error: message } },
    );
    return Response.json(
      { error: "The speech engine isn't reachable right now." },
      { status: message.startsWith("engine") ? 502 : 503 },
    );
  }

  devLog("debug", "tts", "streaming reply audio", {
    userId,
    messageId,
    chars: text.length,
    segments: segments.length,
    voice,
  });

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(firstChunk);
      try {
        for (let i = 1; i < segments.length; i++) {
          if (cancelled || req.signal.aborted) break;
          // Only the first segment keeps its ID3 header — clean frame joins.
          controller.enqueue(stripLeadingId3(await synthesize(segments[i], req.signal)));
        }
      } catch (e) {
        // Mid-stream failure: end playback at the last good segment. The
        // client hears a truncated reply rather than an error blip.
        if (!cancelled && !req.signal.aborted) {
          devLog("warn", "tts", "segment synthesis failed mid-stream", {
            userId,
            messageId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      try {
        controller.close();
      } catch {
        /* already closed by cancel */
      }
    },
    cancel() {
      cancelled = true; // listener stopped — the per-segment fetches also see req.signal
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      // Belt-and-braces for reverse proxies: never buffer the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
