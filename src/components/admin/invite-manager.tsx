"use client";

import { useActionState, useState, useTransition } from "react";
import { Role } from "@prisma/client";
import {
  createInvite,
  deleteInvite,
  resendInvite,
  type InviteResult,
} from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export function InviteManager({ invites }: { invites: PendingInvite[] }) {
  const [state, action] = useActionState<InviteResult, FormData>(
    createInvite,
    {},
  );

  return (
    <div className="space-y-5">
      <form action={action} className="space-y-4">
        {state.error ? <FormMessage error={state.error} /> : null}
        {state.link ? (
          <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {state.emailed
              ? "Invite emailed. "
              : "No SMTP configured — share this link directly: "}
            <code className="mt-1 block break-all rounded bg-background/60 px-2 py-1 text-xs">
              {state.link}
            </code>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              placeholder="person@example.com"
              required
            />
          </div>
          <div>
            <Label htmlFor="invite-role">Role</Label>
            <Select id="invite-role" name="role" defaultValue={Role.user}>
              <option value={Role.user}>User</option>
              <option value={Role.admin}>Admin</option>
            </Select>
          </div>
          <SubmitButton pendingText="Inviting…">Send invite</SubmitButton>
        </div>
      </form>

      {invites.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {invites.map((inv) => (
            <InviteRow key={inv.id} invite={inv} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No pending invites.</p>
      )}
    </div>
  );
}

function InviteRow({ invite }: { invite: PendingInvite }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<InviteResult | null>(null);
  const expired = new Date(invite.expiresAt) < new Date();

  const resend = () =>
    startTransition(async () => {
      setResult(null);
      setResult(await resendInvite(invite.id));
    });

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {invite.email}{" "}
            <span className="text-xs font-normal text-muted">({invite.role})</span>
          </p>
          <p className="text-xs text-muted">
            {expired ? "expired" : `expires ${formatDate(invite.expiresAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="secondary" disabled={pending} onClick={resend}>
            {pending ? "Resending…" : "Resend"}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => startTransition(() => deleteInvite(invite.id))}
            className="text-red-600 hover:bg-red-500/10 dark:text-red-400"
          >
            Revoke
          </Button>
        </div>
      </div>
      {result?.error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{result.error}</p>
      ) : null}
      {result?.link ? (
        <div className="mt-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {result.emailed ? "Invite re-emailed." : "No SMTP — share this link:"}
          {!result.emailed ? (
            <code className="mt-1 block break-all rounded bg-background/60 px-2 py-1">
              {result.link}
            </code>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
