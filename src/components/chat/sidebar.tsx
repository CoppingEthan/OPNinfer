"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  deleteConversations,
  renameConversation,
  renameConversationWithAI,
  togglePin,
} from "@/app/actions/conversations";
import { leaveChat } from "@/app/actions/sharing";
import { createFolder, deleteFolder, moveToFolder, renameFolder } from "@/app/actions/folders";
import { FolderPicker, FolderSection, useOpenFolders, type FolderItem } from "./folders-ui";
import { useConversations } from "./conversations-store";
import { SearchModal } from "./search-modal";
import { Avatar } from "./avatar";
import { PEOPLE_EVENT, PeopleIcon } from "./chat-shell";

export interface ConversationItem {
  id: string;
  title: string;
  /** YOUR star — the owner's lives on the chat, a member's on their membership. */
  pinned: boolean;
  /** YOUR folder, same per-person rule as the star. Null = not filed. */
  folderId?: string | null;
  updatedAt: string;
  /** Shared chats (v0.5): true once the chat has people in it besides you. */
  shared: boolean;
  /** You created it (owner) — else it was shared with you. */
  mine: boolean;
  ownerId: string;
  /** The owner, for chats shared WITH you (absent on your own). */
  owner?: { name: string | null; email: string; image: string | null };
  memberCount: number;
  /** Someone wrote in it since you last opened it (shared chats only). */
  unread?: boolean;
}

/** Bucket a conversation by recency for date-grouped display. */
function dateBucket(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((startOfToday.getTime() - d.getTime()) / dayMs);
  if (d >= startOfToday) return "Today";
  if (diffDays < 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 days";
  if (diffDays < 30) return "Previous 30 days";
  return "Older";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

/** Compact relative time, e.g. "3m", "2h", "5d", "1w". */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

/** Fetch a conversation's JSON export and trigger a browser download. */
async function downloadChat(id: string, title: string) {
  const res = await fetch(`/api/conversations/${id}/export`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "chat"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function Sidebar({
  collapsed = false,
  isAdmin = false,
  folders: initialFolders = [],
}: {
  collapsed?: boolean;
  isAdmin?: boolean;
  folders?: FolderItem[];
}) {
  const { conversations, patch, remove } = useConversations();
  const pathname = usePathname();
  const router = useRouter();
  const activeId = pathname?.startsWith("/chat/")
    ? pathname.slice("/chat/".length)
    : null;
  const [searchOpen, setSearchOpen] = useState(false);

  // Folders are held locally so create/rename/delete land immediately; the
  // server action revalidates /chat behind them.
  const [folders, setFolders] = useState<FolderItem[]>(initialFolders);
  useEffect(() => setFolders(initialFolders), [initialFolders]);
  const { open: openFolders, toggle: toggleFolder } = useOpenFolders();
  /** Which chats the picker is about to move: [] when it is closed. */
  const [picking, setPicking] = useState<string[]>([]);

  const row = (c: ConversationItem) => (
    <ConversationRow
      key={c.id}
      item={c}
      active={c.id === activeId}
      selectionMode={selectionMode}
      selected={selected.has(c.id)}
      onToggleSelect={() => toggleSelect(c.id)}
      onStartSelection={() => startSelection(c.id)}
      onPatch={patch}
      onRemoved={(id) => {
        remove([id]);
        if (activeId === id) router.push("/chat");
      }}
      onDownload={downloadChat}
      onMoveToFolder={() => setPicking([c.id])}
    />
  );

  const fileChats = (ids: string[], folderId: string | null) => {
    if (ids.length === 0) return;
    for (const id of ids) patch(id, { folderId });
    setPicking([]);
    startBulk(async () => {
      await moveToFolder(ids, folderId);
    });
  };

  // Multi-select ("select" then bulk delete).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, startBulk] = useTransition();

  // ⌘K / Ctrl+K opens the search palette (the visible hint tag is gone, §2).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const startSelection = (id: string) => {
    setSelectionMode(true);
    setSelected(new Set([id]));
  };
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelection = () => {
    setSelectionMode(false);
    setSelected(new Set());
  };
  const deleteSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} chat${ids.length > 1 ? "s" : ""}? This can't be undone.`)) {
      return;
    }
    startBulk(async () => {
      remove(ids);
      await deleteConversations(ids);
      exitSelection();
      if (activeId && ids.includes(activeId)) router.push("/chat");
    });
  };

  // Starred first (personal), then every SHARED chat — the ones you shared
  // and the ones shared with you, in one section (owner decision 4) — then
  // your private chats by date.
  //
  // A FOLDERED chat leaves the date buckets — listing it twice would make the
  // sidebar longer, not tidier. A starred one still shows under Starred,
  // because a star is a shortcut rather than a place.
  const folderIds = new Set(folders.map((f) => f.id));
  const filed = (c: ConversationItem) => !!c.folderId && folderIds.has(c.folderId);
  const pinned = conversations.filter((c) => c.pinned);
  const sharedChats = conversations.filter((c) => !c.pinned && c.shared && !filed(c));
  const rest = conversations.filter((c) => !c.pinned && !c.shared && !filed(c));
  const byFolder = new Map<string, ConversationItem[]>();
  for (const c of conversations) {
    if (!filed(c) || c.pinned) continue;
    (byFolder.get(c.folderId!) ?? byFolder.set(c.folderId!, []).get(c.folderId!)!).push(c);
  }
  const buckets = new Map<string, ConversationItem[]>();
  for (const c of rest) {
    const b = dateBucket(c.updatedAt);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(c);
  }

  // Collapsed icon-rail: only the primary actions (§5). Logo + avatar live in
  // the shell around this component.
  if (collapsed) {
    return (
      <nav className="flex h-full flex-col items-center gap-1 px-2 pt-2">
        <RailButton href="/chat" label="New chat" icon={<ComposeIcon />} anim="oi-icon-nudge" />
        <RailButton label="Search" icon={<SearchIcon />} anim="oi-icon-pop" onClick={() => setSearchOpen(true)} />
        {isAdmin ? (
          <RailButton href="/admin" label="Admin" icon={<AdminIcon />} anim="oi-icon-pop" />
        ) : null}
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      </nav>
    );
  }

  return (
    <nav className="flex h-full flex-col px-2 pt-2">
      <NavRow href="/chat" icon={<ComposeIcon />} anim="oi-icon-nudge" label="New chat" />
      <NavRow icon={<SearchIcon />} anim="oi-icon-pop" label="Search" onClick={() => setSearchOpen(true)} />
      {isAdmin ? (
        <NavRow href="/admin" icon={<AdminIcon />} anim="oi-icon-pop" label="Admin" />
      ) : null}

      {selectionMode ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-2xl bg-surface-hover px-3 py-1.5 text-xs">
          <span className="font-medium text-foreground">{selected.size} selected</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPicking([...selected])}
              disabled={bulkPending || selected.size === 0}
              className="rounded-lg px-2 py-1 font-medium text-foreground transition-colors hover:bg-surface disabled:opacity-40"
            >
              Move
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={bulkPending || selected.size === 0}
              className="rounded-lg px-2 py-1 font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-40 dark:text-red-400"
            >
              {bulkPending ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={exitSelection}
              disabled={bulkPending}
              className="rounded-lg px-2 py-1 text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="oi-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pt-2.5 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-sm text-muted">
            No conversations yet.
          </p>
        ) : null}

        {folders.map((f) => (
          <FolderSection
            key={f.id}
            folder={f}
            count={(byFolder.get(f.id) ?? []).length}
            open={openFolders.has(f.id)}
            onToggle={() => toggleFolder(f.id)}
            onRename={(name) => {
              setFolders((prev) => prev.map((x) => (x.id === f.id ? { ...x, name } : x)));
              startBulk(async () => {
                await renameFolder(f.id, name);
              });
            }}
            onDelete={() => {
              if (!confirm(`Delete the folder "${f.name}"? The chats in it stay.`)) return;
              setFolders((prev) => prev.filter((x) => x.id !== f.id));
              for (const c of byFolder.get(f.id) ?? []) patch(c.id, { folderId: null });
              startBulk(async () => {
                await deleteFolder(f.id);
              });
            }}
            onDropChat={(id) => fileChats([id], f.id)}
          >
            {(byFolder.get(f.id) ?? []).map((c) => row(c))}
            {(byFolder.get(f.id) ?? []).length === 0 ? (
              <li className="px-2.5 py-2 text-xs text-muted">Drag a chat here.</li>
            ) : null}
          </FolderSection>
        ))}

        {pinned.length > 0 ? (
          <Section title="Starred">
            {pinned.map((c) => row(c))}
          </Section>
        ) : null}

        {sharedChats.length > 0 ? (
          <Section title="Shared" dataSection="shared">
            {sharedChats.map((c) => row(c))}
          </Section>
        ) : null}

        {BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => (
          <Section key={b} title={b}>
            {buckets.get(b)!.map((c) => row(c))}
          </Section>
        ))}
      </div>

      <FolderPicker
        open={picking.length > 0}
        folders={folders}
        count={picking.length}
        currentId={
          picking.length === 1
            ? (conversations.find((c) => c.id === picking[0])?.folderId ?? null)
            : null
        }
        onPick={(folderId) => fileChats(picking, folderId)}
        onCreate={(name) => {
          const ids = picking;
          setPicking([]);
          startBulk(async () => {
            const res = await createFolder(name);
            if (res.id) {
              setFolders((prev) => [...prev, { id: res.id!, name }]);
              for (const id of ids) patch(id, { folderId: res.id });
              await moveToFolder(ids, res.id);
            }
          });
        }}
        onClose={() => setPicking([])}
      />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </nav>
  );
}

function NavRow({
  href,
  icon,
  anim,
  label,
  onClick,
}: {
  href?: string;
  icon: ReactNode;
  anim?: string;
  label: string;
  onClick?: () => void;
}) {
  const cls =
    "group flex items-center gap-3 rounded-2xl px-2.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover";
  const inner = (
    <>
      <span className={`shrink-0 text-muted oi-icon-anim ${anim ?? ""}`}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={`w-full ${cls}`}>
      {inner}
    </button>
  );
}

function RailButton({
  href,
  icon,
  anim,
  label,
  onClick,
}: {
  href?: string;
  icon: ReactNode;
  anim?: string;
  label: string;
  onClick?: () => void;
}) {
  const cls =
    "group flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-hover hover:text-foreground";
  const inner = <span className={`oi-icon-anim ${anim ?? ""}`}>{icon}</span>;
  return href ? (
    <Link href={href} aria-label={label} title={label} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

function Section({
  title,
  children,
  dataSection,
}: {
  title?: string;
  children: ReactNode;
  dataSection?: string;
}) {
  return (
    <div data-sidebar-section={dataSection ?? title}>
      {title ? (
        <h3 className="px-2.5 pb-1 pt-1 text-xs font-medium text-muted">{title}</h3>
      ) : null}
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function ConversationRow({
  item,
  active,
  selectionMode,
  selected,
  onToggleSelect,
  onStartSelection,
  onMoveToFolder,
  onPatch,
  onRemoved,
  onDownload,
}: {
  item: ConversationItem;
  active: boolean;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onStartSelection: () => void;
  onMoveToFolder: () => void;
  onPatch: (id: string, partial: Partial<ConversationItem>) => void;
  onRemoved: (id: string) => void;
  onDownload: (id: string, title: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [aiPending, setAiPending] = useState(false);

  useEffect(() => setTitle(item.title), [item.title]);

  const submitRename = () => {
    startTransition(async () => {
      const next = title.trim();
      if (next && next !== item.title) {
        onPatch(item.id, { title: next });
        await renameConversation(item.id, next);
      }
      setEditing(false);
    });
  };

  if (editing) {
    return (
      <li>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitRename();
          }}
          className="px-1 py-0.5"
        >
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTitle(item.title);
                setEditing(false);
              }
            }}
            className="w-full rounded-lg border border-accent bg-background px-2 py-1.5 text-sm focus:outline-none focus-visible:outline-none"
          />
        </form>
      </li>
    );
  }

  const busy = pending || aiPending;

  // Members leave; only the owner deletes (owner decision 11).
  const leave = () => {
    if (!confirm(`Leave "${item.title}"? It will disappear from your list.`)) return;
    startTransition(async () => {
      onRemoved(item.id);
      await leaveChat(item.id);
    });
  };
  const openPeople = () =>
    window.dispatchEvent(new CustomEvent(PEOPLE_EVENT, { detail: { conversationId: item.id } }));

  return (
    <li
      draggable={!selectionMode}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-opninfer-chat", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      data-conversation={item.id}
      data-shared={item.shared ? "1" : "0"}
      data-mine={item.mine ? "1" : "0"}
      {...(item.unread ? { "data-unread": "1" } : {})}
      className={`group relative rounded-xl ${
        active ? "bg-surface-hover" : "hover:bg-surface-hover"
      } ${busy ? "opacity-60" : ""}`}
    >
      {selectionMode ? (
        <button
          type="button"
          onClick={onToggleSelect}
          className="flex w-full items-center gap-2.5 px-[11px] py-[6px] text-left"
        >
          <span
            className={`flex size-4 shrink-0 items-center justify-center rounded border ${
              selected ? "border-accent bg-accent text-accent-foreground" : "border-border"
            }`}
            aria-hidden="true"
          >
            {selected ? <CheckIcon /> : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.title}</span>
        </button>
      ) : (
        <>
          <Link
            href={`/chat/${item.id}`}
            className="flex items-center gap-2 px-[11px] py-[6px]"
            title={
              !item.mine && item.owner
                ? `${item.title} — shared by ${item.owner.name?.trim() || item.owner.email}`
                : item.title
            }
          >
            {/* Shared WITH you: the owner's face. Shared BY you: the people mark. */}
            {!item.mine && item.owner ? (
              <Avatar
                name={item.owner.name ?? undefined}
                email={item.owner.email}
                image={item.owner.image}
                className="h-4 w-4"
                textClassName="text-[8px]"
              />
            ) : item.shared ? (
              <span className="shrink-0 text-muted">
                <PeopleIcon className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <span
              className={`min-w-0 flex-1 truncate text-sm text-foreground ${
                active || item.unread ? "font-medium" : ""
              }`}
            >
              {item.title}
            </span>
            {item.unread ? (
              <span
                aria-label="New activity"
                className="h-2 w-2 shrink-0 rounded-full bg-accent transition-opacity group-hover:opacity-0"
              />
            ) : null}
            <span
              suppressHydrationWarning
              className="shrink-0 text-[10px] text-muted transition-opacity group-hover:opacity-0"
            >
              {relTime(item.updatedAt)}
            </span>
          </Link>

          <div
            className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-lg bg-gradient-to-l from-surface-hover from-60% to-transparent pl-6 ${
              busy ? "opacity-100" : "invisible group-hover:visible"
            } focus-within:visible`}
          >
            <RowMenu
              pinned={item.pinned}
              mine={item.mine}
              busy={busy}
              onPeople={openPeople}
              onLeave={leave}
              onStar={() =>
                startTransition(async () => {
                  onPatch(item.id, { pinned: !item.pinned });
                  await togglePin(item.id);
                })
              }
              onRename={() => setEditing(true)}
              onMoveToFolder={onMoveToFolder}
              onRenameAI={() => {
                setAiPending(true);
                (async () => {
                  const res = await renameConversationWithAI(item.id);
                  if (res.title) onPatch(item.id, { title: res.title });
                  setAiPending(false);
                })();
              }}
              onDownload={() => onDownload(item.id, item.title)}
              onSelect={onStartSelection}
              onDelete={() => {
                if (confirm(`Delete "${item.title}"? This can't be undone.`)) {
                  startTransition(async () => {
                    onRemoved(item.id);
                    await deleteConversations([item.id]);
                  });
                }
              }}
            />
          </div>
        </>
      )}
    </li>
  );
}

function FolderMenuIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 6.2c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.9 1c.2.2.5.4.8.4h6.2c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H3.6c-.6 0-1.1-.5-1.1-1.1V6.2Z" />
    </svg>
  );
}

interface RowMenuItem {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

/** Kebab (3 vertical dots) menu, portaled to <body> so the scroll box can't clip it. */
function RowMenu({
  pinned,
  mine,
  busy,
  onStar,
  onRename,
  onMoveToFolder,
  onRenameAI,
  onDownload,
  onPeople,
  onSelect,
  onDelete,
  onLeave,
}: {
  pinned: boolean;
  /** Your own chat (delete, select) vs one shared with you (leave). */
  mine: boolean;
  busy: boolean;
  onStar: () => void;
  onRename: () => void;
  onMoveToFolder: () => void;
  onRenameAI: () => void;
  onDownload: () => void;
  onPeople: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => document.addEventListener("mousedown", close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", close);
    };
  }, [open]);

  const items: RowMenuItem[] = [
    { label: pinned ? "Unstar" : "Star", icon: <StarIcon filled={pinned} />, onClick: onStar },
    { label: "Rename", icon: <PencilIcon />, onClick: onRename },
    { label: "Rename with AI", icon: <SparkleMenuIcon />, onClick: onRenameAI },
    { label: "Move to folder", icon: <FolderMenuIcon />, onClick: onMoveToFolder },
    { label: "Download", icon: <DownloadIcon />, onClick: onDownload },
    { label: "People", icon: <PeopleIcon className="h-4 w-4" />, onClick: onPeople },
    ...(mine
      ? [
          { label: "Select", icon: <SelectIcon />, onClick: onSelect },
          { label: "Delete", icon: <TrashIcon />, onClick: onDelete, danger: true },
        ]
      : [{ label: "Leave", icon: <LeaveIcon />, onClick: onLeave, danger: true }]),
  ];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Chat options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={toggle}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
      >
        <KebabIcon />
      </button>
      {open && mounted && pos
        ? createPortal(
            <div
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", top: pos.top, right: pos.right }}
              className="z-50 w-44 rounded-xl border border-border bg-background p-1 shadow-xl"
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover ${
                    it.danger ? "text-red-600 dark:text-red-400" : "text-foreground"
                  }`}
                >
                  <span className="shrink-0 text-muted">{it.icon}</span>
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

// --- icons -----------------------------------------------------------------
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

function ComposeIcon() {
  return (
    <svg {...stroke} className="h-[18px] w-[18px]">
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931ZM18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg {...stroke} className="h-[18px] w-[18px]">
      <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </svg>
  );
}
/** Admin (control panel) — deliberately distinct from the personal settings
 *  gear in the top-right account menu (sliders vs cog). */
function AdminIcon() {
  return (
    <svg {...stroke} className="h-[18px] w-[18px]" strokeWidth={1.8}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  );
}
function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}
function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.77l-5.2 2.73.99-5.79-4.21-4.1 5.82-.85z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg {...stroke} className="h-4 w-4" strokeWidth={1.8}>
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function SparkleMenuIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
      <path d="M18 15l.7 1.8L20.5 17l-1.8.7L18 19.5l-.7-1.8L15.5 17l1.8-.7z" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg {...stroke} className="h-4 w-4" strokeWidth={1.8}>
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}
function SelectIcon() {
  return (
    <svg {...stroke} className="h-4 w-4" strokeWidth={1.8}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg {...stroke} className="h-4 w-4" strokeWidth={1.8}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}
function LeaveIcon() {
  return (
    <svg {...stroke} className="h-4 w-4" strokeWidth={1.8}>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l5 4-5 4M20 12H9" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
