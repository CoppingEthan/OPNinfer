"use client";

import { useActionState } from "react";
import { acceptInvite, type FormState } from "@/app/actions/auth";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export function InviteForm({ token }: { token: string }) {
  const action = acceptInvite.bind(null, token);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormMessage error={state.error} /> : null}

      <div>
        <Label htmlFor="password">Choose a password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
      </div>

      <SubmitButton className="w-full" pendingText="Setting up…">
        Create account
      </SubmitButton>
    </form>
  );
}
