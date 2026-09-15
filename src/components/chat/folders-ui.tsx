"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Folder pieces for the sidebar. Kept out of `sidebar.tsx` because that file
 * is already long; the chat rows themselves stay there and are passed in as
 * children.
 *
 * Two ways in, on purpose. Drag-and-drop is what people reach for first, and
 * a small picker dialog is what works on a phone, with a trackpad, and for
 * anyone who would rather not drag — the kebab route is not a fallback, it is
 * the accessible one.
 */

export interface FolderItem {
  id: string;
  name: string;
}

const OPEN_KEY = "oi-folders-open";

/** Which folders are expanded, remembered per browser like the sidebar width. */
export function useOpenFolders() {
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      if (raw) setOpen(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* private window, or nonsense in storage — start collapsed */
    }
  }, []);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      } catch {
        /* nothing worth failing a click over */
      }
      return next;
    });
  };

  return { open, toggle, setOpen };
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {open ? (
        <path d="M2.5 7.5V5.2c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.9 1c.2.2.5.4.8.4h4.2c.6 0 1.1.5 1.1 1.1v.5M2.5 7.5h13.9c.7 0 1.2.7 1 1.4l-1.4 5.4c-.1.5-.6.8-1.1.8H3.6c-.6 0-1.1-.5-1.1-1.1V7.5Z" />
      ) : (
        <path d="M2.5 6.2c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.9 1c.2.2.5.4.8.4h6.2c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H3.6c-.6 0-1.1-.5-1.1-1.1V6.2Z" />
      )}
    </svg>
  );
}

/**
 * One folder in the sidebar: a header that expands, accepts a dragged chat,
 * and carries its own rename/delete menu.
 */
export function FolderSection({
  folder,
  count,
  open,
  onToggle,
  onRename,
  onDelete,
  onDropChat,
  children,
}: {
  folder: FolderItem;
  count: number;
  open: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDropChat: (conversationId: string) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);

  return (
    <div data-folder={folder.id} data-folder-open={open ? "1" : "0"}>
      <div
        onDragOver={(e) => {
          // Without preventDefault the browser refuses the drop entirely.
          if (e.dataTransfer.types.includes("text/x-opninfer-chat")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData("text/x-opninfer-chat");
          if (id) onDropChat(id);
        }}
        className={`group flex items-center gap-1.5 rounded-xl px-2 py-1.5 transition-colors ${
          over ? "bg-accent/15 ring-1 ring-accent" : "hover:bg-surface-hover"
        }`}
      >
        {editing ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = draft.trim();
              setEditing(false);
              if (name && name !== folder.name) onRename(name);
              else setDraft(folder.name);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                setDraft(folder.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(folder.name);
                }
              }}
              className="w-full rounded-lg border border-border bg-surface px-1.5 py-0.5 text-xs font-semibold text-foreground"
            />
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <ChevronIcon open={open} />
              <span className="text-muted">
                <FolderIcon open={open} />
              </span>
              <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">
                {folder.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted/70">{count}</span>
            </button>
            <FolderMenu
              onRename={() => {
                setDraft(folder.name);
                setEditing(true);
              }}
              onDelete={onDelete}
            />
          </>
        )}
      </div>
      {open ? <ul className="mt-0.5 space-y-0.5 pl-3">{children}</ul> : null}
    </div>
  );
}

function FolderMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Folder options"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt({ x: r.right, y: r.bottom + 4 });
          setOpen((v) => !v);
        }}
        className="invisible shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-surface hover:text-foreground group-hover:visible"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
          <circle cx="8" cy="3" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>
      {open && at
        ? createPortal(
            <div
              style={{ top: at.y, left: at.x }}
              onClick={(e) => e.stopPropagation()}
              className="fixed z-50 min-w-36 -translate-x-full rounded-xl border border-border bg-surface p-1 shadow-lg"
            >
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onRename();
                }}
                className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
              >
                Delete folder
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The pick-a-folder dialog, for the kebab route and for multi-select.
 * Deliberately a plain centred dialog rather than a nested menu: a submenu
 * inside an already-portaled menu is a fiddly thing to get right and a worse
 * thing to use on a touchscreen.
 */
export function FolderPicker({
  open,
  folders,
  currentId,
  count,
  onPick,
  onCreate,
  onClose,
}: {
  open: boolean;
  folders: FolderItem[];
  currentId?: string | null;
  /** How many chats are being moved, so the title can say so. */
  count: number;
  onPick: (folderId: string | null) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Move to folder"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-4 shadow-xl"
      >
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Move {count > 1 ? `${count} chats` : "chat"} to…
        </h2>

        <div className="oi-scroll max-h-64 space-y-0.5 overflow-y-auto">
          {folders.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">
              No folders yet — make one below.
            </p>
          ) : (
            folders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onPick(f.id)}
                disabled={f.id === currentId}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-hover disabled:opacity-40"
              >
                <span className="text-muted">
                  <FolderIcon open={false} />
                </span>
                <span className="truncate">{f.name}</span>
                {f.id === currentId ? (
                  <span className="ml-auto text-xs text-muted">already here</span>
                ) : null}
              </button>
            ))
          )}
          {currentId ? (
            <button
              type="button"
              onClick={() => onPick(null)}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-hover"
            >
              Remove from folder
            </button>
          ) : null}
        </div>

        <form
          className="mt-3 flex gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (n) onCreate(n);
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New folder…"
            className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="shrink-0 rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-40"
          >
            Create
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
