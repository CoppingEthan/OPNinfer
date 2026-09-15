"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  createWorkflow,
  deleteWorkflow,
  leaveWorkflow,
  readWorkflow,
  renameWorkflow,
  saveWorkflow,
  searchWorkflowPeople,
  shareWorkflow,
  unshareWorkflow,
  workflowPeople,
  type WorkflowPerson,
} from "@/app/actions/workflows";
import type { WorkflowListItem } from "@/lib/workflow-store";
import { Avatar } from "@/components/chat/avatar";
import { useDialog } from "@/components/ui/dialog";

/**
 * The Workflows page: a list on the left, the markdown on the right.
 *
 * The body is edited as plain markdown in a textarea rather than through a
 * rich editor, and that is deliberate — the assistant reads this text
 * verbatim, so what you see needs to be exactly what it gets. A WYSIWYG layer
 * that quietly rewrote the source would make the two disagree.
 */

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export function WorkflowsView({ initial }: { initial: WorkflowListItem[] }) {
  const dialog = useDialog();
  const [list, setList] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, start] = useTransition();

  const selected = useMemo(() => list.find((w) => w.id === selectedId) ?? null, [list, selectedId]);

  // The editor's own copy, plus the stamp it was loaded at — the save refuses
  // if the stored row has moved on since.
  const [body, setBody] = useState("");
  const [description, setDescription] = useState("");
  const [seenAt, setSeenAt] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    setLoading(true);
    readWorkflow(selectedId).then((w) => {
      if (!live || !w) return;
      setBody(w.body);
      setDescription(w.description);
      setSeenAt(w.updatedAt);
      setDirty(false);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const refresh = (patch: Partial<WorkflowListItem>) => {
    if (!selectedId) return;
    setList((prev) => prev.map((w) => (w.id === selectedId ? { ...w, ...patch } : w)));
  };

  const onSave = () => {
    if (!selectedId) return;
    setMsg({});
    start(async () => {
      const res = await saveWorkflow(selectedId, body, description, seenAt);
      setMsg(res);
      if (res.success) {
        setDirty(false);
        const fresh = await readWorkflow(selectedId);
        if (fresh) setSeenAt(fresh.updatedAt);
        refresh({ description, updatedAt: new Date().toISOString() });
      }
    });
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ---- list ---- */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-sm font-semibold text-foreground">Workflows</h1>
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              const name = await dialog.prompt({
                title: "New workflow",
                body: "Name the JOB, not the document — the assistant matches requests against it.",
                label: "Name",
                placeholder: "Rewrite a document",
                maxLength: 60,
                confirmLabel: "Create",
              });
              if (!name?.trim()) return;
              start(async () => {
                const res = await createWorkflow(name);
                setMsg(res);
                if (res.id) {
                  const fresh = await readWorkflow(res.id);
                  setList((prev) => [
                    {
                      id: res.id!,
                      name: name.trim(),
                      description: fresh?.description ?? "",
                      sharedBy: null,
                      mine: true,
                      shared: false,
                      memberCount: 0,
                      updatedAt: new Date().toISOString(),
                      lastUsedAt: null,
                      notedAt: null,
                    },
                    ...prev,
                  ]);
                  setSelectedId(res.id);
                }
              });
            }}
            className="rounded-lg px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-surface-hover"
          >
            + New
          </button>
        </div>

        <p className="px-4 pb-3 text-xs leading-relaxed text-muted">
          Your own instructions for jobs you repeat. The assistant reads the name and
          description every time, and opens the full thing when a request matches.
        </p>

        <ul className="oi-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => setSelectedId(w.id)}
                data-workflow={w.id}
                className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${
                  w.id === selectedId ? "bg-surface-hover" : "hover:bg-surface-hover"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
                  {w.shared ? (
                    <span
                      title={w.mine ? `Shared with ${w.memberCount - 1}` : `Shared by ${w.sharedBy}`}
                      className="shrink-0 rounded-md bg-accent/15 px-1.5 py-px text-[10px] font-medium text-accent"
                    >
                      {w.mine ? "shared" : w.sharedBy}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">{w.description}</span>
                {w.lastUsedAt || w.notedAt ? (
                  <span className="mt-1 block text-[10px] text-muted/80">
                    {w.lastUsedAt ? `used ${ago(w.lastUsedAt)}` : null}
                    {w.lastUsedAt && w.notedAt ? " · " : null}
                    {w.notedAt ? `assistant added a note ${ago(w.notedAt)}` : null}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {list.length === 0 ? (
            <li className="px-2.5 py-6 text-center text-sm text-muted">
              None yet. Make one, or ask the assistant to save how you like something done.
            </li>
          ) : null}
        </ul>
      </aside>

      {/* ---- editor ---- */}
      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
            Pick a workflow, or make a new one.
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
                {selected.name}
              </h2>
              {selected.mine ? (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      const name = await dialog.prompt({
                        title: "Rename workflow",
                        label: "Name",
                        initial: selected.name,
                        maxLength: 60,
                        confirmLabel: "Rename",
                      });
                      if (!name?.trim() || name === selected.name) return;
                      start(async () => {
                        const res = await renameWorkflow(selected.id, name);
                        setMsg(res);
                        if (res.success) refresh({ name: name.trim() });
                      });
                    }}
                    className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={async () => {
                      if (
                        !(await dialog.confirm({
                          title: `Delete “${selected.name}”?`,
                          body: "This can't be undone. Anyone it is shared with loses it too.",
                          confirmLabel: "Delete",
                          danger: true,
                        }))
                      )
                        return;
                      start(async () => {
                        const res = await deleteWorkflow(selected.id);
                        setMsg(res);
                        if (res.success) {
                          setList((prev) => prev.filter((w) => w.id !== selected.id));
                          setSelectedId(null);
                        }
                      });
                    }}
                    className="rounded-lg px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={async () => {
                    if (
                      !(await dialog.confirm({
                        title: `Leave “${selected.name}”?`,
                        body: "It disappears from your list. The owner keeps it.",
                        confirmLabel: "Leave",
                        danger: true,
                      }))
                    )
                      return;
                    start(async () => {
                      const res = await leaveWorkflow(selected.id);
                      setMsg(res);
                      if (res.success) {
                        setList((prev) => prev.filter((w) => w.id !== selected.id));
                        setSelectedId(null);
                      }
                    });
                  }}
                  className="rounded-lg px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                >
                  Leave
                </button>
              )}
            </header>

            <div className="oi-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  When to use it
                </span>
                <input
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setDirty(true);
                  }}
                  maxLength={160}
                  placeholder="One line. The assistant sees this every message."
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted"
                />
              </label>

              <label className="block">
                <span className="mb-1 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted">
                  <span>The instructions</span>
                  <span className="font-normal normal-case tracking-normal">
                    markdown · {body.length.toLocaleString()} characters
                  </span>
                </span>
                <textarea
                  value={loading ? "" : body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck
                  rows={22}
                  className="oi-scroll w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-[13px] leading-relaxed text-foreground"
                />
              </label>

              {msg.error ? (
                <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                  {msg.error}
                </p>
              ) : null}
              {msg.success ? (
                <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg.success}</p>
              ) : null}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={pending || !dirty}
                  className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-40"
                >
                  {pending ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
                <span className="text-xs text-muted">
                  Anyone it is shared with can edit this, and the assistant may add notes
                  under its own heading.
                </span>
              </div>

              {selected.mine ? <SharePanel workflow={selected} onChanged={refresh} /> : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/** Who a workflow is shared with — the owner's view. */
function SharePanel({
  workflow,
  onChanged,
}: {
  workflow: WorkflowListItem;
  onChanged: (patch: Partial<WorkflowListItem>) => void;
}) {
  const [people, setPeople] = useState<{ owner: WorkflowPerson; members: WorkflowPerson[] } | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<WorkflowPerson[]>([]);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    workflowPeople(workflow.id).then((p) => live && setPeople(p));
    return () => {
      live = false;
    };
  }, [workflow.id]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      searchWorkflowPeople(workflow.id, query).then((r) => live && setFound(r));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [workflow.id, query]);

  const reload = () =>
    workflowPeople(workflow.id).then((p) => {
      setPeople(p);
      onChanged({ shared: (p?.members.length ?? 0) > 0, memberCount: (p?.members.length ?? 0) + 1 });
    });

  return (
    <div className="rounded-2xl border border-border p-4">
      <h3 className="mb-1 text-sm font-semibold text-foreground">Shared with</h3>
      <p className="mb-3 text-xs text-muted">
        One copy, not a copy each — anyone you add sees your edits, and you see theirs.
      </p>

      {people && people.members.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {people.members.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <Avatar name={p.name ?? undefined} email={p.email} image={p.image} className="h-6 w-6" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {p.name || p.email}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await unshareWorkflow(workflow.id, p.id);
                    await reload();
                  })
                }
                className="rounded-lg px-2 py-0.5 text-xs text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-muted">Nobody yet.</p>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add someone by name or email…"
        className="w-full rounded-xl border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted"
      />
      {found.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {found.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await shareWorkflow(workflow.id, [p.id]);
                    setQuery("");
                    await reload();
                  })
                }
                className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
              >
                <Avatar name={p.name ?? undefined} email={p.email} image={p.image} className="h-6 w-6" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {p.name || p.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
