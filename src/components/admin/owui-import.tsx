"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";

type ImportSummary = {
  usersCreated: number;
  usersMatched: number;
  usersSkipped: number;
  chatsImported: number;
  chatsSkippedExisting: number;
  chatsEmpty: number;
  chatsUnknownOwner: number;
  messagesImported: number;
  memoriesImported: number;
  memoriesSkipped: number;
  attachmentsNotImported: number;
};

/**
 * Backups tab: one-off migration from Open WebUI. Upload the `webui.db` from
 * an OWUI backup; users/chats/memories are imported additively (existing
 * emails and chat ids are skipped, so re-running is safe).
 */
export function OwuiImport() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<ImportSummary>();

  const onImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose the webui.db file first.");
      return;
    }
    setError(undefined);
    setSummary(undefined);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/import/owui", {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error ?? `Import failed (HTTP ${res.status}).`);
      }
      setSummary(data as ImportSummary);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Migrate an Open WebUI instance: upload its <code>webui.db</code> (from
        the OWUI data directory or a backup). Users are created with a random
        password and a verified email — tell them to use{" "}
        <span className="font-medium">Forgot password</span> on the login page
        to set their own (SMTP must be configured). Each chat&apos;s visible
        thread and every user memory come across; file attachments don&apos;t.
        Safe to re-run: existing users and already-imported chats are skipped.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".db,application/octet-stream,application/x-sqlite3"
        className="block text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
      />
      {error ? <FormMessage error={error} /> : null}
      {summary ? (
        <div className="rounded-xl border border-border bg-background/50 p-3 text-xs text-muted">
          <p className="mb-1 font-medium text-foreground">Import complete</p>
          <ul className="space-y-0.5">
            <li>
              Users: {summary.usersCreated} created ·{" "}
              {summary.usersMatched} already existed
              {summary.usersSkipped ? ` · ${summary.usersSkipped} skipped (no email)` : ""}
            </li>
            <li>
              Chats: {summary.chatsImported} imported (
              {summary.messagesImported} messages)
              {summary.chatsSkippedExisting ? ` · ${summary.chatsSkippedExisting} already imported` : ""}
              {summary.chatsEmpty ? ` · ${summary.chatsEmpty} empty` : ""}
              {summary.chatsUnknownOwner ? ` · ${summary.chatsUnknownOwner} ownerless` : ""}
            </li>
            <li>
              Memories: {summary.memoriesImported} imported
              {summary.memoriesSkipped ? ` · ${summary.memoriesSkipped} skipped` : ""}
            </li>
            {summary.attachmentsNotImported ? (
              <li>
                {summary.attachmentsNotImported} message attachment
                {summary.attachmentsNotImported === 1 ? "" : "s"} not imported
                (files don&apos;t migrate — the message text survives).
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <Button onClick={onImport} disabled={busy}>
        {busy ? "Uploading & importing… (large files take a while)" : "Import from Open WebUI"}
      </Button>
    </div>
  );
}
