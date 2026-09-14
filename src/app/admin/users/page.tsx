import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/admin/page-header";
import { UserTable, type AdminUser } from "@/components/admin/user-table";
import {
  InviteManager,
  type PendingInvite,
} from "@/components/admin/invite-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · Admin" };

export default async function UsersPage() {
  const admin = await requireAdmin();

  const [userRows, inviteRows, usageRows] = await Promise.all([
    // Explicit select: a bare findMany pulls `password_hash` for every account
    // into the render scope. It was never sent to the client, but there is no
    // reason for it to be in the process at all.
    db.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        disabled: true,
        emailVerified: true,
        createdAt: true,
        lastActiveAt: true,
        image: true,
      },
    }),
    db.invite.findMany({
      where: { acceptedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    // Lifetime token totals per user (spec §18).
    db.usageRecord.groupBy({
      by: ["userId"],
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true },
    }),
  ]);

  const usageByUser = new Map(usageRows.map((r) => [r.userId, r._sum]));

  const users: AdminUser[] = userRows.map((u) => {
    const sum = usageByUser.get(u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      verified: u.emailVerified !== null,
      disabled: u.disabled,
      createdAt: u.createdAt.toISOString(),
      lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
      inputTokens: (sum?.inputTokens ?? 0) + (sum?.cacheReadTokens ?? 0),
      outputTokens: sum?.outputTokens ?? 0,
    };
  });

  const invites: PendingInvite[] = inviteRows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt.toISOString(),
  }));

  return (
    <div className="space-y-10">
      <section>
        <PageHeader title="Users" subtitle={`${users.length} total`} />
        <UserTable users={users} currentUserId={admin.id} />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Invites</h2>
        <p className="mb-4 text-sm text-muted">
          Invite-only access — send a link or add accounts directly.
        </p>
        <InviteManager invites={invites} />
      </section>
    </div>
  );
}
