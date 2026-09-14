"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveAssistantIdentity,
  setAssistantLogo,
  clearAssistantLogo,
} from "@/app/actions/assistant";
import { Button } from "@/components/ui/button";
import { fieldCls } from "./ui";

/**
 * Customise tab: the assistant's user-facing identity — its name and logo
 * (the "[Company] AI Assistant" branding). The model bindings live under Models.
 */
export function AssistantIdentityForm({
  name: initialName,
  logo: initialLogo,
}: {
  name: string;
  logo?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [logo, setLogo] = useState<string | undefined>(initialLogo);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () =>
    startTransition(async () => {
      setMsg({});
      const res = await saveAssistantIdentity({ name });
      setMsg(res);
      if (res.success) router.refresh();
    });

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setMsg({});
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/branding", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ error: data.error ?? "Logo upload failed." });
        return;
      }
      await setAssistantLogo(data.name);
      setLogo(data.name);
      router.refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onClearLogo = () =>
    startTransition(async () => {
      await clearAssistantLogo();
      setLogo(undefined);
      router.refresh();
    });

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Assistant name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme AI Assistant"
          className={`${fieldCls} max-w-md`}
        />
        <p className="mt-1 text-xs text-muted">
          Shown in the chat header and greeting — the name your users see.
        </p>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
          Assistant logo
        </span>
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-background">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/branding/${logo}`}
                alt=""
                className="max-h-10 max-w-10 object-contain"
              />
            ) : (
              <span className="text-xs text-muted">None</span>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".svg,.png,.jpg,.jpeg,.webp,.gif,image/*"
            className="hidden"
            onChange={(e) => void onLogo(e.target.files?.[0])}
          />
          <Button
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || pending}
          >
            {uploading ? "Uploading…" : "Upload"}
          </Button>
          {logo ? (
            <Button
              variant="ghost"
              onClick={onClearLogo}
              disabled={pending}
              className="text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || uploading}>
          {pending ? "Saving…" : "Save identity"}
        </Button>
        {msg.error ? (
          <span className="text-sm text-red-600 dark:text-red-400">{msg.error}</span>
        ) : null}
        {msg.success ? (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">{msg.success}</span>
        ) : null}
      </div>
    </div>
  );
}
