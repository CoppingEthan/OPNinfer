import { requireAdmin } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/admin/page-header";
import { UsageDashboard } from "@/components/admin/usage-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usage · Admin" };

export default async function UsagePage() {
  await requireAdmin();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        subtitle="Every model call, tracked per user and pipeline role"
        action={
          <a
            href="/api/admin/usage"
            className="rounded-xl border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
          >
            Export CSV
          </a>
        }
      />
      <UsageDashboard />
    </div>
  );
}
