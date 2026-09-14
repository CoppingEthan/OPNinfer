import "server-only";
import { appLog } from "@/lib/applog";
import { classifyMcpStatuses, mcpHealthMessage, type McpHealth, type McpStatusLike } from "./mcp";

/**
 * Turn the CLI's per-server report into log rows (owner ask, 2026-09-04:
 * "do we get emails if the MCP link breaks?"). A signed-in service the CLI
 * could not use is an ERROR-level `agent` row — exactly what Admin → SMTP's
 * error alerts email, throttled per message like every other alert — and a
 * service the CLI reported that was never set up here is a WARN (its tools
 * are refused by the permission layer either way). Called at the end of
 * every Sandbox run and from the admin's Check connections button, so a
 * broken link is noticed by the portal, not by a user.
 */
export async function reportMcpHealth(
  statuses: McpStatusLike[],
  opts: { ready: string[]; known: string[] },
  ctx: { userId?: string | null; conversationId?: string; source: "run" | "check" },
): Promise<McpHealth> {
  const health = classifyMcpStatuses(statuses, opts);
  for (const b of health.broken) {
    await appLog("error", "agent", mcpHealthMessage(b.name, b.status), {
      userId: ctx.userId ?? undefined,
      details: {
        service: b.name,
        status: b.status,
        ...(b.error ? { error: b.error } : {}),
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        source: ctx.source,
        fix:
          b.status === "needs-auth"
            ? `./deploy.sh agent-mcp <instance> login ${b.name}`
            : `./deploy.sh agent-mcp <instance> list — then check the service, or remove and re-add it`,
      },
    });
  }
  for (const name of health.unexpected) {
    await appLog("warn", "agent", `Sandbox: the agent reported a connected service that isn't set up here — "${name}" (its tools are refused)`, {
      userId: ctx.userId ?? undefined,
      details: { service: name, source: ctx.source, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) },
    });
  }
  return health;
}
