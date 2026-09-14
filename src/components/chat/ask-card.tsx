"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskQuestion } from "@/lib/ask";

/**
 * The question card (`ask_user`): the assistant's reply is paused behind this,
 * so it sits directly above the composer where it can't be scrolled away from,
 * and the composer underneath stays live for "Or reply directly…".
 *
 * One card walks through every question in the call (1 of N) and submits the
 * whole set at the end — the reply resumes once, not once per question.
 */

export interface PendingAsk {
  id: string;
  questions: AskQuestion[];
}

/** One question's answer as the card collects it, before normalisation. */
export interface DraftAnswer {
  chosen?: string[];
  skipped?: boolean;
}

interface AskCardProps {
  ask: PendingAsk;
  /** Submit every answer, in question order. */
  onSubmit: (answers: DraftAnswer[]) => void;
  /** Dismiss the whole card (the assistant proceeds with a default). */
  onDismiss: () => void;
  /** Submission is in flight or the card has gone stale. */
  busy?: boolean;
  /** Report the card's position + draft upward. The composer needs it: typing
   *  a direct reply answers whichever question is currently showing, and only
   *  the card knows which that is. */
  onProgress?: (state: { index: number; answers: DraftAnswer[] }) => void;
}

export function AskCard({
  ask,
  onSubmit,
  onDismiss,
  busy = false,
  onProgress,
}: AskCardProps) {
  const total = ask.questions.length;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<DraftAnswer[]>(() =>
    ask.questions.map(() => ({})),
  );
  /** Which question has its free-text box open, and what's in it. */
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const customRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // A fresh card (new ask id) resets everything — questions are positional.
  useEffect(() => {
    setIndex(0);
    setAnswers(ask.questions.map(() => ({})));
    setCustomOpen(false);
    setCustom("");
  }, [ask.id, ask.questions]);

  useEffect(() => {
    if (customOpen) customRef.current?.focus();
  }, [customOpen]);

  // Keep the parent's view of the draft current (read-only for it — this only
  // ever writes into a ref up there, so it can't feed back into a re-render).
  useEffect(() => {
    onProgress?.({ index, answers });
  }, [index, answers, onProgress]);

  const question = ask.questions[index];
  const multi = question?.multiSelect === true;
  const current = answers[index] ?? {};
  const picked = useMemo(() => new Set(current.chosen ?? []), [current.chosen]);

  const commit = useCallback(
    (next: DraftAnswer[]) => {
      setAnswers(next);
      // Last question → submit the set. Otherwise advance.
      if (index + 1 >= total) onSubmit(next);
      else {
        setIndex(index + 1);
        setCustomOpen(false);
        setCustom("");
      }
    },
    [index, total, onSubmit],
  );

  const choose = useCallback(
    (label: string) => {
      if (busy) return;
      const next = [...answers];
      if (multi) {
        // Multi-select just toggles; the user advances with Continue.
        const set = new Set(next[index]?.chosen ?? []);
        if (set.has(label)) set.delete(label);
        else set.add(label);
        next[index] = { chosen: [...set] };
        setAnswers(next);
        return;
      }
      next[index] = { chosen: [label] };
      commit(next);
    },
    [answers, busy, index, multi, commit],
  );

  const submitCustom = useCallback(() => {
    const text = custom.trim();
    if (!text || busy) return;
    const next = [...answers];
    next[index] = { chosen: [text] };
    commit(next);
  }, [answers, busy, custom, index, commit]);

  const skip = useCallback(() => {
    if (busy) return;
    const next = [...answers];
    next[index] = { skipped: true };
    commit(next);
  }, [answers, busy, index, commit]);

  const continueMulti = useCallback(() => {
    if (busy) return;
    const next = [...answers];
    if (!next[index]?.chosen?.length) next[index] = { skipped: true };
    commit(next);
  }, [answers, busy, index, commit]);

  // Number keys pick an option, Escape dismisses — the card owns these only
  // while it's up, and never while the free-text box has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !question) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Not while a dialog is open on top. The card listens on `window`, so
      // pressing Escape to close Settings or the What's new panel used to
      // dismiss the question behind it as well — silently skipping every
      // remaining question and letting the assistant carry on with defaults.
      // A digit typed into a modal did the same to whichever option it matched.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
        e.preventDefault();
        choose(question.options[n - 1].label);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, choose, onDismiss, question]);

  if (!question) return null;

  return (
    <div
      ref={cardRef}
      data-ask-card={ask.id}
      role="group"
      aria-label="The assistant is asking a question"
      className="mb-2 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
    >
      <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3">
        <p className="min-w-0 flex-1 text-sm font-medium text-fg" data-ask-question>
          {question.question}
        </p>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          {total > 1 && (
            <>
              <button
                type="button"
                onClick={() => setIndex(Math.max(0, index - 1))}
                disabled={index === 0 || busy}
                aria-label="Previous question"
                className="rounded p-0.5 transition-colors hover:text-fg disabled:opacity-30 disabled:hover:text-muted"
              >
                <ChevronIcon dir="left" />
              </button>
              <span className="tabular-nums" data-ask-progress>
                {index + 1} of {total}
              </span>
              <button
                type="button"
                onClick={() => setIndex(Math.min(total - 1, index + 1))}
                disabled={index + 1 >= total || busy}
                aria-label="Next question"
                className="rounded p-0.5 transition-colors hover:text-fg disabled:opacity-30 disabled:hover:text-muted"
              >
                <ChevronIcon dir="right" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            aria-label="Dismiss the question"
            title="Dismiss — the assistant will pick a sensible default"
            className="ml-0.5 rounded p-0.5 transition-colors hover:text-fg disabled:opacity-30"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <ul className="divide-y divide-border/60">
        {question.options.map((option, i) => {
          const active = picked.has(option.label);
          return (
            <li key={option.label}>
              <button
                type="button"
                onClick={() => choose(option.label)}
                disabled={busy}
                aria-pressed={multi ? active : undefined}
                data-ask-option={option.label}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-50"
              >
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded text-[11px] tabular-nums transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "bg-surface-hover text-muted group-hover:text-fg"
                  }`}
                >
                  {active && multi ? <TickIcon /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-snug text-muted">
                      {option.description}
                    </span>
                  )}
                </span>
                {!multi && (
                  <span className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100">
                    <ArrowIcon />
                  </span>
                )}
              </button>
            </li>
          );
        })}

        <li className="flex items-center gap-3 px-4 py-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center text-muted">
            <PencilIcon />
          </span>
          {customOpen ? (
            <input
              ref={customRef}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCustom();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCustomOpen(false);
                  setCustom("");
                }
              }}
              placeholder="Type your own answer…"
              maxLength={2000}
              data-ask-custom
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              disabled={busy}
              data-ask-something-else
              className="min-w-0 flex-1 text-left text-sm text-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              Something else
            </button>
          )}
          {multi ? (
            <button
              type="button"
              onClick={continueMulti}
              disabled={busy}
              data-ask-continue
              className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {index + 1 >= total ? "Done" : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              onClick={customOpen ? submitCustom : skip}
              disabled={busy || (customOpen && custom.trim().length === 0)}
              data-ask-skip
              className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
            >
              {customOpen ? "Send" : "Skip"}
            </button>
          )}
        </li>
      </ul>
    </div>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path
        d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3 w-3">
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
