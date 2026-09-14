import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth-helpers";
import { sudoExpiresAt, SUDO_TTL_MS } from "@/lib/sudo";
import { db } from "@/lib/db";
import { chatWhereFor } from "@/lib/chat-access";
import { PageHeader } from "@/components/admin/page-header";
import { SudoGate, SudoBanner } from "@/components/admin/sudo-gate";
import { fieldCls } from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chats · Admin" };

const PAGE_SIZE = 50;

function displayName(user: { name: string | null; email: string }): string {
  return user.name?.trim() || user.email;
}

export default async function AdminChatsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; user?: string; page?: string }>;
}) {
  const admin = await requireAdmin();
  const expiresAt = await sudoExpiresAt(admin.id);

  if (!expiresAt) {
    return (
      <div>
        <PageHeader
          title="Chats"
          subtitle="Read any user's conversations to help with a support request."
        />
        <SudoGate minutes={Math.round(SUDO_TTL_MS / 60_000)} />
      </div>
    );
  }

  const { q = "", user: userId = "", page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const query = q.trim();

  // Incognito chats are deliberately excluded: the user was told they're
  // private and auto-deleted, and an admin list would break that promise.
  const where: Prisma.ConversationWhereInput = {
    incognito: false,
    // A person's chats = the ones they own AND the ones shared with them.
    ...(userId ? { AND: [chatWhereFor(userId)] } : {}),
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { messages: { some: { content: { contains: query, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const [total, conversations, users] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true, files: true, members: true } },
      },
    }),
    db.user.findMany({
      orderBy: { email: "asc" },
      select: { id: true, name: true, email: true },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (overrides: Record<string, string | number>) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (userId) params.set("user", userId);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "" || v === 0) params.delete(k);
      else params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `/admin/chats?${s}` : "/admin/chats";
  };

  return (
    <div>
      <PageHeader
        title="Chats"
        subtitle="Read any user's conversations to help with a support request."
      />
      <SudoBanner expiresAt={expiresAt} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Search
          </span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Title or message text…"
            className={fieldCls}
          />
        </label>
        <label className="min-w-52">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            User
          </span>
          <select name="user" defaultValue={userId} className={fieldCls}>
            <option value="">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {displayName(u)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          Apply
        </button>
        {(query || userId) && (
          <Link
            href="/admin/chats"
            className="px-2 py-2 text-sm text-muted underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        )}
      </form>

      <p className="mb-3 text-sm text-muted">
        {total.toLocaleString()} conversation{total === 1 ? "" : "s"}
        {pages > 1 ? ` · page ${page} of ${pages}` : ""}
      </p>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Chat</th>
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Messages</th>
              <th className="px-4 py-2.5 font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {conversations.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  No conversations match.
                </td>
              </tr>
            ) : (
              conversations.map((c) => (
                <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/chats/${c.id}`}
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      {c.title || "Untitled chat"}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {displayName(c.user)}
                    {c._count.members > 1 ? (
                      <span className="ml-1.5 rounded-full bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent" data-shared-with={c._count.members - 1}>
                        shared with {c._count.members - 1}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {c._count.messages}
                    {c._count.files > 0 ? ` · ${c._count.files} file${c._count.files === 1 ? "" : "s"}` : ""}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {c.updatedAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={qs({ page: page - 1 })} className="text-muted hover:text-foreground">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {page < pages ? (
            <Link href={qs({ page: page + 1 })} className="text-muted hover:text-foreground">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
