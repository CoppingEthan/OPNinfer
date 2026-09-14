import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { AuthCard } from "@/components/auth-card";
import { ChangePasswordForm } from "./change-password-form";

// Reads the signed-in account — never prerender.
export const dynamic = "force-dynamic";

export const metadata = { title: "Change your password" };

/**
 * Where someone lands after signing in with a password an admin set for them.
 *
 * Middleware sends every other route here while `mustChangePassword` is set,
 * so this page is the whole of the app until they choose their own. It is
 * also reachable voluntarily from Settings, which is why it does not assume
 * the forced case — the copy changes, the form does not.
 */
export default async function ChangePasswordPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, mustChangePassword: true },
  });
  if (!me) redirect("/login");

  return (
    <AuthCard
      title={me.mustChangePassword ? "Choose your password" : "Change your password"}
      subtitle={
        me.mustChangePassword
          ? "The password you just used was set for you. Pick one only you know."
          : me.email
      }
    >
      <ChangePasswordForm forced={me.mustChangePassword} />
    </AuthCard>
  );
}
