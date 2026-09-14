"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { uid } from "@/lib/uid";
import { useConversations } from "./conversations-store";
import type { ConversationItem } from "./sidebar";

/**
 * The browser end of the live feed (v0.5 shared chats — src/lib/live.ts).
 *
 * ONE EventSource per tab, held for as long as the chat pages are open and
 * re-opened with a new `viewing` whenever the tab moves to another chat.
 * Sidebar-level events are handled right here (a chat shared with you, one
 * taken away, a title, a bump and unread dot, a deletion); everything else is
 * handed to whoever registered a handler — the chat window, for the chat it
 * is showing, and the People panel.
 *
 * `clientId` is this tab's identity: it rides every send as `X-OI-Client`
 * so the server can skip echoing the tab's own message and "reply started"
 * back to it (it already has the bubble and is subscribed to the stream).
 */

export interface LiveEventData {
  type: string;
  conversationId?: string;
  [key: string]: unknown;
}

type Handler = (ev: LiveEventData) => void;

interface LiveCtx {
  clientId: string;
  userId: string;
  subscribe: (handler: Handler) => () => void;
}

const Ctx = createContext<LiveCtx | null>(null);

const TOAST_MS = 7_000;

export function LiveProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const pathname = usePathname();
  const viewing = pathname?.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) clientIdRef.current = uid();
  const handlers = useRef(new Set<Handler>());
  const { conversations, upsert, patch, remove, bump } = useConversations();
  const knownIds = useRef(new Set<string>());
  knownIds.current = new Set(conversations.map((c) => c.id));
  const [toasts, setToasts] = useState<{ id: string; text: string; href?: string }[]>([]);

  const subscribe = useCallback((handler: Handler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  const toast = useCallback((text: string, href?: string) => {
    const id = uid();
    setToasts((prev) => [...prev, { id, text, href }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  // Opening a chat clears its unread dot locally (the server marks it read
  // when the feed connects with `viewing`).
  useEffect(() => {
    if (viewing) patch(viewing, { unread: false });
  }, [viewing, patch]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const params = new URLSearchParams({ client: clientIdRef.current });
    if (viewing) params.set("viewing", viewing);
    const es = new EventSource(`/api/chat/live?${params.toString()}`);
    let hadError = false;

    es.onopen = () => {
      if (hadError) {
        hadError = false;
        // Reconnected after a drop: whoever is showing a chat reloads it.
        for (const h of handlers.current) h({ type: "resync", conversationId: viewing ?? undefined });
      }
    };
    es.onerror = () => {
      hadError = true; // EventSource retries by itself
    };
    es.onmessage = (m) => {
      let ev: LiveEventData;
      try {
        ev = JSON.parse(m.data as string) as LiveEventData;
      } catch {
        return;
      }
      if (ev.type === "ping" || ev.type === "hello") return;

      // Sidebar-level events, handled once, here.
      if (ev.type === "chat_added") {
        const item = ev.item as ConversationItem;
        upsert(item);
        toast(`${String(ev.by ?? "Someone")} shared "${item.title}" with you`, `/chat/${item.id}`);
      } else if (ev.type === "chat_item") {
        const item = ev.item as ConversationItem;
        // The chat on screen is never unread, whatever the server's row says.
        const row = item.id === viewing ? { ...item, unread: false } : item;
        if (knownIds.current.has(item.id)) patch(item.id, row);
        else upsert(row);
      } else if (ev.type === "chat_removed" || ev.type === "chat_deleted") {
        if (ev.conversationId) remove([ev.conversationId]);
      } else if (ev.type === "title") {
        if (ev.conversationId) patch(ev.conversationId, { title: String(ev.title ?? "") });
      } else if (ev.type === "activity") {
        if (ev.conversationId) {
          bump(ev.conversationId, String(ev.updatedAt ?? new Date().toISOString()));
          if (ev.conversationId !== viewing && ev.byUserId !== userId) {
            patch(ev.conversationId, { unread: true });
          }
        }
      }

      for (const h of handlers.current) {
        try {
          h(ev);
        } catch {
          /* one bad handler must not break the feed */
        }
      }
    };
    return () => es.close();
  }, [viewing, userId, upsert, patch, remove, bump, toast]);

  return (
    <Ctx.Provider value={{ clientId: clientIdRef.current, userId, subscribe }}>
      {children}
      {toasts.length > 0 ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-live-toasts>
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="oi-fade-in pointer-events-auto rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm text-foreground shadow-lg"
            >
              {t.href ? (
                <Link href={t.href} className="hover:underline">
                  {t.text}
                </Link>
              ) : (
                t.text
              )}
            </div>
          ))}
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

export function useLive(): LiveCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLive must be used within LiveProvider");
  return ctx;
}

/** Register a handler for live events; the latest handler is always the one
 *  called, so callers can pass a fresh closure each render. */
export function useLiveEvents(handler: Handler): void {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((ev) => ref.current(ev)), [subscribe]);
}
