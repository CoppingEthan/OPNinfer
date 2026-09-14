/**
 * A short two-note completion chime (spec §13), synthesised with the Web Audio
 * API so there's no asset to ship. Played when a reply finishes while the user
 * isn't looking at the tab.
 */
export function playCompletionChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [
      { f: 660, t: 0 },
      { f: 880, t: 0.12 },
    ];
    for (const { f, t } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.15, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.24);
    }
    // Close shortly after the sound finishes so we don't leak contexts.
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    /* audio not available — silent no-op */
  }
}

/** True when the user isn't actively viewing this tab/window. */
export function isTabInactive(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}
