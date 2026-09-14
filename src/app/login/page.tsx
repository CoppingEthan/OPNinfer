import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { IS_CONSOLE } from "@/lib/mode";
import { consoleHasOperators } from "@/lib/console/auth";
import { AuthCard } from "@/components/auth-card";
import { LoginForm } from "./login-form";

// Reads the DB (user count) — render per request, never prerender at build.
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; registered?: string; reset?: string }>;
}) {
  // The operator console has no users table and no /setup — its accounts come
  // from the env file (`./deploy.sh console-password`). Say so plainly when
  // none are configured, rather than presenting a form nothing can satisfy.
  if (IS_CONSOLE) {
    const params = await searchParams;
    return (
      <AuthCard title="OPNinfer console">
        {consoleHasOperators() ? (
          <LoginForm callbackUrl={params.callbackUrl ?? "/console"} />
        ) : (
          <p className="text-sm text-muted">
            No operator accounts are configured. On the host, run{" "}
            <code className="rounded bg-surface-hover px-1 py-0.5">./deploy.sh console-password</code>{" "}
            and then redeploy.
          </p>
        )}
      </AuthCard>
    );
  }

  // If no users exist yet, send the very first visitor to bootstrap setup.
  if ((await db.user.count()) === 0) {
    redirect("/setup");
  }

  const params = await searchParams;
  const notice = params.registered
    ? "Account ready — please sign in."
    : params.reset
      ? "Password updated — please sign in."
      : undefined;

  return (
    <AuthCard title="Sign in to OPNinfer">
      <LoginForm callbackUrl={params.callbackUrl ?? "/"} notice={notice} />
    </AuthCard>
  );
}
