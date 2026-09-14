import { db } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { AuthCard } from "@/components/auth-card";
import { FormMessage } from "@/components/ui/form-message";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  const valid = record && !record.usedAt && record.expiresAt > new Date();

  if (!valid) {
    return (
      <AuthCard title="Link expired">
        <FormMessage error="This reset link is invalid or has expired. Request a new one from the sign-in page." />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password">
      <ResetForm token={token} />
    </AuthCard>
  );
}
