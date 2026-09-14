"use client";

import { useState, useTransition } from "react";
import { deleteCredential, updateCredential } from "@/app/actions/credentials";
import { formatDate } from "@/lib/format";
import { providerLabel } from "@/lib/providers/labels";
import type { ProviderId } from "@/lib/providers/types";
import { Button } from "@/components/ui/button";
import { fieldCls } from "@/components/admin/ui";

export interface CredentialItem {
  id: string;
  provider: ProviderId;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export function CredentialList({ items }: { items: CredentialItem[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
        No keys yet. Add one above to start chatting.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <CredentialRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function CredentialRow({ item }: { item: CredentialItem }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-4 py-3">
        <EditForm item={item} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{item.label}</p>
        <p className="text-xs text-muted">
          {providerLabel(item.provider)} ·{" "}
          {item.lastUsedAt ? `last used ${formatDate(item.lastUsedAt)}` : "never used"}
        </p>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              startTransition(async () => {
                await deleteCredential(item.id);
                setConfirming(false);
              })
            }
            disabled={pending}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {pending ? "Removing…" : "Remove"}
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            onClick={() => setConfirming(true)}
            className="text-red-600 hover:bg-red-500/10 dark:text-red-400"
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

function EditForm({ item, onDone }: { item: CredentialItem; onDone: () => void }) {
  const [label, setLabel] = useState(item.label);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      setError(null);
      setOk(null);
      const res = await updateCredential(item.id, {
        label: label.trim() || undefined,
        secret: secret.trim() || undefined,
      });
      if (res.error) setError(res.error);
      else {
        setOk(res.success ?? "Saved.");
        setSecret("");
        // Close shortly after a successful save so the list refreshes.
        setTimeout(onDone, 600);
      }
    });

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={fieldCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Replace key
          </span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Leave blank to keep current key"
            autoComplete="off"
            className={fieldCls}
          />
        </label>
      </div>
      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {ok ? <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{ok}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
