"use client";

import Link from "next/link";
import { useActionState } from "react";
import { authenticate, type FormState } from "@/app/actions/auth";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export function LoginForm({
  callbackUrl,
  notice,
}: {
  callbackUrl: string;
  notice?: string;
}) {
  const [state, action] = useActionState<FormState, FormData>(authenticate, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      {notice ? <FormMessage success={notice} /> : null}

      {/* This account has never been signed in to, and the person has now
          failed several times — so a temporary password has been emailed
          rather than a reset LINK (owner ask, 2026-09-09: the links expire in
          an hour and these emails sit in quarantine for longer, so every one
          of them was found dead). The spam/quarantine line is the point of
          the whole notice: it is where the mail actually is. */}
      {state.recovery ? (
        <div
          data-recovery-notice
          className="rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm"
        >
          <p className="font-medium text-foreground">
            {state.recovery.emailed
              ? "We've emailed you a password"
              : "Your account needs a new password"}
          </p>
          {state.recovery.emailed ? (
            <>
              <p className="mt-1 text-muted">
                This is the first time this account has been used, so we&apos;ve sent a
                temporary password to <span className="text-foreground">{state.recovery.email}</span>.
                Sign in with it and you&apos;ll be asked to choose your own.
              </p>
              <p className="mt-2 text-muted">
                <span className="font-medium text-foreground">
                  Please check your spam and quarantine folders
                </span>{" "}
                — these emails are often held there. It does not expire, so it will still
                work whenever you find it.
              </p>
            </>
          ) : (
            <p className="mt-1 text-muted">
              This is the first time this account has been used and we couldn&apos;t send the
              email. Please ask your administrator for a password.
            </p>
          )}
        </div>
      ) : null}

      {state.error ? <FormMessage error={state.error} /> : null}

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="mb-1.5 text-sm text-accent hover:underline"
          >
            Forgot?
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <SubmitButton className="w-full" pendingText="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
