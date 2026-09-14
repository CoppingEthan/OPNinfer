"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type FormState } from "@/app/actions/auth";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export function ForgotForm() {
  const [state, action] = useActionState<FormState, FormData>(
    requestPasswordReset,
    {},
  );

  return (
    <form action={action} className="space-y-4">
      {state.success ? <FormMessage success={state.success} /> : null}
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

      <SubmitButton className="w-full" pendingText="Sending…">
        Send reset link
      </SubmitButton>

      <p className="text-center text-sm text-muted">
        <Link href="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
