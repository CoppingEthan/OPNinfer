"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveBrandingColors,
  setBrandingLogo,
  clearBrandingLogo,
  type BrandingFormState,
} from "@/app/actions/admin";
import { Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

const DEFAULT_LIGHT = "#b74b7a";
const DEFAULT_DARK = "#d8769f";

export function BrandingForm({
  accent,
  accentDark,
  logo,
}: {
  accent?: string;
  accentDark?: string;
  logo?: string;
}) {
  const [state, action] = useActionState<BrandingFormState, FormData>(
    saveBrandingColors,
    {},
  );
  const [pending, startTransition] = useTransition();
  const [logoName, setLogoName] = useState<string | null>(logo ?? null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/branding", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setUploadError(data.error ?? "Upload failed.");
      return;
    }
    startTransition(async () => {
      await setBrandingLogo(data.name);
      setLogoName(data.name);
      router.refresh(); // update the live logo in headers/sidebar
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const onClearLogo = () =>
    startTransition(async () => {
      await clearBrandingLogo();
      setLogoName(null);
      router.refresh();
    });

  const onResetColors = () =>
    startTransition(async () => {
      await saveBrandingColors({}, new FormData());
      router.refresh();
    });

  return (
    <div className="space-y-8">
      {/* Logo */}
      <div>
        <h3 className="text-sm font-semibold text-foreground">Logo</h3>
        <p className="mt-1 text-sm text-muted">
          PNG or SVG, shown in the sidebar, header, and login screen. Max 2 MB.
        </p>
        <div className="mt-3 flex items-center gap-4">
          <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-border bg-surface px-3">
            {logoName ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/branding/${logoName}`}
                alt="Current logo"
                className="max-h-10 w-auto object-contain"
              />
            ) : (
              <span className="text-xs text-muted">Default</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
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
              disabled={pending}
            >
              {pending ? "Uploading…" : "Upload logo"}
            </Button>
            {logoName ? (
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
        {uploadError ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{uploadError}</p>
        ) : null}
      </div>

      {/* Accent colours */}
      <form action={action} className="space-y-4 border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-foreground">Accent colour</h3>
        {state.error ? <FormMessage error={state.error} /> : null}
        {state.success ? <FormMessage success={state.success} /> : null}

        <div className="flex flex-wrap gap-6">
          <div>
            <Label htmlFor="accent">Light theme</Label>
            <input
              id="accent"
              name="accent"
              type="color"
              defaultValue={accent || DEFAULT_LIGHT}
              className="h-10 w-20 cursor-pointer rounded-lg border border-border bg-background"
            />
          </div>
          <div>
            <Label htmlFor="accentDark">Dark theme</Label>
            <input
              id="accentDark"
              name="accentDark"
              type="color"
              defaultValue={accentDark || DEFAULT_DARK}
              className="h-10 w-20 cursor-pointer rounded-lg border border-border bg-background"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Saving…">Save colours</SubmitButton>
          <Button
            type="button"
            variant="ghost"
            onClick={onResetColors}
            disabled={pending}
          >
            Reset to default
          </Button>
        </div>
      </form>
    </div>
  );
}
