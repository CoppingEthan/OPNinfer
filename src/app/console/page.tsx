import { PageHeader } from "@/components/admin/page-header";
import { OverviewView } from "@/components/console/overview-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default function ConsoleOverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Every portal on this host, side by side. Read-only."
      />
      <OverviewView />
    </>
  );
}
