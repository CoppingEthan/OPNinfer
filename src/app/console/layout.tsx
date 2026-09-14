import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { IS_CONSOLE } from "@/lib/mode";
import { consoleInstances } from "@/lib/console/instances";
import { ConsoleShell } from "@/components/console/console-shell";

// Every page here reads four live databases — never prerender.
export const dynamic = "force-dynamic";

export const metadata = { title: "Console · OPNinfer" };

/**
 * The operator console: one read-only overview across every portal on the
 * host, served from the same image on its own port.
 *
 * Middleware already 404s this whole tree on a portal container and requires a
 * session here; both are re-checked, because a matcher is one edit away from
 * not covering a path and this tree reads every client's data.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!IS_CONSOLE) notFound();
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <ConsoleShell email={session.user.email ?? ""} portals={consoleInstances().length}>
      {children}
    </ConsoleShell>
  );
}
