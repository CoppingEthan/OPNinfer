import { requireAdmin } from "@/lib/auth-helpers";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { getAlertConfig } from "@/lib/alerts";
import { isSmtpConfigured } from "@/lib/mailer";
import { PageHeader } from "@/components/admin/page-header";
import { SmtpForm, type SmtpDefaults } from "@/components/admin/smtp-form";
import { AlertsForm, type AlertDefaults } from "@/components/admin/alerts-form";
import {
  WeeklyReportForm,
  type WeeklyReportDefaults,
} from "@/components/admin/weekly-report-form";
import { getWeeklyReportConfig } from "@/lib/weekly-report";

export const dynamic = "force-dynamic";
export const metadata = { title: "SMTP · Admin" };

export default async function SmtpPage() {
  await requireAdmin();

  const stored = await getSetting<Record<string, unknown>>(SETTING_KEYS.smtp);
  const defaults: SmtpDefaults = {
    host: (stored?.host as string) ?? process.env.SMTP_HOST ?? "",
    port: (stored?.port as number) ?? Number(process.env.SMTP_PORT ?? 587),
    secure: (stored?.secure as boolean) ?? process.env.SMTP_SECURE === "true",
    username: (stored?.username as string) ?? process.env.SMTP_USER ?? "",
    from: (stored?.from as string) ?? process.env.SMTP_FROM ?? "",
    hasPassword: Boolean(
      stored?.password || stored?.passwordEncrypted || process.env.SMTP_PASS,
    ),
    source: stored?.host ? "settings" : process.env.SMTP_HOST ? "env" : "none",
  };

  const [alerts, report, smtpConfigured] = await Promise.all([
    getAlertConfig(),
    getWeeklyReportConfig(),
    isSmtpConfigured(),
  ]);
  const alertDefaults: AlertDefaults = {
    enabled: alerts.enabled,
    email: alerts.email,
    throttleMinutes: alerts.throttleMinutes,
    smtpConfigured,
  };
  const reportDefaults: WeeklyReportDefaults = {
    enabled: report.enabled,
    email: report.email,
    weekday: report.weekday,
    hourLocal: report.hourLocal,
    timeZone: report.timeZone,
    lastRunAt: report.lastRunAt,
    smtpConfigured,
  };

  return (
    <div>
      <PageHeader
        title="SMTP"
        subtitle="Outbound email for invites, password resets and error alerts. Without it, links are logged to the server console."
      />
      <div className="space-y-5">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <SmtpForm defaults={defaults} />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-1 text-base font-semibold text-foreground">
            Error alerts
          </h2>
          <AlertsForm defaults={alertDefaults} />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-1 text-base font-semibold text-foreground">
            Weekly report
          </h2>
          <WeeklyReportForm defaults={reportDefaults} />
        </div>
      </div>
    </div>
  );
}
