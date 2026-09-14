"use client";

import { useActionState } from "react";
import {
  saveSmtpSettings,
  sendTestEmail,
  type SmtpFormState,
} from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export interface SmtpDefaults {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  hasPassword: boolean;
  source: "settings" | "env" | "none";
}

export function SmtpForm({ defaults }: { defaults: SmtpDefaults }) {
  const [saveState, saveAction] = useActionState<SmtpFormState, FormData>(
    saveSmtpSettings,
    {},
  );
  const [testState, testAction] = useActionState<SmtpFormState, FormData>(
    sendTestEmail,
    {},
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {defaults.source === "env"
          ? "Currently configured from environment variables. Saving here overrides them."
          : defaults.source === "settings"
            ? "Configured in the database."
            : "No SMTP configured — invites and resets are logged to the server console."}
      </p>

      <form action={saveAction} className="space-y-4">
        {saveState.error ? <FormMessage error={saveState.error} /> : null}
        {saveState.success ? <FormMessage success={saveState.success} /> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="smtp-host">Host</Label>
            <Input id="smtp-host" name="host" defaultValue={defaults.host} placeholder="smtp.example.com" required />
          </div>
          <div>
            <Label htmlFor="smtp-port">Port</Label>
            <Input id="smtp-port" name="port" type="number" defaultValue={defaults.port} required />
          </div>
          <div>
            <Label htmlFor="smtp-user">Username</Label>
            <Input id="smtp-user" name="username" defaultValue={defaults.username} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="smtp-pass">Password</Label>
            <Input
              id="smtp-pass"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={defaults.hasPassword ? "•••••• (unchanged)" : ""}
            />
          </div>
          <div>
            <Label htmlFor="smtp-from">From address</Label>
            <Input id="smtp-from" name="from" type="email" defaultValue={defaults.from} placeholder="OPNinfer <noreply@example.com>" required />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="secure"
              defaultChecked={defaults.secure}
              className="h-4 w-4 rounded border-border text-accent focus:ring-ring"
            />
            Use TLS (port 465)
          </label>
        </div>

        <SubmitButton pendingText="Saving…">Save SMTP settings</SubmitButton>
      </form>

      <form action={testAction} className="border-t border-border pt-5">
        {testState.error ? <FormMessage error={testState.error} /> : null}
        {testState.success ? <FormMessage success={testState.success} /> : null}
        <Label htmlFor="smtp-test">Send a test email</Label>
        <div className="flex gap-2">
          <Input id="smtp-test" name="to" type="email" placeholder="you@example.com" required />
          <SubmitButton pendingText="Sending…">Test-send</SubmitButton>
        </div>
      </form>
    </div>
  );
}
