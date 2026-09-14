"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useConversations } from "./conversations-store";

interface Hit {
  id: string;
  title: string;
  updatedAt: string;
  /** Snippet of the first matching message (absent for title-only matches). */
  snippet?: string;
}

/** DD/MM/YYYY — client-only (the modal never renders during SSR). */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Wrap case-insensitive matches of `q` in a subtle highlight. */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={key++} className="rounded bg-accent/25 text-foreground">
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    i = idx + needle.length;
  }
  return out;
}

/**
 * Command-palette search. Blurs the whole UI behind a centered modal listing
 * actions + chats. With ≥2 characters it searches the server across both
 * conversation titles AND message bodies (debounced); otherwise it shows recent
 * chats from the client store. Opened from the sidebar's "Search" row or ⌘K /
 * Ctrl+K. Rendered through a portal so it escapes the sidebar's box.
 */
export function SearchModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { conversations } = useConversations();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  // Reset + focus on open; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setResults([]);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const q = query.trim();
  const searching = q.length >= 2;

  // Debounced full-text search across titles + message contents.
  useEffect(() => {
    if (!searching) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = res.ok ? await res.json() : { results: [] };
        if (!cancelled) setResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, searching]);

  const items: Hit[] = useMemo(
    () =>
      searching
        ? results
        : conversations.map((c) => ({
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
          })),
    [searching, results, conversations],
  );

  // Navigable rows: index 0 = "new chat" action, then one per item.
  const total = items.length + 1;
  useEffect(() => {
    setActive((a) => (a >= total ? total - 1 : a));
  }, [total]);

  const go = useCallback(
    (idx: number) => {
      onClose();
      if (idx <= 0) {
        router.push("/chat");
        return;
      }
      const hit = items[idx - 1];
      if (hit) router.push(`/chat/${hit.id}`);
    },
    [items, router, onClose],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, total - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(active);
    }
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search chats"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <span className="shrink-0 text-muted">
            {loading ? <SpinnerIcon /> : <SearchIcon />}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search chats and messages…"
            aria-label="Search chats and messages"
            className="w-full bg-transparent py-3.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus-visible:outline-none"
          />
          <kbd className="hidden shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted sm:inline-block">
            Esc
          </kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-2">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            Actions
          </p>
          <Row
            active={active === 0}
            onMouseEnter={() => setActive(0)}
            onClick={() => go(0)}
            icon={<ComposeIcon />}
            title="Start a new conversation"
          />

          {searching ? (
            results.length > 0 ? (
              <>
                <p className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">
                  Results
                </p>
                {results.map((hit, i) => (
                  <Row
                    key={hit.id}
                    active={active === i + 1}
                    onMouseEnter={() => setActive(i + 1)}
                    onClick={() => go(i + 1)}
                    title={highlight(hit.title, q)}
                    meta={fmtDate(hit.updatedAt)}
                    snippet={hit.snippet ? highlight(hit.snippet, q) : undefined}
                  />
                ))}
              </>
            ) : (
              <p className="px-3 py-10 text-center text-sm text-muted">
                {loading ? "Searching…" : `No chats or messages match “${q}”.`}
              </p>
            )
          ) : conversations.length > 0 ? (
            <>
              <p className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">
                Recent chats
              </p>
              {items.map((hit, i) => (
                <Row
                  key={hit.id}
                  active={active === i + 1}
                  onMouseEnter={() => setActive(i + 1)}
                  onClick={() => go(i + 1)}
                  title={hit.title}
                  meta={fmtDate(hit.updatedAt)}
                />
              ))}
            </>
          ) : (
            <p className="px-3 py-10 text-center text-sm text-muted">
              No conversations yet.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({
  active,
  onClick,
  onMouseEnter,
  icon,
  title,
  meta,
  snippet,
}: {
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  icon?: ReactNode;
  title: ReactNode;
  meta?: string;
  snippet?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
        active ? "bg-surface-hover text-foreground" : "text-foreground"
      }`}
    >
      {icon ? <span className="shrink-0 self-start pt-0.5 text-muted">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        {snippet ? (
          <span className="truncate text-xs text-muted">{snippet}</span>
        ) : null}
      </span>
      {meta ? (
        <span className="shrink-0 self-start pt-0.5 text-xs text-muted">{meta}</span>
      ) : null}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  );
}
function SpinnerIcon() {
  return (
    <span className="block h-[18px] w-[18px] animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />
  );
}
function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931ZM18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </svg>
  );
}
