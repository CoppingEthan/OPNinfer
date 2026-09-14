import { PageHeader } from "@/components/admin/page-header";
import { LogsView } from "@/components/console/logs-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs" };

export default function ConsoleLogsPage() {
  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Every portal's application log, merged and sorted by time."
      />
      <LogsView />
    </>
  );
}
