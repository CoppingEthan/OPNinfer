"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/branding";
import { AdminNav } from "./admin-nav";
import { Avatar } from "@/components/chat/avatar";
import { UserMenu } from "@/components/chat/user-menu";
import {
  useSidebarPrefs,
  ResizeHandle,
  SIDEBAR_RAIL,
} from "@/components/chat/sidebar-resize";

/**
 * Admin shell (spec §17/§20): the same resizable + collapsible left panel as the
 * chat sidebar (shared width via useSidebarPrefs) and the same top-right account
 * menu. Keeps the admin area visually consistent with the chat workspace.
 */
export function AdminShell({
  email,
  name,
  role,
  image,
  children,
  sandbox = false,
}: {
  email: string;
  name?: string;
  role?: string;
  image?: string | null;
  children: React.ReactNode;
  /** Show the Sandbox tab (capability enabled). */
  sandbox?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { width, collapsed, setWidth, toggleCollapsed } = useSidebarPrefs();
  const asideWidth = collapsed ? SIDEBAR_RAIL : width;

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        style={{ width: asideWidth }}
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-sidebar transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 py-3">
            <Link href="/chat" aria-label="Back to chat" className="flex items-center justify-center p-1.5">
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
            <Link href="/chat" aria-label="Back to chat" className="flex items-center px-2.5 py-1">
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

        <div className="min-h-0 flex-1 overflow-y-auto" onClick={() => setOpen(false)}>
          {!collapsed ? (
            <div className="px-4 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Administration
            </div>
          ) : null}
          <AdminNav collapsed={collapsed} sandbox={sandbox} />
        </div>

        <div className="p-2">
          {collapsed ? (
            <div className="flex justify-center">
              <Avatar name={name} email={email} image={image} className="h-8 w-8" />
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-2xl px-1.5 py-1.5">
              <Avatar name={name} email={email} image={image} className="h-7 w-7" />
              <div className="min-w-0 flex-1" title={email}>
                <div className="truncate text-sm font-medium text-foreground">
                  {name?.trim() || email.split("@")[0]}
                </div>
                <div className="truncate text-xs capitalize text-muted">{role ?? "admin"}</div>
              </div>
            </div>
          )}
        </div>

        {!collapsed ? <ResizeHandle width={width} setWidth={setWidth} /> : null}
      </aside>

      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
          <div className="flex items-center gap-3">
            <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="md:hidden">
              <MenuIcon />
            </button>
            <span className="text-sm font-medium text-muted md:hidden">Admin</span>
          </div>
          <UserMenu name={name} email={email} image={image} role={role} />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
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
