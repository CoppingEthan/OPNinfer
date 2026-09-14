import { requireAdmin } from "@/lib/auth-helpers";
import { getBackupConfig, listBackups } from "@/lib/backup";
import { PageHeader } from "@/components/admin/page-header";
import { Card } from "@/components/admin/ui";
import { BackupConfigForm } from "@/components/admin/backup-config-form";
import { BackupManager } from "@/components/admin/backup-manager";
import { OwuiImport } from "@/components/admin/owui-import";

export const dynamic = "force-dynamic";
export const metadata = { title: "Backups · Admin" };

export default async function BackupsPage() {
  await requireAdmin();
  const [config, backups] = await Promise.all([getBackupConfig(), listBackups()]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Backups"
        subtitle="Snapshot the whole instance — database and stored files — and restore it from a zip."
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Automatic backups
        </h2>
        <Card>
          <BackupConfigForm config={config} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Backups
        </h2>
        <Card>
          <BackupManager backups={backups} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Import from Open WebUI
        </h2>
        <Card>
          <OwuiImport />
        </Card>
      </section>
    </div>
  );
}
