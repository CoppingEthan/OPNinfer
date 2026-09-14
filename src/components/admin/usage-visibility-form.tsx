"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveUsageVisibility } from "@/app/actions/prefs";
import type { UsageVisibility } from "@/lib/prefs";
import { fieldCls } from "./ui";

const OPTIONS: { value: UsageVisibility; label: string }[] = [
  { value: "admins", label: "Admins only" },
  { value: "everyone", label: "Everyone" },
  { value: "off", label: "Nobody" },
];

/**
 * Customise tab: who sees the in-chat token/cost line under each reply. Defaults
 * to admins-only so end users don't see raw token counts and prices.
 */
export function UsageVisibilityForm({ value }: { value: UsageVisibility }) {
  const router = useRouter();
  const [v, setV] = useState<UsageVisibility>(value);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const onChange = (next: UsageVisibility) => {
    setV(next);
    setSaved(false);
    startTransition(async () => {
      const res = await saveUsageVisibility(next);
      if (res.success) {
        setSaved(true);
        router.refresh();
      }
    });
  };

  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        Token &amp; cost stats in chat
      </label>
      <select
        value={v}
        onChange={(e) => onChange(e.target.value as UsageVisibility)}
        disabled={pending}
        className={`${fieldCls} max-w-xs`}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-muted">
        Shows input/output tokens and the price under each reply.{" "}
        {saved ? (
          <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>
        ) : null}
      </p>
    </div>
  );
}
