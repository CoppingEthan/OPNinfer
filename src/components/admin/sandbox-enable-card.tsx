"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveCapability } from "@/app/actions/tools";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import type { CapabilityView } from "./tools-forms";

/**
 * The Sandbox's card on Admin → Tools (owner ask, 2026-09-02): just the
 * switch. Everything else — credential, model, limits, plan usage, what the
 * agent reaches for — lives on its own Sandbox page, which appears in the
 * nav only while this is on. Saving here re-submits the STORED config
 * untouched, so flipping the switch never resets the settings (the generic
 * toggle card saves `{}`, which would).
 */
export function SandboxEnableCard({ cap }: { cap: CapabilityView }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(cap.enabled);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, start] = useTransition();

  const save = () => {
    setMsg({});
    start(async () => {
      const res = await saveCapability(cap.id, enabled, cap.config);
      setMsg(res);
      if (res.success) router.refresh();
    });
  };

  return (
    <div className="space-y-3" data-sandbox-enable-card>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        <span className="text-sm font-medium text-foreground">Enable for this workspace</span>
      </label>
      <p className="text-xs text-muted">
        {cap.enabled ? (
          <>
            Credential, model, limits, plan usage and what the agent reaches for are on the{" "}
            <Link href="/admin/sandbox" className="font-medium text-foreground underline underline-offset-2">
              Sandbox page
            </Link>
            .
          </>
        ) : (
          <>Once enabled, a Sandbox page appears in the menu with its settings and usage.</>
        )}
      </p>
      {msg.error ? <FormMessage error={msg.error} /> : null}
      {msg.success ? <FormMessage success={msg.success} /> : null}
      <Button onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
