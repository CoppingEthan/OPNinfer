"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { clearProfileImage } from "@/app/actions/profile";
import { deleteAllMyChats } from "@/app/actions/conversations";
import { Avatar } from "./avatar";

/**
 * Per-user account settings (spec §7/§9/§12): appearance (light/dark for this
 * user), a custom profile picture, and "delete all my chats". Opened from the
 * top-right settings gear; portaled + blurred like the search palette.
 */
export function UserSettingsModal({
  open,
  onClose,
  name,
  email,
  image,
}: {
  open: boolean;
  onClose: () => void;
  name?: string;
  email: string;
  image?: string | null;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [img, setImg] = useState<string | null>(image ?? null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const [deletedMsg, setDeletedMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => setImg(image ?? null), [image]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const upload = async (file: File | null | undefined) => {
    if (!file) return;
    setErr(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/avatar", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? "Upload failed.");
        return;
      }
      setImg(data.name);
      router.refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removePhoto = async () => {
    setImg(null);
    await clearProfileImage();
    router.refresh();
  };

  const deleteAll = () => {
    if (!confirm("Delete ALL of your chats? This can't be undone.")) return;
    startDelete(async () => {
      const res = await deleteAllMyChats();
      setDeletedMsg(`Deleted ${res.deleted} chat${res.deleted === 1 ? "" : "s"}.`);
      router.push("/chat");
      router.refresh();
    });
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
        onMouseDown={(e) => e.stopPropagation()}
        // Capped to the viewport with the body scrolling INSIDE the panel:
        // the memory section (four editable notes, 0.5.1) made the whole
        // thing taller than a laptop screen, and a fixed overlay can't
        // scroll the page behind it.
        className="flex w-full max-w-md max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="oi-scroll min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5" data-settings-body>
          {/* Appearance ------------------------------------------------------ */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Appearance
            </h3>
            <ThemeChoice />
          </section>

          {/* Profile picture ------------------------------------------------- */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Profile picture
            </h3>
            <div className="flex items-center gap-4">
              <Avatar name={name} email={email} image={img} className="h-14 w-14" textClassName="text-lg" />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                  {img ? (
                    <button
                      type="button"
                      onClick={removePhoto}
                      className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <p className="text-xs text-muted">PNG, JPG, WEBP or GIF · up to 3 MB.</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => void upload(e.target.files?.[0])}
              />
            </div>
            {err ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p> : null}
          </section>

          {/* Assistant memory ------------------------------------------------ */}
          <MemorySection open={open} />

          {/* Security -------------------------------------------------------- */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Security
            </h3>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Change password</p>
                <p className="text-xs text-muted">
                  No email needed. Changing it signs out every other device.
                </p>
              </div>
              {/* A plain link, not a nested form: the change screen ends the
                  session on success, which a modal is the wrong place to do. */}
              <a
                href="/change-password"
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
              >
                Change
              </a>
            </div>
          </section>

          {/* Data ------------------------------------------------------------ */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Data
            </h3>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Delete all chats</p>
                <p className="text-xs text-muted">
                  Removes every conversation from your account. Cannot be undone.
                </p>
                {deletedMsg ? (
                  <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">{deletedMsg}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={deleteAll}
                disabled={deleting}
                className="shrink-0 rounded-lg border border-red-500/30 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              >
                {deleting ? "Deleting…" : "Delete all"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface MemoryTopicView {
  key: string;
  label: string;
  hint: string;
  text: string;
  updatedAt: string | null;
}
interface MemorySnapshot {
  topics: MemoryTopicView[];
  paused: boolean;
  adminPaused: boolean;
  topicChars: number;
}
interface MemoryChatMsg {
  role: "user" | "assistant";
  content: string;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * "What the assistant knows about you" (memory v2): the four notes it keeps,
 * each editable in place; a pause switch (keep what it knows, stop learning);
 * reset; and a tiny chat for adjusting in words — one turn of the cheap
 * front-end model bound to the memory tools (`/api/memory`). The notes
 * refresh from the same response, so edits show instantly.
 */
function MemorySection({ open }: { open: boolean }) {
  const [snap, setSnap] = useState<MemorySnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [chat, setChat] = useState<MemoryChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const apply = (d: MemorySnapshot) => {
    setSnap(d);
    setDrafts(Object.fromEntries(d.topics.map((t) => [t.key, t.text])));
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/memory")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: MemorySnapshot) => {
        if (!cancelled && Array.isArray(d.topics)) apply(d);
      })
      .catch(() => {
        if (!cancelled) setSnap({ topics: [], paused: false, adminPaused: false, topicChars: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chat, busy]);

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await res.json()) as MemorySnapshot & { error?: string };
    if (!res.ok) throw new Error(d.error ?? "Couldn't save.");
    apply(d);
  };

  const saveTopic = async (key: string) => {
    setSaving(key);
    setError(null);
    try {
      await patch({ topic: key, text: drafts[key] ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(null);
    }
  };

  const togglePause = async () => {
    if (!snap) return;
    setError(null);
    try {
      await patch({ paused: !snap.paused });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
  };

  const reset = async () => {
    if (!confirm("Forget everything the assistant knows about you? This can't be undone.")) return;
    setError(null);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      const d = (await res.json()) as MemorySnapshot;
      if (res.ok) apply(d);
    } catch {
      setError("Couldn't reset.");
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setError(null);
    setInput("");
    const nextChat: MemoryChatMsg[] = [...chat, { role: "user", content }];
    setChat(nextChat);
    setBusy(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextChat.slice(-12) }),
      });
      const d = (await res.json()) as MemorySnapshot & { reply?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Something went wrong.");
      setChat((prev) => [...prev, { role: "assistant", content: String(d.reply ?? "Done.") }]);
      if (Array.isArray(d.topics)) apply(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setChat(chat); // roll the failed turn back so it can be retried
      setInput(content);
    } finally {
      setBusy(false);
    }
  };

  const empty = !!snap && snap.topics.every((t) => !t.text.trim());

  return (
    <section data-memory-section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          Assistant memory
        </h3>
        {snap ? (
          <label className="flex items-center gap-2 text-xs text-muted" title="Keeps what it knows, stops it learning anything new">
            <input
              type="checkbox"
              checked={snap.paused}
              onChange={() => void togglePause()}
              data-memory-paused={snap.paused ? "1" : "0"}
              className="h-3.5 w-3.5 accent-accent"
            />
            Pause learning
          </label>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-muted">
        Four short notes the assistant keeps about you and reads in every chat. It updates them
        itself from what you tell it — quietly, once a chat has been idle for half an hour — and
        you can edit them here. Nothing from incognito or shared chats is ever kept.
        {snap?.adminPaused ? " Learning is currently paused for everyone by your admin." : ""}
      </p>
      <div className="rounded-xl border border-border">
        <div className="divide-y divide-border/70">
          {snap === null ? (
            <p className="px-3.5 py-2.5 text-xs text-muted">Loading…</p>
          ) : (
            snap.topics.map((t) => {
              const dirty = (drafts[t.key] ?? "") !== t.text;
              return (
                <div key={t.key} className="px-3.5 py-2.5" data-memory-topic={t.key}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{t.label}</span>
                    <span className="text-[11px] text-muted">
                      {t.updatedAt ? `updated ${ago(t.updatedAt)}` : "nothing yet"}
                    </span>
                  </div>
                  <textarea
                    value={drafts[t.key] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.key]: e.target.value }))}
                    placeholder={t.hint}
                    rows={Math.min(6, Math.max(2, (drafts[t.key] ?? "").split("\n").length))}
                    maxLength={snap.topicChars || undefined}
                    aria-label={t.label}
                    className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
                  />
                  {dirty ? (
                    <div className="mt-1 flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setDrafts((d) => ({ ...d, [t.key]: t.text }))}
                        className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground"
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveTopic(t.key)}
                        disabled={saving === t.key}
                        data-memory-save={t.key}
                        className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-50"
                      >
                        {saving === t.key ? "Saving…" : "Save"}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {snap && empty ? (
            <p className="px-3.5 py-2 text-xs text-muted">
              Nothing yet — it will fill these in from your chats, or tell it things to remember.
            </p>
          ) : null}
        </div>

        <div className="border-t border-border">
          {chat.length > 0 ? (
            <div className="oi-scroll max-h-40 space-y-2 overflow-y-auto px-3.5 py-2.5">
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-1.5 text-xs ${
                      m.role === "user"
                        ? "bg-accent/10 text-foreground"
                        : "bg-surface text-foreground"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {busy ? <p className="text-xs italic text-muted">Adjusting…</p> : null}
              <div ref={chatEndRef} />
            </div>
          ) : null}
          <div className="flex items-center gap-2 px-3.5 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder='Chat to adjust — e.g. "forget my old job title"'
              aria-label="Adjust assistant memory"
              disabled={busy}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted/70 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send memory adjustment"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-opacity disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5">
            {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : <span />}
            <button
              type="button"
              onClick={() => void reset()}
              disabled={!snap || empty}
              data-memory-reset
              className="text-xs text-muted underline-offset-2 hover:text-red-600 hover:underline disabled:opacity-40 dark:hover:text-red-400"
            >
              Forget everything
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Light / Dark segmented control (per-user, persisted by next-themes). */
function ThemeChoice() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? resolvedTheme : undefined;

  const opts: { key: string; label: string; icon: ReactNodeLike }[] = [
    { key: "light", label: "Light", icon: <SunIcon /> },
    { key: "dark", label: "Dark", icon: <MoonIcon /> },
  ];

  return (
    <div className="inline-flex rounded-xl border border-border bg-surface p-1">
      {opts.map((o) => {
        const active = current === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => setTheme(o.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type ReactNodeLike = React.ReactNode;

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
