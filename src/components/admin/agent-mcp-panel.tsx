"use client";

import { useState, useTransition } from "react";
import { checkAgentMcp } from "@/app/actions/tools";
import { mcpAuthState, type AgentMcpState } from "@/lib/agent/mcp";
import { Button } from "@/components/ui/button";

/**
 * Admin → Sandbox → "Connected services" (owner ask, 2026-09-03). Read-only
 * on purpose: services are added to the Sandbox with Claude Code's own
 * commands on the server and signed in through the service's own login —
 * there is nothing here to type a token into. The panel shows what that
 * instance's volume holds, whether each has a sign-in, and a live
 * "Check connections" that boots the agent in a container and asks it.
 */
type CheckResult = Awaited<ReturnType<typeof checkAgentMcp>>;

export function AgentMcpPanel({ state, instance }: { state: AgentMcpState; instance: string | null }) {
  const names = Object.keys(state.servers).sort();
  const [checking, startCheck] = useTransition();
  const [result, setResult] = useState<CheckResult | null>(null);

  const check = () =>
    startCheck(async () => {
      setResult(await checkAgentMcp());
    });

  const statusOf = (name: string) => result?.servers?.find((s) => s.name === name);

  return (
    <div className="space-y-4 text-sm" data-agent-mcp>
      <p className="text-muted">
        Services the Sandbox agent can use through MCP — a design tool, a ticket system, a
        workspace. They are set up on the server with Claude Code&apos;s own commands and signed
        in through each service&apos;s own login; nothing is stored in this portal, and other
        instances on the same server are unaffected.
      </p>

      {names.length === 0 ? (
        <p className="text-muted" data-agent-mcp-empty>
          None set up for this instance.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {names.map((name) => {
            const s = state.servers[name];
            const auth = mcpAuthState(name, s, state);
            const live = statusOf(name);
            return (
              <li
                key={name}
                data-agent-mcp-server={name}
                data-agent-mcp-auth={auth}
                {...(live ? { "data-agent-mcp-status": live.status } : {})}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
              >
                <span className="font-medium text-foreground">{name}</span>
                <span className="truncate font-mono text-xs text-muted">{"url" in s ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`.trim()}</span>
                <span className="ml-auto text-xs">
                  {live ? (
                    live.status === "connected" ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Connected ✓{live.detail ? ` · ${live.detail}` : ""}</span>
                    ) : live.status === "needs-auth" ? (
                      <span className="text-amber-600 dark:text-amber-400">Needs a sign-in</span>
                    ) : live.status === "pending" ? (
                      <span className="text-muted">Still connecting…</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">{live.status}{live.detail ? ` · ${live.detail}` : ""}</span>
                    )
                  ) : auth === "ready" ? (
                    <span className="text-emerald-600 dark:text-emerald-400">Signed in</span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">Needs a sign-in</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {names.length > 0 ? (
        <div className="space-y-2">
          <Button onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check connections"}
          </Button>
          {result?.error ? <p className="text-xs text-amber-600 dark:text-amber-400">{result.error}</p> : null}
          {result?.success && !result.error ? <p className="text-xs text-muted">{result.success}</p> : null}
          {result?.unexpected?.length ? (
            <p className="text-xs text-red-600 dark:text-red-400" data-agent-mcp-unexpected={result.unexpected.join(",")}>
              The agent reported a service that isn&apos;t set up here: {result.unexpected.join(", ")}. Its tools are
              refused; this has been logged.
            </p>
          ) : null}
          <p className="text-xs text-muted">
            A signed-in service that stops working is logged as an error at the end of every Sandbox run and by this
            check — the error alert email (Admin → SMTP) sends it on. Only services set up for this instance are
            ever reachable; anything else the agent might see is refused.
          </p>
        </div>
      ) : null}

      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground">How to add a service (example: Figma)</summary>
        <div className="mt-2 space-y-2 text-xs text-muted">
          <p>
            On the server, from the OPNinfer checkout. Step 2 prints a link: open it in your
            browser, approve, then paste the full address the browser lands on back into the
            terminal (that page shows a connection error — expected). Then reload this page.
          </p>
          <pre className="overflow-x-auto rounded bg-surface-hover/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
            {instance
              ? `./deploy.sh agent-mcp ${instance} add figma https://mcp.figma.com/mcp\n./deploy.sh agent-mcp ${instance} login figma`
              : `docker run --rm -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent claude mcp add --transport http -s user figma https://mcp.figma.com/mcp\ndocker run -it --rm -v opninfer-agent-config-default:/home/sandbox/.claude opninfer-agent claude mcp login figma --no-browser`}
          </pre>
          <p>
            {instance
              ? `To see or remove: ./deploy.sh agent-mcp ${instance} list · remove <name> · logout <name>.`
              : "To see or remove: the same docker run with claude mcp list · remove -s user <name> · logout <name>."}{" "}
            Any MCP server that signs in with OAuth or a fixed header works the same way.
          </p>
        </div>
      </details>
    </div>
  );
}
