"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveMaxUploadMb } from "@/app/actions/prefs";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { fieldCls } from "./ui";

/**
 * Customise tab: per-file upload size limit. Enforced server-side while the
 * upload streams — this is the admin knob, not a client-side hint.
 */
export function UploadLimitForm({ currentMb }: { currentMb: number }) {
  const router = useRouter();
  const [mb, setMb] = useState(currentMb);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    setMsg({});
    startTransition(async () => {
      const res = await saveMaxUploadMb(mb);
      setMsg({ error: res.error, success: res.success });
      if (res.success) router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <label className="block max-w-xs">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Max upload size (MB per file)
        </span>
        <input
          type="number"
          min={1}
          max={2048}
          value={mb}
          onChange={(e) => setMb(Number(e.target.value))}
          className={fieldCls}
        />
      </label>
      <p className="text-xs text-muted">
        Applies to every user, any file type. Enforced while the upload streams,
        so oversized files are rejected without buffering.
      </p>
      {msg.error ? <FormMessage error={msg.error} /> : null}
      {msg.success ? <FormMessage success={msg.success} /> : null}
      <Button onClick={onSave} disabled={pending}>
        {pending ? "Saving…" : "Save limit"}
      </Button>
    </div>
  );
}
