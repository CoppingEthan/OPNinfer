import { PageHeader } from "@/components/admin/page-header";
import { UsageDashboard } from "@/components/admin/usage-dashboard";
import { PortalSpend } from "@/components/console/portal-spend";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usage" };

/**
 * The per-portal usage dashboard, run over every portal at once.
 *
 * Literally the same component the portals' own Admin -> Usage renders, just
 * pointed at `/api/console/usage` — so the two can never drift, and anything
 * added to that dashboard appears here for free.
 */
export default function ConsoleUsagePage() {
  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Tokens, cost and requests across every portal, in one window."
      />
      <div className="space-y-6">
        <PortalSpend />
        <UsageDashboard endpoint="/api/console/usage" />
      </div>
    </>
  );
}
