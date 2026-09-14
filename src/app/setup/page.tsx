import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AuthCard } from "@/components/auth-card";
import { SetupForm } from "./setup-form";

// Reads the DB (user count) — render per request, never prerender at build.
export const dynamic = "force-dynamic";

/** First-run only: create the initial admin. Closed once any user exists. */
export default async function SetupPage() {
  if ((await db.user.count()) > 0) {
    redirect("/login");
  }

  return (
    <AuthCard
      title="Welcome to OPNinfer"
      subtitle="Create the first administrator account to get started."
    >
      <SetupForm />
    </AuthCard>
  );
}
