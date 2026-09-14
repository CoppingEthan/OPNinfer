"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Microphone capture for the composer (spec §6). Records audio via
 * MediaRecorder, exposes a live AnalyserNode for the waveform visualiser, and
 * returns the recorded Blob on stop. The blob goes to `/api/stt` (Whisper
 * dictation → text lands in the input box); if the engine is off it falls back
 * to being stored as a normal audio attachment.
 */
export interface AudioRecorder {
  recording: boolean;
  elapsedMs: number;
  analyser: AnalyserNode | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

export function useAudioRecorder(): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTsRef = useRef(0);
  const discardRef = useRef(false);
  const resolveRef = useRef<((b: Blob | null) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setAnalyser(null);
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createAnalyser();
      node.fftSize = 256;
      source.connect(node);
      setAnalyser(node);

      const mr = new MediaRecorder(stream);
      mediaRef.current = mr;
      chunksRef.current = [];
      discardRef.current = false;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = discardRef.current
          ? null
          : new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        cleanup();
        resolveRef.current?.(blob);
        resolveRef.current = null;
      };
      mr.start();

      startTsRef.current = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(
        () => setElapsedMs(Date.now() - startTsRef.current),
        200,
      );
      setRecording(true);
    } catch {
      setError("Microphone access was blocked.");
      cleanup();
    }
  }, [cleanup]);

  const stop = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const mr = mediaRef.current;
      if (!mr || mr.state === "inactive") {
        resolve(null);
        return;
      }
      resolveRef.current = resolve;
      discardRef.current = false;
      mr.stop();
    });
  }, []);

  const cancel = useCallback(() => {
    const mr = mediaRef.current;
    if (!mr || mr.state === "inactive") {
      cleanup();
      return;
    }
    discardRef.current = true;
    mr.stop();
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { recording, elapsedMs, analyser, error, start, stop, cancel };
}

/** Live bar visualiser driven by the recorder's AnalyserNode. */
export function RecordingWave({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
      "#5b7aa6";

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      analyser.getByteFrequencyData(data);

      // The first frame(s) can run before layout settles (clientWidth 0) —
      // a fixed 42-bar layout then computes a NEGATIVE bar width and
      // roundRect throws on the negative radius (seen live). Skip until the
      // canvas has real size, and scale the bar count to the width so
      // narrow composers stay positive too.
      if (w < 12 || h < 2) return;
      const gap = 2;
      const bars = Math.max(4, Math.min(42, Math.floor(w / 8)));
      const barW = (w - gap * (bars - 1)) / bars;
      const step = Math.floor(data.length / bars);
      ctx.fillStyle = accent;
      for (let i = 0; i < bars; i++) {
        const v = data[i * step] / 255;
        const barH = Math.max(2, v * h);
        const x = i * (barW + gap);
        const y = (h - barH) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, barW / 2);
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} className="h-8 w-full" aria-hidden="true" />;
}

/** mm:ss for the recording timer. */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
