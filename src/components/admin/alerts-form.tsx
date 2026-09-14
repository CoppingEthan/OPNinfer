"use client";

import { useActionState, useState } from "react";
import {
  saveAlertSettings,
  sendAlertTest,
  type SmtpFormState,
} from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export interface AlertDefaults {
  enabled: boolean;
  email: string;
  throttleMinutes: number;
  smtpConfigured: boolean;
}

export function AlertsForm({ defaults }: { defaults: AlertDefaults }) {
  const [saveState, saveAction] = useActionState<SmtpFormState, FormData>(
    saveAlertSettings,
    {},
  );
  const [testState, testAction] = useActionState<SmtpFormState, FormData>(
    sendAlertTest,
    {},
  );
  // Kept in state so the test button can post the address the admin is
  // currently typing, not only what was last saved.
  const [email, setEmail] = useState(defaults.email);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {defaults.smtpConfigured
          ? "Email someone whenever the portal logs an error, so problems surface without anyone watching the logs."
          : "Configure SMTP above first — error alerts need a working mail server."}
      </p>

      <form action={saveAction} className="space-y-4">
        {saveState.error ? <FormMessage error={saveState.error} /> : null}
        {saveState.success ? <FormMessage success={saveState.success} /> : null}

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            name="alertsEnabled"
            defaultChecked={defaults.enabled}
            className="h-4 w-4 rounded border-border text-accent focus:ring-ring"
          />
          Email me when an error occurs
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="alert-email">Send alerts to</Label>
            <Input
              id="alert-email"
              name="alertEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <Label htmlFor="alert-throttle">Don&rsquo;t repeat the same error for</Label>
            <div className="flex items-center gap-2">
              <Input
                id="alert-throttle"
                name="throttleMinutes"
                type="number"
                min={1}
                max={1440}
                defaultValue={defaults.throttleMinutes}
                className="w-28"
              />
              <span className="text-sm text-muted">minutes</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted">
          Repeats of the same error are counted and reported on the next alert
          that goes out, and no more than 12 alert emails are sent in any hour —
          so a failure loop can&rsquo;t flood your inbox.
        </p>

        <SubmitButton pendingText="Saving…">Save alert settings</SubmitButton>
      </form>

      <form action={testAction} className="border-t border-border pt-5">
        {testState.error ? <FormMessage error={testState.error} /> : null}
        {testState.success ? <FormMessage success={testState.success} /> : null}
        <input type="hidden" name="alertEmail" value={email} />
        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Sending…">Send a test alert</SubmitButton>
          <span className="text-xs text-muted">
            Shows exactly what an error email looks like.
          </span>
        </div>
      </form>
    </div>
  );
}
