import { db } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { AuthCard } from "@/components/auth-card";
import { FormMessage } from "@/components/ui/form-message";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  const valid =
    invite && !invite.acceptedAt && invite.expiresAt > new Date();

  if (!valid) {
    return (
      <AuthCard title="Invite unavailable">
        <FormMessage error="This invite link is invalid, already used, or expired. Ask an administrator for a new invitation." />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Accept your invitation"
      subtitle={`Setting up ${invite.email}`}
    >
      <InviteForm token={token} />
    </AuthCard>
  );
}
