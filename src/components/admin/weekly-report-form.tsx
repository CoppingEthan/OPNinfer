"use client";

import { useActionState, useState } from "react";
import {
  saveWeeklyReportSettings,
  sendWeeklyReportNow,
  type SmtpFormState,
} from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export interface WeeklyReportDefaults {
  enabled: boolean;
  email: string;
  weekday: string;
  hourLocal: number;
  timeZone: string;
  lastRunAt?: string;
  smtpConfigured: boolean;
}

const WEEKDAY_LABELS: [string, string][] = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
];

export function WeeklyReportForm({ defaults }: { defaults: WeeklyReportDefaults }) {
  const [saveState, saveAction] = useActionState<SmtpFormState, FormData>(
    saveWeeklyReportSettings,
    {},
  );
  const [testState, testAction] = useActionState<SmtpFormState, FormData>(
    sendWeeklyReportNow,
    {},
  );
  // Kept in state so "Send one now" uses the address being typed, not just
  // whatever was last saved (same reasoning as the alerts form).
  const [email, setEmail] = useState(defaults.email);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {defaults.smtpConfigured
          ? "A weekly digest of spend, errors and system health — so you can see how the month is tracking without opening the dashboard."
          : "Configure SMTP above first — the weekly report needs a working mail server."}
      </p>

      <form action={saveAction} className="space-y-4">
        {saveState.error ? <FormMessage error={saveState.error} /> : null}
        {saveState.success ? <FormMessage success={saveState.success} /> : null}

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            name="reportEnabled"
            defaultChecked={defaults.enabled}
            className="h-4 w-4 rounded border-border text-accent focus:ring-ring"
          />
          Email me a weekly report
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <Label htmlFor="report-email">Send the report to</Label>
            <Input
              id="report-email"
              name="reportEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <Label htmlFor="report-weekday">On</Label>
            <Select id="report-weekday" name="reportWeekday" defaultValue={defaults.weekday}>
              {WEEKDAY_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="report-hour">At</Label>
            <Select id="report-hour" name="reportHour" defaultValue={String(defaults.hourLocal)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </Select>
          </div>
        </div>

        <p className="text-xs text-muted">
          Times are {defaults.timeZone} local — {String(defaults.hourLocal).padStart(2, "0")}:00
          stays {String(defaults.hourLocal).padStart(2, "0")}:00 through the clock
          change, not an hour out for half the year. Covers the previous seven
          days, with spend compared against the week before.
          {defaults.lastRunAt
            ? ` Last sent ${new Date(defaults.lastRunAt).toLocaleString("en-GB")}.`
            : " Not sent yet."}
        </p>

        <SubmitButton pendingText="Saving…">Save report settings</SubmitButton>
      </form>

      <form action={testAction} className="border-t border-border pt-5">
        {testState.error ? <FormMessage error={testState.error} /> : null}
        {testState.success ? <FormMessage success={testState.success} /> : null}
        <input type="hidden" name="reportEmail" value={email} />
        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Sending…">Send one now</SubmitButton>
          <span className="text-xs text-muted">
            Sends the real report for the last seven days. Doesn&rsquo;t affect
            the schedule.
          </span>
        </div>
      </form>
    </div>
  );
}
