import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { getCapabilityState } from "@/lib/capabilities/registry";
import { sandboxAgent, SANDBOX_AGENT_ID } from "@/lib/capabilities/sandbox-agent";
import { getAgentLimits, getRateLimitHits } from "@/lib/agent/limits-store";
import { fetchImagePackages, topPackageUses } from "@/lib/agent/packages-store";
import { PageHeader } from "@/components/admin/page-header";
import { Card } from "@/components/admin/ui";
import { SandboxAgentCard } from "@/components/admin/sandbox-agent-card";
import { AgentPackagesPanel } from "@/components/admin/agent-packages-panel";
import { AgentMcpPanel } from "@/components/admin/agent-mcp-panel";
import { fetchAgentMcp } from "@/lib/agent/mcp-store";
import { agentTokenSource } from "@/lib/agent/env";
import { EMPTY_MCP } from "@/lib/agent/mcp";
import type { CapabilityView } from "@/components/admin/tools-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox · Admin" };

/**
 * Admin → Sandbox (owner ask, 2026-09-02): everything about the agent tier
 * in one place — service status, credential and limits, plan usage, and
 * what the agent reaches for. The ENABLE switch stays on Admin → Tools
 * (with the other client capabilities) and the savings strip stays on
 * Usage; this page, and its nav tab, exist only while the capability is on.
 */
export default async function SandboxPage() {
  await requireAdmin();

  const state = await getCapabilityState(sandboxAgent);
  if (!state.enabled) redirect("/admin/tools");

  const cap: CapabilityView = {
    id: SANDBOX_AGENT_ID,
    label: sandboxAgent.label,
    description: sandboxAgent.description,
    enabled: state.enabled,
    config: { ...state.config },
  };

  const sandboxConfigured = !!process.env.SANDBOX_BROKER_URL && !!process.env.SANDBOX_BROKER_TOKEN;
  const PACKAGE_DAYS = 30;
  const [anthropicCredentials, agentLimits, agentLimitHits, packageTally, imagePackages, mcpState] = await Promise.all([
    db.providerCredential.findMany({
      where: { provider: "anthropic_api" },
      select: { id: true, label: true },
      orderBy: { createdAt: "asc" },
    }),
    getAgentLimits(),
    getRateLimitHits(),
    topPackageUses({ days: PACKAGE_DAYS, limit: 25 }),
    sandboxConfigured ? fetchImagePackages() : Promise.resolve(null),
    // Fresh: this page load is what surfaces a just-run `agent-mcp add`.
    sandboxConfigured ? fetchAgentMcp({ fresh: true }) : Promise.resolve(EMPTY_MCP),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sandbox"
        subtitle="The agent that does the assistant's long, hands-on work — how it signs in, what it may spend, and what it reaches for."
      />

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">Service</h2>
        <Card>
          <p className="text-sm text-muted" data-sandbox-service>
            {sandboxConfigured ? (
              <>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">Reachable ✓</span>{" "}
                — each chat&apos;s agent runs in its own isolated container (2 GB RAM · 2 CPUs · no
                access to this server&apos;s services). Internet access for agents is set by{" "}
                <span className="font-mono text-xs">SANDBOX_NETWORK</span> in{" "}
                <span className="font-mono text-xs">.env</span> (currently{" "}
                <span className="font-mono text-xs">{process.env.SANDBOX_NETWORK ?? "egress"}</span>).
                {imagePackages ? (
                  <>
                    {" "}
                    The image ships {imagePackages.python.length} Python and {imagePackages.node.length}{" "}
                    Node packages plus {imagePackages.tools.join(", ")}.
                  </>
                ) : null}
              </>
            ) : (
              <>
                <span className="font-medium text-amber-600 dark:text-amber-400">Not configured</span>{" "}
                — set <span className="font-mono text-xs">SANDBOX_BROKER_TOKEN</span> in{" "}
                <span className="font-mono text-xs">.env</span> and redeploy. Until then the Sandbox
                can be configured but cannot run.
              </>
            )}
          </p>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">Configuration</h2>
        <Card>
          <SandboxAgentCard
            cap={cap}
            credentials={anthropicCredentials}
            limits={agentLimits}
            limitHits={agentLimitHits}
            tokenSource={agentTokenSource()}
            showEnable={false}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">Connected services (MCP)</h2>
        <Card>
          <AgentMcpPanel state={mcpState} instance={process.env.OPNINFER_INSTANCE ?? null} />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
          What the agent reaches for
        </h2>
        <Card>
          <AgentPackagesPanel tally={packageTally} image={imagePackages} days={PACKAGE_DAYS} />
        </Card>
      </section>
    </div>
  );
}
