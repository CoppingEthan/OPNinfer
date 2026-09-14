"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getChatPeople, leaveChat, searchPeople, shareChat, unshareChat } from "@/app/actions/sharing";
import type { ChatPeople } from "@/lib/sharing";
import { displayName } from "@/lib/chat-rules";
import { Avatar } from "./avatar";
import { useConversations } from "./conversations-store";
import { useLiveEvents } from "./live-provider";

/**
 * The People panel (v0.5 shared chats): who is in the chat, who is online,
 * add a colleague (owner), remove one (owner), or leave (member). Opened
 * from the top bar's People button and from a chat's kebab menu.
 *
 * Adding is DIRECT — no invitation to accept (owner decision 1): the chat
 * appears in the colleague's sidebar the moment they are added.
 */
export function PeoplePanel({
  conversationId,
  me,
  onClose,
}: {
  conversationId: string;
  me: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { remove } = useConversations();
  const [people, setPeople] = useState<ChatPeople | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string | null; email: string; image: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const p = await getChatPeople(conversationId);
    setPeople(p);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: someone added/removed, or came online/went away.
  useLiveEvents((ev) => {
    if (ev.conversationId !== conversationId) return;
    if (ev.type === "people") {
      setPeople({
        conversationId,
        ownerId: ev.ownerId as string,
        shared: ev.shared as boolean,
        people: ev.people as ChatPeople["people"],
        online: ev.online as string[],
      });
    } else if (ev.type === "presence") {
      setPeople((cur) => (cur ? { ...cur, online: ev.online as string[] } : cur));
    }
  });

  const isOwner = people?.ownerId === me;

  // Search as the owner types (debounced); an empty query lists the first few.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchPeople(conversationId, query);
        if (!cancelled) setResults(r);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, isOwner, conversationId, people?.people.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = (userId: string) => {
    setError(null);
    startTransition(async () => {
      const res = await shareChat(conversationId, [userId]);
      if (res.error) setError(res.error);
      setQuery("");
      await refresh();
      inputRef.current?.focus();
    });
  };

  const removePerson = (userId: string, name: string) => {
    if (!confirm(`Remove ${name} from this chat?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await unshareChat(conversationId, userId);
      if (res.error) setError(res.error);
      await refresh();
    });
  };

  const leave = () => {
    if (!confirm("Leave this chat? It will disappear from your list.")) return;
    startTransition(async () => {
      const res = await leaveChat(conversationId);
      if (res.error) {
        setError(res.error);
        return;
      }
      remove([conversationId]);
      onClose();
      router.push("/chat");
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="People in this chat"
        data-people-panel={conversationId}
        className="w-full max-w-md rounded-2xl border border-border bg-background p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">People</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {loading || !people ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : (
          <>
            <ul className="divide-y divide-border/70 rounded-xl border border-border" data-people-list>
              {people.people.map((p) => {
                const online = people.online.includes(p.id);
                const name = displayName(p);
                return (
                  <li
                    key={p.id}
                    data-person={p.id}
                    data-person-role={p.role}
                    data-person-online={online ? "1" : "0"}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <span className="relative shrink-0">
                      <Avatar name={p.name ?? undefined} email={p.email} image={p.image} className="h-8 w-8" />
                      <span
                        aria-label={online ? "Online" : "Offline"}
                        title={online ? "Has this chat open" : "Not here right now"}
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${
                          online ? "bg-emerald-500" : "bg-border"
                        }`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {name}
                        {p.id === me ? <span className="text-muted"> (you)</span> : null}
                      </span>
                      <span className="block truncate text-xs text-muted">{p.email}</span>
                    </span>
                    {p.role === "owner" ? (
                      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                        Owner
                      </span>
                    ) : isOwner ? (
                      <button
                        type="button"
                        onClick={() => removePerson(p.id, name)}
                        disabled={pending}
                        aria-label={`Remove ${name}`}
                        title="Remove from this chat"
                        data-people-remove={p.id}
                        className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {isOwner ? (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-muted">Add a colleague</label>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or email…"
                  data-people-search
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent/50 focus:outline-none"
                />
                <ul className="mt-2 max-h-52 space-y-0.5 overflow-y-auto oi-scroll" data-people-results>
                  {results.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => add(r.id)}
                        disabled={pending}
                        data-people-result={r.id}
                        className="flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        <Avatar name={r.name ?? undefined} email={r.email} image={r.image} className="h-7 w-7" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">{displayName(r)}</span>
                          <span className="block truncate text-xs text-muted">{r.email}</span>
                        </span>
                        <span className="shrink-0 text-xs font-medium text-accent">Add</span>
                      </button>
                    </li>
                  ))}
                  {!searching && results.length === 0 ? (
                    <li className="px-2.5 py-2 text-xs text-muted">
                      {query ? "No one matches." : "Everyone on the portal is already here."}
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : (
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted">
                  Shared with you by {displayName(people.people.find((p) => p.role === "owner") ?? {})}.
                </p>
                <button
                  type="button"
                  onClick={leave}
                  disabled={pending}
                  data-people-leave
                  className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                >
                  Leave chat
                </button>
              </div>
            )}
            {error ? (
              <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
