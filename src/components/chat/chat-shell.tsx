"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandLogo } from "@/components/branding";
import { Sidebar, type ConversationItem } from "./sidebar";
import type { FolderItem } from "./folders-ui";
import { Avatar } from "./avatar";
import { UserMenu } from "./user-menu";
import { WhatsNew } from "./whats-new";
import { ConversationsProvider, useConversations } from "./conversations-store";
import { LiveProvider } from "./live-provider";
import { PeoplePanel } from "./people-panel";
import {
  useSidebarPrefs,
  ResizeHandle,
  SIDEBAR_RAIL,
} from "./sidebar-resize";

/** The sidebar's kebab asks the shell to open the People panel for a chat. */
export const PEOPLE_EVENT = "oi:people";

export function ChatShell({
  conversations,
  folders = [],
  userId,
  email,
  name,
  role,
  image,
  isAdmin,
  children,
}: {
  conversations: ConversationItem[];
  folders?: FolderItem[];
  userId: string;
  email: string;
  name?: string;
  role?: string;
  image?: string | null;
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false); // mobile drawer
  const { width, collapsed, setWidth, toggleCollapsed } = useSidebarPrefs();
  const displayName = name?.trim() || email.split("@")[0] || "Account";
  const asideWidth = collapsed ? SIDEBAR_RAIL : width;

  return (
    <ConversationsProvider initial={conversations}>
      <LiveProvider userId={userId}>
      <div className="flex h-dvh overflow-hidden">
        {/* Sidebar — static + resizable on desktop, slide-over on mobile. */}
        <aside
          style={{ width: asideWidth }}
          className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-sidebar transition-transform md:static md:translate-x-0 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/* Logo + collapse toggle. */}
          {collapsed ? (
            <div className="flex flex-col items-center gap-1 py-3">
              <Link href="/chat" aria-label="OPNinfer home" className="flex items-center justify-center p-1.5">
                <BrandLogo variant="mark" className="h-6 w-6 text-foreground" />
              </Link>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Expand sidebar"
                title="Expand sidebar"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <ChevronIcon dir="right" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between px-2 py-3">
              <Link href="/chat" aria-label="OPNinfer home" className="flex items-center px-2.5 py-1">
                <BrandLogo variant="full" className="h-[18px] text-foreground" />
              </Link>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  className="hidden h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground md:inline-flex"
                >
                  <ChevronIcon dir="left" />
                </button>
                <button
                  type="button"
                  className="px-2 md:hidden"
                  aria-label="Close menu"
                  onClick={() => setOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1" onClick={() => setOpen(false)}>
            <Sidebar collapsed={collapsed} isAdmin={isAdmin} folders={folders} />
          </div>

          {/* Bottom identity chip — controls moved to the top-right menu (§7). */}
          <div className="p-2">
            {collapsed ? (
              <div className="flex justify-center">
                <Avatar name={name} email={email} image={image} className="h-8 w-8" />
              </div>
            ) : (
              <div className="flex items-center gap-2.5 rounded-2xl px-1.5 py-1.5">
                <Avatar name={name} email={email} image={image} className="h-7 w-7" />
                <div className="min-w-0 flex-1" title={email}>
                  <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
                  <div className="truncate text-xs capitalize text-muted">{role ?? "user"}</div>
                </div>
              </div>
            )}
          </div>

          {!collapsed ? <ResizeHandle width={width} setWidth={setWidth} /> : null}
        </aside>

        {/* Backdrop for the mobile drawer. */}
        {open ? (
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar: mobile menu on the left, account controls on the right (§7). */}
          <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Open menu"
                onClick={() => setOpen(true)}
                className="md:hidden"
              >
                <MenuIcon />
              </button>
              <BrandLogo variant="full" className="h-5 text-foreground md:hidden" />
            </div>
            <div className="flex items-center gap-1.5">
              <PeopleButton userId={userId} />
              <IncognitoButton />
              <UserMenu name={name} email={email} image={image} role={role} />
            </div>
          </header>
          <main className="min-h-0 flex-1">{children}</main>
        </div>

        {/* Release notes — mounted once here so it survives navigation between
            chats and can only ever pop itself open a single time. */}
        <WhatsNew />
      </div>
      </LiveProvider>
    </ConversationsProvider>
  );
}

/**
 * People (v0.5 shared chats): shown while a saved, non-incognito chat is open.
 * A count badge once the chat is shared. Also opened by the sidebar kebab's
 * "People" for any chat, via a window event.
 */
function PeopleButton({ userId }: { userId: string }) {
  const pathname = usePathname();
  const { conversations } = useConversations();
  const current = pathname?.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
  const item = current ? conversations.find((c) => c.id === current) : undefined;
  const [panelFor, setPanelFor] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ conversationId: string }>).detail?.conversationId;
      if (id) setPanelFor(id);
    };
    window.addEventListener(PEOPLE_EVENT, onOpen);
    return () => window.removeEventListener(PEOPLE_EVENT, onOpen);
  }, []);

  // Leaving the chat (or losing it) closes the panel for it.
  useEffect(() => {
    if (panelFor && !conversations.some((c) => c.id === panelFor)) setPanelFor(null);
  }, [conversations, panelFor]);

  return (
    <>
      {item ? (
        <button
          type="button"
          onClick={() => setPanelFor(item.id)}
          title={item.shared ? "People in this chat" : "Share this chat with a colleague"}
          data-people-button
          data-people-count={item.memberCount}
          className="group inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <span className="oi-icon-anim oi-icon-pop">
            <PeopleIcon />
          </span>
          <span className="hidden sm:inline">{item.shared ? "People" : "Share"}</span>
          {item.shared ? (
            <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">
              {item.memberCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {panelFor ? (
        <PeoplePanel conversationId={panelFor} me={userId} onClose={() => setPanelFor(null)} />
      ) : null}
    </>
  );
}

/** Starts a fresh incognito chat (spec §10). */
function IncognitoButton() {
  return (
    <Link
      href="/chat?incognito=1"
      title="Incognito chat — deleted when you leave"
      className="group inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <span className="oi-icon-anim oi-icon-pop">
        <MaskIcon />
      </span>
      <span className="hidden sm:inline">Incognito</span>
    </Link>
  );
}

export function PeopleIcon({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3.3 3-5 5.5-5s4.9 1.7 5.5 5" />
      <circle cx="16.5" cy="9.5" r="2.4" />
      <path d="M15.2 14.3c2.6 0 4.6 1.5 5.3 4.7" />
    </svg>
  );
}
function MaskIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5c2 0 3-1 4.5-1S10 9 12 9s2.5-1.5 4.5-1.5S19 8.5 21 8.5v3c0 3-2.5 5-5 5-1.6 0-2.4-.9-4-.9s-2.4.9-4 .9c-2.5 0-5-2-5-5z" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}
