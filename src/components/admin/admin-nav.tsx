"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Left-hand navigation for the admin area (point 3 restructure): a vertical
 * column on desktop, a horizontal scroller on mobile. Active state is derived
 * from the current path.
 */
const ITEMS = [
  { href: "/admin/api", label: "API", icon: KeyIcon },
  { href: "/admin/models", label: "Models", icon: ModelIcon },
  { href: "/admin/users", label: "Users", icon: UsersIcon },
  { href: "/admin/chats", label: "Chats", icon: ChatsIcon },
  { href: "/admin/usage", label: "Usage", icon: ChartIcon },
  { href: "/admin/feedback", label: "Feedback", icon: ThumbIcon },
  { href: "/admin/smtp", label: "SMTP", icon: MailIcon },
  { href: "/admin/customise", label: "Customise", icon: PaintIcon },
  { href: "/admin/tools", label: "Tools", icon: WrenchIcon },
  { href: "/admin/backups", label: "Backups", icon: BackupIcon },
  { href: "/admin/logs", label: "Logs", icon: LogsIcon },
];

/** The Sandbox tab exists only while the capability is enabled (owner ask,
 *  2026-09-02): its settings and data moved out of Tools into their own page,
 *  and an instance that never turned it on should not see an empty tab. */
const SANDBOX_ITEM = { href: "/admin/sandbox", label: "Sandbox", icon: CubeIcon };

function navItems(sandbox: boolean) {
  if (!sandbox) return ITEMS;
  const i = ITEMS.findIndex((it) => it.href === "/admin/tools");
  return [...ITEMS.slice(0, i + 1), SANDBOX_ITEM, ...ITEMS.slice(i + 1)];
}

export function AdminNav({ collapsed = false, sandbox = false }: { collapsed?: boolean; sandbox?: boolean }) {
  const pathname = usePathname();
  const items = navItems(sandbox);

  if (collapsed) {
    return (
      <nav className="flex flex-col items-center gap-1 p-2">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              title={label}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                active
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:bg-surface-hover hover:text-foreground"
              }`}
            >
              <Icon />
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2.5 rounded-2xl px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-surface-hover text-foreground"
                : "text-muted hover:bg-surface-hover hover:text-foreground"
            }`}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const iconCls = "h-4 w-4 shrink-0";
const svg = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

function CubeIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="M10 13l8-8M16 5l2 2M13 8l2 2" />
    </svg>
  );
}
function ModelIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h6v6H9z" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5a3 3 0 0 1 0 6M17 14c2.3.6 4 2.6 4 5" />
    </svg>
  );
}
function ChatsIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <path d="M8 15H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v1" />
      <path d="M10 20V13a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3h-4l-4 4Z" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <path d="M4 4v16h16" />
      <path d="M8 16v-4M12 16v-7M16 16v-3" />
    </svg>
  );
}
function ThumbIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <path d="M7 11v9M3 13v5a2 2 0 0 0 2 2h11.3a2 2 0 0 0 2-1.7l1.2-7a2 2 0 0 0-2-2.3H13l1-4.3A1.8 1.8 0 0 0 10.6 3L7 11" />
    </svg>
  );
}
function MailIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}
function PaintIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8.5" cy="10" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="15.5" cy="10" r="1" />
      <path d="M12 21a3 3 0 0 1 0-6 2 2 0 0 0 2-2 9 9 0 0 0-2-6" />
    </svg>
  );
}
function LogsIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h5M8 12h8M8 16h6" />
    </svg>
  );
}
function WrenchIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6L14.5 12l-2.5-2.5 2.7-3.2Z" />
    </svg>
  );
}
function BackupIcon() {
  return (
    <svg className={iconCls} {...svg}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 11v6m0 0-2.5-2.5M12 17l2.5-2.5" />
    </svg>
  );
}
