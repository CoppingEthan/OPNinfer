import { requireAdmin } from "@/lib/auth-helpers";
import { getSetting } from "@/lib/settings";
import { getTavilyKey } from "@/lib/tools/tavily";
import { getMemoryConfig } from "@/lib/tools/memory";
import { CAPABILITIES, getCapabilityState } from "@/lib/capabilities/registry";
import { SANDBOX_AGENT_ID } from "@/lib/capabilities/sandbox-agent";
import { PageHeader } from "@/components/admin/page-header";
import { Card } from "@/components/admin/ui";
import { SandboxEnableCard } from "@/components/admin/sandbox-enable-card";
import {
  ToolGroupsForm,
  TavilyKeyForm,
  ImageQuotasForm,
  MemoryConfigForm,
  CapabilityToggleCard,
  type CapabilityView,
} from "@/components/admin/tools-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tools · Admin" };

export default async function ToolsPage() {
  await requireAdmin();

  const [toolsConfig, tavilyKey, imageConfig, memoryConfig] = await Promise.all([
    getSetting<{ disabledGroups?: string[] }>("tools_config"),
    getTavilyKey(),
    getSetting<{ flashWeeklyLimit?: number; proWeeklyLimit?: number }>("image_tools_config"),
    getMemoryConfig(),
  ]);

  const capabilities: CapabilityView[] = [];
  for (const cap of CAPABILITIES) {
    const state = await getCapabilityState(cap);
    // Secrets never reach the client. No capability shipped today declares a
    // secret field, but the rule stands for every future one.
    const config = { ...state.config };
    for (const field of cap.secretFields) delete config[field];
    capabilities.push({
      id: cap.id,
      label: cap.label,
      description: cap.description,
      enabled: state.enabled,
      config,
      source: cap.source,
    });
  }


  return (
    <div className="space-y-8">
      <PageHeader
        title="Tools"
        subtitle="What the assistant is allowed to do, and the services behind it."
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Tool availability
        </h2>
        <Card>
          <ToolGroupsForm disabled={toolsConfig?.disabledGroups ?? []} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Web search (Tavily)
        </h2>
        <Card>
          <TavilyKeyForm configured={!!tavilyKey} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Image generation
        </h2>
        <Card>
          <ImageQuotasForm
            flash={imageConfig?.flashWeeklyLimit ?? 20}
            pro={imageConfig?.proWeeklyLimit ?? 5}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          User memory
        </h2>
        <Card>
          <MemoryConfigForm config={memoryConfig} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          Client capabilities
        </h2>
        <div className="space-y-4">
          {capabilities.map((cap) => (
            <Card key={cap.id}>
              <h3 className="text-sm font-semibold text-foreground">{cap.label}</h3>
              <p className="mb-3 mt-1 text-sm text-muted">{cap.description}</p>
              {cap.id === SANDBOX_AGENT_ID ? (
                /* Just the switch — settings and data live on Admin → Sandbox,
                   a tab that exists only while this is on. */
                <SandboxEnableCard cap={cap} />
              ) : (
                /* Everything else is the switch plus whatever source line the
                   capability declares for itself. Deliberately NOT keyed on
                   the capability's id: a capability built for one organisation
                   ships from outside this repository, and this page must
                   render it without ever having heard of it. */
                <CapabilityToggleCard cap={cap} source={cap.source} />
              )}
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
