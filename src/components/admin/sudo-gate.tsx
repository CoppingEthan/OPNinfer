"use client";

import { useActionState } from "react";
import { confirmSudo, lockSudo, type SudoFormState } from "@/app/actions/admin-chats";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

/**
 * Password re-entry before the chat viewer opens. Deliberate friction: this is
 * the one admin surface that reads other people's private conversations.
 */
export function SudoGate({ minutes }: { minutes: number }) {
  const [state, action] = useActionState<SudoFormState, FormData>(confirmSudo, {});

  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border bg-surface p-6">
      <div className="mb-4 flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-hover text-foreground"
        >
          <LockIcon />
        </span>
        <div>
          <h2 className="text-base font-semibold text-foreground">Confirm it&rsquo;s you</h2>
          <p className="text-sm text-muted">
            This section shows other people&rsquo;s conversations.
          </p>
        </div>
      </div>

      <p className="mb-4 text-sm text-muted">
        Re-enter your password to unlock it for {minutes} minutes. Every chat you
        open is recorded in the audit log against your account.
      </p>

      <form action={action} className="space-y-3">
        {state.error ? <FormMessage error={state.error} /> : null}
        <div>
          <Label htmlFor="sudo-password">Your password</Label>
          <Input
            id="sudo-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>
        <SubmitButton pendingText="Checking…">Unlock</SubmitButton>
      </form>
    </div>
  );
}

/** Shown once unlocked: how long is left, and a way to lock again early. */
export function SudoBanner({ expiresAt }: { expiresAt: number }) {
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
      <p className="text-sm text-amber-700 dark:text-amber-400">
        Unlocked for about {minutes} more minute{minutes === 1 ? "" : "s"}. Chats you
        open are logged against your account.
      </p>
      <form action={lockSudo}>
        <button
          type="submit"
          className="rounded-lg px-2.5 py-1 text-sm font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
        >
          Lock now
        </button>
      </form>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
