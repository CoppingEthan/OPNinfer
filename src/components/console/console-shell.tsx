"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandLogo } from "@/components/branding";
import { logout } from "@/app/actions/session";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Shell for the operator console.
 *
 * Deliberately NOT `AdminShell`: that one links back to /chat, opens the
 * per-user settings modal and renders an avatar from `/api/avatar` — all of
 * which need a portal database this container does not have. Same visual
 * language, a tenth of the surface: nav, theme, sign out.
 */
const ITEMS = [
  { href: "/console", label: "Overview", icon: GridIcon, exact: true },
  { href: "/console/usage", label: "Usage", icon: ChartIcon },
  { href: "/console/activity", label: "Activity", icon: SparkIcon },
  { href: "/console/users", label: "People", icon: UsersIcon },
  { href: "/console/feedback", label: "Feedback", icon: ThumbIcon },
  { href: "/console/sandbox", label: "Sandbox", icon: CubeIcon },
  { href: "/console/logs", label: "Logs", icon: LogsIcon },
];

export function ConsoleShell({
  email,
  portals,
  children,
}: {
  email: string;
  portals: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-sidebar transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/console" aria-label="Overview" className="flex items-center py-1">
            <BrandLogo variant="full" className="h-[18px] text-foreground" />
          </Link>
          <button
            type="button"
            className="px-2 text-muted md:hidden"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="px-4 pb-3">
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            Operator console
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto oi-scroll px-2">
          {ITEMS.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`mb-0.5 flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface-hover font-medium text-foreground"
                    : "text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                <Icon />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border px-3 py-3">
          <p className="truncate px-1 text-xs text-muted" title={email}>
            {email}
          </p>
          <p className="mt-0.5 px-1 text-[11px] text-muted">
            {portals} portal{portals === 1 ? "" : "s"} · read-only
          </p>
          <div className="mt-2 flex items-center gap-1">
            <ThemeToggle />
            <form action={logout} className="flex-1">
              <button
                type="submit"
                className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <main className="flex-1 overflow-y-auto oi-scroll">
        <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur md:hidden">
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-muted"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            ☰
          </button>
          <BrandLogo variant="full" className="h-[16px] text-foreground" />
        </div>
        <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">{children}</div>
      </main>
    </div>
  );
}

/* — icons, matching the admin nav's weight — */
const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
function svg(children: React.ReactNode) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden {...P}>
      {children}
    </svg>
  );
}
function GridIcon() {
  return svg(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>,
  );
}
function ChartIcon() {
  return svg(
    <>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-5M12 16V8M16 16v-3" />
    </>,
  );
}
function SparkIcon() {
  return svg(
    <>
      <path d="m12 3 1.9 4.7L18.6 9.6l-4.7 1.9L12 16.2l-1.9-4.7L5.4 9.6l4.7-1.9Z" />
      <path d="M18 16.5 18.8 18.4 20.7 19.2 18.8 20 18 21.9 17.2 20 15.3 19.2 17.2 18.4Z" />
    </>,
  );
}
function UsersIcon() {
  return svg(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14.4A5.5 5.5 0 0 1 20.5 19" />
    </>,
  );
}
function ThumbIcon() {
  return svg(
    <>
      <path d="M7 11v8H4.5A1.5 1.5 0 0 1 3 17.5v-5A1.5 1.5 0 0 1 4.5 11Z" />
      <path d="M7 11l3.6-7a2 2 0 0 1 3.8 1l-.8 3.4h4.6a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17 19H7Z" />
    </>,
  );
}
function CubeIcon() {
  return svg(
    <>
      <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z" />
      <path d="m4 7.6 8 4.4 8-4.4M12 12v8.8" />
    </>,
  );
}
function LogsIcon() {
  return svg(
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5" />
    </>,
  );
}
