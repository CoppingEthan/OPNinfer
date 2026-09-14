"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBackupConfig } from "@/app/actions/backup";
import type { BackupConfig } from "@/lib/backup";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { fieldCls } from "./ui";

export function BackupConfigForm({ config }: { config: BackupConfig }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(config.enabled);
  const [frequency, setFrequency] = useState(config.frequency);
  const [hourUtc, setHourUtc] = useState(config.hourUtc);
  const [retention, setRetention] = useState(config.retention);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    setMsg({});
    startTransition(async () => {
      const res = await saveBackupConfig({ enabled, frequency, hourUtc, retention });
      setMsg({ error: res.error, success: res.success });
      if (res.success) router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        <span className="text-sm font-medium text-foreground">
          Automatically back up on a schedule
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Frequency
          </span>
          <select
            value={frequency}
            disabled={!enabled}
            onChange={(e) => setFrequency(e.target.value as BackupConfig["frequency"])}
            className={fieldCls}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Hour (UTC)
          </span>
          <input
            type="number"
            min={0}
            max={23}
            value={hourUtc}
            disabled={!enabled}
            onChange={(e) => setHourUtc(Number(e.target.value))}
            className={fieldCls}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Keep last
          </span>
          <input
            type="number"
            min={1}
            max={365}
            value={retention}
            disabled={!enabled}
            onChange={(e) => setRetention(Number(e.target.value))}
            className={fieldCls}
          />
        </label>
      </div>

      <p className="text-xs text-muted">
        Older backups beyond the retention count are pruned automatically.
        {config.lastRunAt ? (
          <> Last automatic backup: {formatDateTime(config.lastRunAt)} UTC.</>
        ) : (
          <> No automatic backup has run yet.</>
        )}
      </p>

      {msg.error ? <FormMessage error={msg.error} /> : null}
      {msg.success ? <FormMessage success={msg.success} /> : null}

      <Button onClick={onSave} disabled={pending}>
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </div>
  );
}
