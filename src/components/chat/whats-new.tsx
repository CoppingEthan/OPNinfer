"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getReleaseHistory,
  getWhatsNew,
  markWhatsNewSeen,
} from "@/app/actions/changelog";
import type { Release } from "@/lib/changelog";

/**
 * The What's new panel: release notes, shown once per person after an update.
 *
 * Mounted ONCE in the chat shell, so it survives navigation between chats and
 * can't pop twice. It asks the server what this user hasn't seen (the rules
 * live in src/lib/changelog.ts, unit-tested), and the account menu reopens it
 * by firing a window event — that way the menu carries none of this logic and
 * doesn't have to be threaded any state.
 */

/** Fired on `window` to reopen the panel (account menu → What's new). */
export const WHATS_NEW_EVENT = "opninfer:whats-new";

export function WhatsNew() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  /** True when the panel opened itself, i.e. there is something unseen. */
  const autoRef = useRef(false);

  useEffect(() => setMounted(true), []);

  // Auto-pop: only when the server says there's an unseen release.
  useEffect(() => {
    let cancelled = false;
    getWhatsNew()
      .then((data) => {
        if (cancelled || data.releases.length === 0) return;
        autoRef.current = true;
        setReleases(data.releases);
        setOpen(true);
      })
      .catch(() => {
        /* never let release notes break the chat */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Deliberate reopen from the account menu — that's a request for the
  // history, so show everything rather than only what's unseen.
  useEffect(() => {
    const onOpen = () => {
      autoRef.current = false;
      setOpen(true);
      setLoading(true);
      getReleaseHistory()
        .then((data) => setReleases(data.releases))
        .catch(() => setReleases([]))
        .finally(() => setLoading(false));
    };
    window.addEventListener(WHATS_NEW_EVENT, onOpen);
    return () => window.removeEventListener(WHATS_NEW_EVENT, onOpen);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Marked seen on DISMISSAL, not on display: closing the tab without
    // reading the notes means you get them again next time.
    if (autoRef.current) {
      autoRef.current = false;
      void markWhatsNewSeen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[8vh] backdrop-blur-sm"
      onMouseDown={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="text-accent">
              <SparkIcon />
            </span>
            <h2 className="text-sm font-semibold text-foreground">What&rsquo;s new</h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="oi-scroll min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {loading && releases.length === 0 ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : releases.length === 0 ? (
            <p className="text-sm text-muted">No release notes yet.</p>
          ) : (
            releases.map((release) => (
              <section key={release.version}>
                <div className="mb-2.5 flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Version {release.version}
                  </h3>
                  {release.date ? (
                    <span className="text-xs text-muted">{release.date}</span>
                  ) : null}
                </div>
                <ul className="space-y-2">
                  {release.items.map((item, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground">
                      <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
                        <Inline text={item} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The only markdown a note needs: **bold** leads and `code`. Rendered here
 * rather than pulling the full markdown renderer in — the notes are ours, the
 * shapes are known, and this can't produce surprising layout inside a dialog.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="rounded bg-surface-hover px-1 py-0.5 text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z" />
      <path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
    </svg>
  );
}
