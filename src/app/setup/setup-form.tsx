"use client";

import { useActionState } from "react";
import { bootstrapAdmin, type FormState } from "@/app/actions/auth";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export function SetupForm() {
  const [state, action] = useActionState<FormState, FormData>(
    bootstrapAdmin,
    {},
  );

  return (
    <form action={action} className="space-y-4">
      {state.error ? <FormMessage error={state.error} /> : null}

      <div>
        <Label htmlFor="email">Admin email</Label>
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
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
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

      <SubmitButton className="w-full" pendingText="Creating…">
        Create admin account
      </SubmitButton>
    </form>
  );
}
