"use client";

import { useActionState } from "react";
import { changeOwnPassword, type ChangePasswordState } from "@/app/actions/profile";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

/**
 * Change your own password.
 *
 * A plain form action, deliberately — the same shape as the reset form next
 * door. An earlier version intercepted `onSubmit` in the client, and a click
 * that landed before React hydrated made the browser submit natively as a
 * GET: the password ended up in the address bar, the history and the server
 * log. A form action is a POST whether or not the page has hydrated.
 *
 * There is no success branch to render: the action ends the session and
 * redirects to the sign-in screen, which says "Password updated — please sign
 * in." That is also what stops the temporary password the admin knows from
 * working anywhere else.
 */
export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, formAction] = useActionState<ChangePasswordState, FormData>(
    changeOwnPassword,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormMessage error={state.error} /> : null}

      <div>
        <Label htmlFor="current">
          {forced ? "The password you were given" : "Current password"}
        </Label>
        <Input
          id="current"
          name="current"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      <div>
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <SubmitButton className="w-full" pendingText="Updating…">
        Update password
      </SubmitButton>

      <p className="text-center text-xs text-muted">
        {forced
          ? "You can't use the assistant until this is done. You'll sign in again with your new password."
          : "You'll be signed out everywhere and can sign back in with the new password."}
      </p>
    </form>
  );
}
