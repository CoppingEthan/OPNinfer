import Link from "next/link";
import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/admin/page-header";
import { LiveLogs, type LogRow, type LogUser } from "@/components/admin/live-logs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs · Admin" };

const SIZES = [25, 50, 100, 200];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  await requireAdmin();
  const { n } = await searchParams;
  const take = SIZES.includes(Number(n)) ? Number(n) : 50;

  // Two initial buffers: everything (Raw view) + chat replies only (Chats
  // view — a busy instance's recent N raw events may hold few chat rows).
  const [rows, chatRows, userRows] = await Promise.all([
    db.appLog.findMany({ orderBy: { createdAt: "desc" }, take }),
    db.appLog.findMany({
      where: { category: "chat", message: "Assistant reply" },
      orderBy: { createdAt: "desc" },
      take,
    }),
    db.user.findMany({ select: { id: true, name: true, email: true, image: true } }),
  ]);
  const toRow = (r: (typeof rows)[number]): LogRow => ({
    level: r.level,
    category: r.category,
    message: r.message,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
    details: r.details ?? undefined,
  });
  const initial = rows.map(toRow);
  const initialChat = chatRows.map(toRow);
  const users: Record<string, LogUser> = Object.fromEntries(
    userRows.map((u) => [u.id, { name: u.name, email: u.email, image: u.image }]),
  );

  return (
    <div>
      <PageHeader
        title="Logs"
        subtitle="Live application log — Chats: per-reply feed (user, tokens, cost); Raw: every event as the server recorded it."
        action={
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
            {SIZES.map((s) => (
              <Link
                key={s}
                href={`/admin/logs?n=${s}`}
                aria-current={s === take ? "page" : undefined}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  s === take
                    ? "bg-background text-foreground ring-1 ring-border"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {s}
              </Link>
            ))}
          </div>
        }
      />
      {/* Re-key on `take` so a new size reloads the initial buffer. */}
      <LiveLogs key={take} initial={initial} initialChat={initialChat} users={users} />
    </div>
  );
}
