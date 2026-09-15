"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBackupNow, deleteBackup } from "@/app/actions/backup";
import type { BackupInfo } from "@/lib/backup";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { useDialog } from "@/components/ui/dialog";

interface RestoreSummary {
  appVersion: string;
  createdAt: string;
  restoredFiles: number;
  masterKeyMismatch: boolean;
  tables: Record<string, number>;
}

export function BackupManager({ backups }: { backups: BackupInfo[] }) {
  const dialog = useDialog();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});

  // Restore state machine: pick a file → confirm → uploading → summary.
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);

  const onCreate = () => {
    setMsg({});
    startTransition(async () => {
      const res = await createBackupNow();
      setMsg({ error: res.error, success: res.success });
      if (res.success) router.refresh();
    });
  };

  const onDelete = async (name: string) => {
    if (
      !(await dialog.confirm({
        title: `Delete backup “${name}”?`,
        body: "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    setMsg({});
    startTransition(async () => {
      const res = await deleteBackup(name);
      setMsg({ error: res.error });
      if (res.success) router.refresh();
    });
  };

  const onPickFile = (f: File | undefined) => {
    setRestoreError(null);
    setSummary(null);
    setPendingFile(f ?? null);
  };

  const cancelRestore = () => {
    setPendingFile(null);
    setRestoreError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const doRestore = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const res = await fetch("/api/admin/backup/restore", {
        method: "POST",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setRestoreError(data.error ?? "Restore failed.");
        return;
      }
      setSummary(data as RestoreSummary);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setRestoreError("Restore failed — could not reach the server.");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Create + list */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {backups.length} backup{backups.length === 1 ? "" : "s"} stored on the server.
          </p>
          <Button onClick={onCreate} disabled={pending || restoring}>
            {pending ? "Working…" : "Create backup now"}
          </Button>
        </div>

        {msg.error ? (
          <div className="mt-3">
            <FormMessage error={msg.error} />
          </div>
        ) : null}
        {msg.success ? (
          <div className="mt-3">
            <FormMessage success={msg.success} />
          </div>
        ) : null}

        <div className="mt-4 divide-y divide-border rounded-xl border border-border">
          {backups.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">
              No backups yet.
            </p>
          ) : (
            backups.map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-foreground">
                    {b.name}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDateTime(b.createdAt)} UTC · {formatBytes(b.sizeBytes)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <a
                    href={`/api/admin/backup/${encodeURIComponent(b.name)}`}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
                  >
                    Download
                  </a>
                  <button
                    onClick={() => onDelete(b.name)}
                    disabled={pending || restoring}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Restore */}
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-foreground">Restore from a zip</h3>
        <p className="mt-1 text-sm text-muted">
          Upload a backup zip to replace <strong>all</strong> current data and
          stored files with its contents. This cannot be undone.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0])}
        />

        {!pendingFile ? (
          <Button
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={restoring || pending}
            className="mt-3"
          >
            Choose backup zip…
          </Button>
        ) : (
          <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/5 p-4">
            <p className="text-sm text-foreground">
              Restore from{" "}
              <span className="font-mono text-xs">{pendingFile.name}</span> (
              {formatBytes(pendingFile.size)})?
            </p>
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              Every user, chat, credential, setting and file will be overwritten.
              If this backup was made with a different OPNINFER_MASTER_KEY, stored
              provider keys won&apos;t decrypt.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={doRestore}
                disabled={restoring}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {restoring ? "Restoring…" : "Restore & overwrite"}
              </Button>
              <Button variant="ghost" onClick={cancelRestore} disabled={restoring}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {restoreError ? (
          <div className="mt-3">
            <FormMessage error={restoreError} />
          </div>
        ) : null}

        {summary ? (
          <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
            <p className="font-medium text-emerald-700 dark:text-emerald-400">
              Restore complete.
            </p>
            <p className="mt-1 text-muted">
              From a v{summary.appVersion} backup taken{" "}
              {summary.createdAt !== "unknown"
                ? `${formatDateTime(summary.createdAt)} UTC`
                : "at an unknown time"}
              . Restored {summary.restoredFiles} stored file
              {summary.restoredFiles === 1 ? "" : "s"} and{" "}
              {Object.values(summary.tables).reduce((a, b) => a + b, 0)} database
              rows.
            </p>
            {summary.masterKeyMismatch ? (
              <p className="mt-2 text-amber-700 dark:text-amber-400">
                ⚠ This backup used a different master key — encrypted provider keys
                will fail to decrypt. Re-enter them in Admin → API.
              </p>
            ) : null}
            <p className="mt-2 text-muted">
              You may need to sign out and back in.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
