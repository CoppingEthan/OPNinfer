import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { AdminShell } from "@/components/admin/admin-shell";
import { getSandboxAgentState } from "@/lib/capabilities/sandbox-agent";

// Admin pages read live DB data — never prerender.
export const dynamic = "force-dynamic";

export const metadata = { title: "Admin · OPNinfer" };

/**
 * Shell for the admin area: a persistent, resizable + collapsible left nav that
 * matches the chat sidebar, plus the shared top-right account menu (§17/§20).
 * Middleware already gates `/admin` to admins; this re-checks as defence in
 * depth and supplies the signed-in admin's identity to the shell.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "admin") redirect("/chat");

  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, image: true },
  });
  // The Sandbox tab shows only while the capability is enabled.
  const sandbox = (await getSandboxAgentState()).enabled;

  return (
    <AdminShell
      email={session.user.email ?? ""}
      name={me?.name ?? undefined}
      role={session.user.role}
      image={me?.image ?? undefined}
      sandbox={sandbox}
    >
      {children}
    </AdminShell>
  );
}
