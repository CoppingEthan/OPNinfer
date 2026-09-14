"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { pageTitle } from "@/lib/version";
import type { ConversationItem } from "./sidebar";

/**
 * Client-side conversation list so the sidebar updates instantly — a new chat
 * appears the moment it's created and an active chat re-sorts on each reply,
 * with no server round-trip or full re-render flash. Seeded from the server
 * layout; re-syncs whenever the server re-renders (navigation, revalidate).
 */
interface ConversationsCtx {
  conversations: ConversationItem[];
  /** Insert or move a conversation to the top (new chat, or title change). */
  upsert: (c: ConversationItem) => void;
  /** Move an existing conversation to the top and stamp it as just-updated. */
  bump: (id: string, isoNow: string) => void;
  /** Optimistically patch a conversation's fields (star, rename). */
  patch: (id: string, partial: Partial<ConversationItem>) => void;
  /** Optimistically drop conversations from the list (delete, multi-delete). */
  remove: (ids: string[]) => void;
}

const Ctx = createContext<ConversationsCtx | null>(null);

export function ConversationsProvider({
  initial,
  children,
}: {
  initial: ConversationItem[];
  children: React.ReactNode;
}) {
  const [conversations, setConversations] = useState(initial);
  const pathname = usePathname();

  // Server is the source of truth on full renders. Optimistic edits happen only
  // between renders (we don't revalidate on send), so they survive until the
  // next genuine server render, which then reconciles to persisted state.
  //
  // One exception (v0.5): the chat you are LOOKING AT is never unread. The
  // layout's list is built in parallel with the page, before the live feed
  // has connected and marked the chat read, so the server's row can still say
  // "unread" for the very chat on screen.
  // Keyed on `initial` ONLY: a brand-new chat rewrites the URL with
  // replaceState before any server render includes it, and re-syncing on the
  // pathname change wiped the optimistic row (and the People button with it).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  useEffect(
    () =>
      setConversations(
        initial.map((c) =>
          pathnameRef.current === `/chat/${c.id}` && c.unread ? { ...c, unread: false } : c,
        ),
      ),
    [initial],
  );

  const upsert = useCallback((c: ConversationItem) => {
    setConversations((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
  }, []);

  const bump = useCallback((id: string, isoNow: string) => {
    setConversations((prev) => {
      const found = prev.find((x) => x.id === id);
      if (!found) return prev;
      return [
        { ...found, updatedAt: isoNow },
        ...prev.filter((x) => x.id !== id),
      ];
    });
  }, []);

  const patch = useCallback(
    (id: string, partial: Partial<ConversationItem>) => {
      setConversations((prev) =>
        prev.map((x) => (x.id === id ? { ...x, ...partial } : x)),
      );
      // Every rename (manual and rename-with-AI) comes through here, so the
      // browser tab is kept current in ONE place rather than at each call
      // site. The page's own metadata only re-runs on navigation.
      if (partial.title && pathname === `/chat/${id}`) {
        document.title = pageTitle(partial.title);
      }
    },
    [pathname],
  );

  const remove = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    setConversations((prev) => prev.filter((x) => !drop.has(x.id)));
  }, []);

  return (
    <Ctx.Provider value={{ conversations, upsert, bump, patch, remove }}>
      {children}
    </Ctx.Provider>
  );
}

export function useConversations(): ConversationsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useConversations must be used within ConversationsProvider");
  }
  return ctx;
}
