import { auth } from "@/auth";
import { appLog } from "@/lib/applog";

export const dynamic = "force-dynamic";

/**
 * Refuse an oversized upload from its Content-Length, BEFORE the body is read.
 *
 * `req.formData()` materialises the whole request first, so a size check after
 * it has already paid the cost: the effective ceiling was the middleware body
 * cap (hundreds of MB), not the few MB the code believed it was enforcing, and
 * this app is a single process holding every in-flight reply in memory — so a
 * handful of parallel junk uploads could take out everyone's stream, not just
 * the sender's. A missing or lying header still gets caught by the real check
 * afterwards; this is the cheap door.
 */
function declaredTooLarge(req: Request, maxBytes: number): boolean {
  const len = Number(req.headers.get("content-length") ?? "");
  return Number.isFinite(len) && len > maxBytes;
}

/**
 * POST /api/stt — dictation: transcribe a short composer recording via the
 * Whisper engine (faster-whisper container, compose profile `heavy`) and
 * return the text for the input box. Distinct from the ingestion pipeline
 * (which transcribes *stored* audio files asynchronously) — this is the live
 * mic → text path, so it's synchronous and size-capped.
 *
 * 503 when the engine isn't configured/running — the client falls back to
 * attaching the recording as a stored audio file (the pre-STT behaviour).
 */

// Dictation clips are short; 25 MB ≈ half an hour of Opus. Anything bigger
// belongs in the async ingestion path.
const MAX_STT_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const whisperUrl = (process.env.WHISPER_URL ?? "").replace(/\/$/, "");
  if (!whisperUrl) {
    return Response.json(
      { error: "Speech-to-text isn't enabled on this server." },
      { status: 503 },
    );
  }

  if (declaredTooLarge(req, MAX_STT_BYTES)) {
    return Response.json(
      { error: "Recording too long for dictation — attach it as a file instead." },
      { status: 413 },
    );
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) {
    return Response.json({ error: "No audio provided." }, { status: 400 });
  }
  if (file.size > MAX_STT_BYTES) {
    return Response.json(
      { error: "Recording too long for dictation — attach it as a file instead." },
      { status: 413 },
    );
  }

  try {
    const upstream = new FormData();
    upstream.append("audio_file", file, file.name || "dictation.webm");
    const res = await fetch(
      `${whisperUrl}/asr?task=transcribe&output=json&encode=true`,
      { method: "POST", body: upstream, signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      await appLog("error", "stt", "Whisper rejected a dictation request.", {
        userId: session.user.id,
        details: { status: res.status, detail },
      });
      return Response.json(
        { error: "Transcription failed — try again or attach the recording." },
        { status: 502 },
      );
    }
    const payload = (await res.json()) as { text?: string; language?: string };
    const text = (payload.text ?? "").trim();
    return Response.json({ text, language: payload.language ?? null });
  } catch (e) {
    await appLog("warn", "stt", "Whisper unreachable for dictation.", {
      userId: session.user.id,
      details: { error: e instanceof Error ? e.message : String(e) },
    });
    return Response.json(
      { error: "The transcription engine isn't reachable right now." },
      { status: 503 },
    );
  }
}
