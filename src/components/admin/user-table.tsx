"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Role } from "@prisma/client";
import {
  adminResetPassword,
  approveUser,
  deleteUser,
  setUserDisabled,
  setUserRole,
  updateUser,
} from "@/app/actions/admin";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { fieldCls } from "./ui";
import { useDialog } from "@/components/ui/dialog";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  verified: boolean;
  disabled: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  /** Lifetime tokens (input includes cached reads). */
  inputTokens: number;
  outputTokens: number;
}

/** Compact token count, e.g. 1.2K, 3.4M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function initials(nameOrEmail: string): string {
  const base = nameOrEmail.split("@")[0];
  return (
    base
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "U"
  );
}

export function UserTable({
  users,
  currentUserId,
}: {
  users: AdminUser[];
  currentUserId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div>
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Last active</th>
                <th className="w-10 px-4 py-3 text-right font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === currentUserId}
                  isEditing={editing === u.id}
                  onEdit={() => setEditing(editing === u.id ? null : u.id)}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  isEditing,
  onEdit,
  onError,
}: {
  user: AdminUser;
  isSelf: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onError: (msg: string | null) => void;
}) {
  const dialog = useDialog();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resetMsg, setResetMsg] = useState<{
    emailed?: boolean;
    password?: string;
    email?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const run = (fn: () => Promise<{ error?: string } | void>) =>
    startTransition(async () => {
      onError(null);
      const res = await fn();
      if (res && "error" in res && res.error) onError(res.error);
    });

  // `sendEmail: false` is the whole point of the second menu item: reset
  // emails are being delivered and then blocked at the recipient's end, so
  // the admin needs the password in front of them to pass on another way.
  const setPw = (sendEmail: boolean) =>
    startTransition(async () => {
      onError(null);
      setResetMsg(null);
      setCopied(false);
      const res = await adminResetPassword(user.id, { sendEmail });
      if (res.error) onError(res.error);
      else setResetMsg(res);
    });

  const items: MenuItem[] = [
    !user.verified && {
      label: "Approve",
      onClick: () => run(() => approveUser(user.id)),
    },
    {
      label: isEditing ? "Close editor" : "Edit details",
      onClick: onEdit,
    },
    {
      label: "View chats",
      onClick: () => router.push(`/admin/chats?user=${user.id}`),
    },
    {
      label: user.role === "admin" ? "Make user" : "Make admin",
      onClick: () =>
        run(() =>
          setUserRole(user.id, user.role === "admin" ? Role.user : Role.admin),
        ),
    },
    { label: "Set a password", onClick: () => setPw(false) },
    { label: "Email a new password", onClick: () => setPw(true) },
    !isSelf && {
      label: user.disabled ? "Enable" : "Disable",
      onClick: () => run(() => setUserDisabled(user.id, !user.disabled)),
    },
    !isSelf &&
      user.role !== "admin" && {
        label: "Delete",
        danger: true,
        onClick: async () => {
          const ok = await dialog.confirm({
            title: `Delete ${user.email}?`,
            body: "This removes their chats and can't be undone. Billing history survives, anonymised.",
            confirmLabel: "Delete account",
            danger: true,
          });
          if (ok) run(() => deleteUser(user.id));
        },
      },
  ].filter(Boolean) as MenuItem[];

  return (
    <>
      <tr className={pending ? "opacity-50" : ""}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
              {initials(user.name || user.email)}
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {user.name || user.email}
                {isSelf ? <span className="ml-1 text-xs text-muted">(you)</span> : null}
              </div>
              <div className="truncate text-xs text-muted">
                {user.name ? `${user.email} · ` : ""}joined {formatDate(user.createdAt)}
              </div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              user.role === "admin"
                ? "bg-accent/15 text-accent"
                : "bg-surface text-muted ring-1 ring-border"
            }`}
          >
            {user.role}
          </span>
        </td>
        <td className="px-4 py-3">
          {user.disabled ? (
            <Badge tone="red">disabled</Badge>
          ) : user.verified ? (
            <Badge tone="green">active</Badge>
          ) : (
            <Badge tone="amber">unverified</Badge>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-muted">
          <span title={`${user.inputTokens.toLocaleString()} in · ${user.outputTokens.toLocaleString()} out`}>
            <span className="text-foreground">{fmtTokens(user.inputTokens)}</span> in ·{" "}
            <span className="text-foreground">{fmtTokens(user.outputTokens)}</span> out
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-muted">
          {user.lastActiveAt ? formatDate(user.lastActiveAt) : "never"}
        </td>
        <td className="px-4 py-3 text-right">
          <ActionMenu items={items} disabled={pending} label={`Actions for ${user.email}`} />
        </td>
      </tr>
      {isEditing ? (
        <tr>
          <td colSpan={6} className="bg-surface/50 px-4 py-4">
            <EditForm user={user} onError={onError} onDone={onEdit} />
          </td>
        </tr>
      ) : null}
      {resetMsg?.password ? (
        <tr>
          <td colSpan={6} className="bg-surface/50 px-4 py-3 text-sm">
            {/* `w-0 min-w-full` so this row cannot WIDEN the table: a cell's
                min-content width is what an auto-layout table sizes to, and
                the first version pushed the table 45px past its scroll
                container, which then scrolled sideways and clipped this very
                message (measured, not guessed). Width 0 contributes nothing;
                min-width:100% still fills the row. */}
            <div
              className="w-0 min-w-full"
              // The users table is wider than its scroll container at ordinary
              // window sizes, and opening the row menu scrolls that container
              // sideways to reveal what was clicked — which then clipped the
              // left of this very message, including the word "Temporary" and
              // "It works once". Bring it back: at the moment this appears, it
              // is the only thing on screen that matters.
              ref={(el) => {
                el?.closest<HTMLElement>("div.overflow-x-auto")?.scrollTo({ left: 0 });
              }}
            >
            <div className="flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
              <span className="text-foreground">Temporary password for {user.email}:</span>
              <code
                className="select-all rounded bg-background px-2 py-1 font-mono text-xs"
                data-temp-password
              >
                {resetMsg.password}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(resetMsg.password!)
                    .then(() => setCopied(true))
                    .catch(() => {});
                }}
                className="rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              {resetMsg.emailed ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  also emailed
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              It works once — they&apos;ll be asked to choose their own the moment they sign
              in. It disappears when you navigate away, so copy it now.
            </p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** Kebab dropdown, portaled to <body> so the table's scroll box can't clip it. */
function ActionMenu({
  items,
  disabled,
  label,
}: {
  items: MenuItem[];
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDoc = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    // Defer so the opening click doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && mounted && pos
        ? createPortal(
            <div
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: pos.top, right: pos.right }}
              className="z-50 w-44 rounded-xl border border-border bg-background p-1 shadow-xl"
            >
              {items.map((it, i) => (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover ${
                    it.danger ? "text-red-600 dark:text-red-400" : "text-foreground"
                  }`}
                >
                  {it.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function EditForm({
  user,
  onError,
  onDone,
}: {
  user: AdminUser;
  onError: (msg: string | null) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      onError(null);
      setOk(null);
      const res = await updateUser(user.id, { name, email, password });
      if (res.error) onError(res.error);
      else {
        setOk(res.success ?? "Saved.");
        setPassword("");
      }
    });

  return (
    <div className="max-w-2xl">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Display name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
            className={fieldCls}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldCls}
          />
        </Field>
        <Field label="Set new password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank to keep"
            autoComplete="new-password"
            className={fieldCls}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        {ok ? <span className="text-sm text-emerald-600 dark:text-emerald-400">{ok}</span> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "green" | "red" | "amber";
  children: ReactNode;
}) {
  const tones = {
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    red: "bg-red-500/10 text-red-600 dark:text-red-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
