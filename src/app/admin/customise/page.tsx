import { requireAdmin } from "@/lib/auth-helpers";
import { getBranding } from "@/lib/branding";
import { getAssistantConfig, MAX_SYSTEM_PROMPT_CHARS } from "@/lib/assistant";
import { getUsageVisibility } from "@/lib/prefs";
import { getMaxUploadBytes } from "@/lib/settings";
import { PageHeader } from "@/components/admin/page-header";
import { Card } from "@/components/admin/ui";
import { BrandingForm } from "@/components/admin/branding-form";
import { AssistantIdentityForm } from "@/components/admin/assistant-identity-form";
import { SystemPromptForm } from "@/components/admin/system-prompt-form";
import { UsageVisibilityForm } from "@/components/admin/usage-visibility-form";
import { UploadLimitForm } from "@/components/admin/upload-limit-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customise · Admin" };

export default async function CustomisePage() {
  await requireAdmin();
  const [branding, assistant, usageVisibility, maxUploadBytes] = await Promise.all([
    getBranding(),
    getAssistantConfig(),
    getUsageVisibility(),
    getMaxUploadBytes(),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Customise"
        subtitle="Your assistant's identity, portal branding, and chat display."
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Assistant
        </h2>
        <Card>
          <AssistantIdentityForm name={assistant.name} logo={assistant.logo} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Assistant instructions
        </h2>
        <Card>
          <SystemPromptForm
            value={assistant.systemPrompt ?? ""}
            maxChars={MAX_SYSTEM_PROMPT_CHARS}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Portal branding
        </h2>
        <Card>
          <BrandingForm
            accent={branding.accent}
            accentDark={branding.accentDark}
            logo={branding.logo}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Chat display
        </h2>
        <Card>
          <UsageVisibilityForm value={usageVisibility} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Uploads
        </h2>
        <Card>
          <UploadLimitForm currentMb={Math.floor(maxUploadBytes / 1024 / 1024)} />
        </Card>
      </section>
    </div>
  );
}
