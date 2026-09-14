import { requireAdmin } from "@/lib/auth-helpers";
import { getAssistantConfig } from "@/lib/assistant";
import { getCredentialModels } from "@/lib/providers/user-models";
import { getTokenLimits, LIMIT_BOUNDS } from "@/lib/limits";
import { PageHeader } from "@/components/admin/page-header";
import { ModelRolesForm } from "@/components/admin/model-roles-form";
import { LimitsForm } from "@/components/admin/limits-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Models · Admin" };

export default async function ModelsPage() {
  await requireAdmin();
  const [config, credentialModels, limits] = await Promise.all([
    getAssistantConfig(),
    getCredentialModels(),
    getTokenLimits(),
  ]);

  const failed = credentialModels.filter((c) => !c.ok);

  return (
    <div>
      <PageHeader
        title="Models"
        subtitle="Bind each assistant role to a provider key and model. Name & logo are under Customise."
      />

      {failed.length > 0 ? (
        <p className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-foreground">
          Couldn&apos;t list models for: {failed.map((f) => f.label).join(", ")}.
          Check the key under API.
        </p>
      ) : null}

      <ModelRolesForm initial={config} credentialModels={credentialModels} />

      <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold text-foreground">Limits</h2>
        <p className="mb-4 text-sm text-muted">
          Applied to every role, provider and model — regardless of which one is
          running or how its reasoning is configured.
        </p>
        {/* Bounds come from the server so the input's min/max can never drift
            from what the action actually enforces. */}
        <LimitsForm defaults={limits} bounds={LIMIT_BOUNDS} />
      </div>
    </div>
  );
}
