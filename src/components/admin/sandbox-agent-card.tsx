"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCapability, checkAgentAccount, clearAgentPlanUsage, sendTestPlanAlert } from "@/app/actions/tools";
import {
  AGENT_BOUNDS,
  AGENT_DEFAULT_STEERING,
  AGENT_EFFORTS,
  parseAgentConfig,
} from "@/lib/agent/config";
import type { AgentLimitState } from "@/lib/agent/limits";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { fieldCls } from "./ui";
import { AgentLimitsPanel } from "./agent-limits-panel";
import type { CapabilityView } from "./tools-forms";

/**
 * The Sandbox capability's bespoke Admin → Tools card. The generic
 * CapabilityToggleCard cannot serve here: the credential-mode radio changes
 * which fields make sense, and subscription mode carries a live sign-in
 * status check (a server action that spawns the Agent SDK briefly and reads
 * accountInfo — never a credential, never a paste-your-token field).
 *
 * Every numeric input uses step 1 (0.01 for money) with min/max from
 * AGENT_BOUNDS — the Limits form once shipped a step that made the browser
 * reject its own default value, invisibly to every server-side test.
 */
export function SandboxAgentCard({
  cap,
  credentials,
  limits,
  limitHits,
  tokenSource,
  showEnable = true,
}: {
  cap: CapabilityView;
  /** Tools page shows the switch; the Sandbox page hides it (enable lives on Tools). */
  showEnable?: boolean;
  /** Stored org Anthropic keys (id + label only) for the API-mode picker. */
  credentials: { id: string; label: string }[];
  /** Last-reported plan usage — only meaningful on the subscription path. */
  limits: AgentLimitState;
  /** Times runs had to wait for the plan's limit. */
  limitHits: { today: number; week: number };
  /** Which subscription credential this instance is configured with:
   *  a long-lived token from `claude setup-token`, or the container volume
   *  login the CLI refreshes itself. Read-only — it is set on the host. */
  tokenSource: "none" | "token" | "malformed";
}) {
  const router = useRouter();
  const stored = parseAgentConfig(cap.config);
  const [enabled, setEnabled] = useState(cap.enabled);
  const [credential, setCredential] = useState<string>(stored.credential);
  const [credentialId, setCredentialId] = useState(stored.credentialId ?? "");
  const [model, setModel] = useState(stored.model);
  const [effort, setEffort] = useState<string>(stored.effort);
  const [maxTurns, setMaxTurns] = useState(String(stored.maxTurns));
  const [maxMinutes, setMaxMinutes] = useState(String(stored.maxMinutes));
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(String(stored.maxBudgetUsd));
  const [steering, setSteering] = useState(stored.steering);

  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, start] = useTransition();
  const [checking, setChecking] = useState(false);
  const [account, setAccount] = useState<{
    email?: string;
    subscriptionType?: string;
    warning?: string;
    error?: string;
  } | null>(null);

  const checkAccount = async () => {
    setChecking(true);
    setAccount(null);
    try {
      const res = await checkAgentAccount();
      setAccount(res.account ? { ...res.account, warning: res.warning } : { error: res.error ?? "Check failed." });
    } catch {
      setAccount({ error: "Check failed." });
    } finally {
      setChecking(false);
    }
  };

  const save = () => {
    setMsg({});
    start(async () => {
      const res = await saveCapability(cap.id, showEnable ? enabled : cap.enabled, {
        credential,
        ...(credentialId ? { credentialId } : {}),
        model,
        effort,
        maxTurns,
        maxMinutes,
        maxBudgetUsd,
        steering,
      });
      setMsg(res);
      if (res.success) router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {showEnable ? (
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-sm font-medium text-foreground">Enable for this workspace</span>
        </label>
      ) : null}

      {/* Credential mode — the architectural fork, not a cosmetic choice. */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Credential</legend>

        <label className="flex items-start gap-3">
          <input
            type="radio"
            name="sandbox-credential"
            checked={credential === "api"}
            onChange={() => setCredential("api")}
            className="mt-0.5 h-4 w-4 accent-accent"
          />
          <span className="text-sm">
            <span className="font-medium text-foreground">Organisation API key</span>
            <span className="block text-xs text-muted">
              Billed per call to the organisation, like the assistant&apos;s model roles.
              The key never enters the agent&apos;s workspace — calls go through this
              server.
            </span>
          </span>
        </label>
        {credential === "api" ? (
          <div className="ml-7">
            <select
              value={credentialId}
              onChange={(e) => setCredentialId(e.target.value)}
              className={fieldCls}
            >
              <option value="">Choose an Anthropic key…</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {credentials.length === 0 ? (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                No Anthropic key stored yet — add one under Admin → API first.
              </p>
            ) : null}
          </div>
        ) : null}

        <label className="flex items-start gap-3">
          <input
            type="radio"
            name="sandbox-credential"
            checked={credential === "subscription"}
            onChange={() => setCredential("subscription")}
            className="mt-0.5 h-4 w-4 accent-accent"
          />
          <span className="text-sm">
            <span className="font-medium text-foreground">Claude subscription</span>
            <span className="block text-xs text-muted">
              Uses your own Claude plan. Intended for individual use; for a team, use an
              organisation API key. Sign-in happens through Anthropic&apos;s own login
              flow where the agent runs — this portal never sees or stores the
              credential.
            </span>
          </span>
        </label>
        {credential === "subscription" ? (
          <div className="ml-7 space-y-2">
            {/* Which of the two subscription credentials is in play (owner
                ask, 2026-09-07). Set on the HOST, never here: this card must
                never become a paste-your-token field. The volume login is a
                refreshing pair every container shares, so it signs runs out
                in a burst at each expiry; a long-lived token has nothing to
                refresh. */}
            <div
              data-agent-token-source={tokenSource}
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs"
            >
              {tokenSource === "token" ? (
                <>
                  <span className="font-medium text-foreground">Long-lived token</span>
                  <span className="block text-muted">
                    No eight-hourly refresh, so runs are never signed out mid-expiry. Replace it
                    with <code>./deploy.sh agent-token &lt;instance&gt;</code> on the host.
                  </span>
                </>
              ) : tokenSource === "malformed" ? (
                <span className="text-amber-600 dark:text-amber-400">
                  A token is configured for this instance but isn&apos;t readable as one — the
                  container login is being used instead. Set it again with{" "}
                  <code>./deploy.sh agent-token &lt;instance&gt;</code>.
                </span>
              ) : (
                <>
                  <span className="font-medium text-foreground">Container sign-in</span>
                  <span className="block text-muted">
                    Its access token expires about every eight hours and every chat shares one
                    copy, so a run or two can fail at each expiry. To stop that, mint a
                    long-lived token on the host:{" "}
                    <code>./deploy.sh agent-token &lt;instance&gt;</code>.
                  </span>
                </>
              )}
            </div>
            <Button onClick={checkAccount} disabled={checking}>
              {checking ? "Checking…" : "Check sign-in"}
            </Button>
            {/* Fallback (owner ask, 2026-09-02): if the plan's limit is hit
                or the sign-in is lost, a run switches to this key rather than
                failing, and an alert email goes out either way. */}
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-muted">
                Fallback key — used automatically if the plan&apos;s limit is reached or the
                sign-in is lost (an alert email is sent either way):
              </span>
              <select
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                className={fieldCls}
              >
                <option value="">No fallback — runs fail until fixed</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {account ? (
              account.error ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">{account.error}</p>
              ) : (
                /* The CLI populates the email a moment after the plan, so a
                   quick probe often has the plan and not the address —
                   "Signed in as · Claude Pro" reads like a bug. Drop the
                   "as" rather than render a dangling one. */
                <p className="text-xs text-muted">
                  {account.email ? (
                    <>
                      Signed in as{" "}
                      <span className="font-medium text-foreground">{account.email}</span>
                    </>
                  ) : (
                    <>Signed in</>
                  )}
                  {account.subscriptionType ? <> · {account.subscriptionType}</> : null}
                  <span className="block">Checked with a real request from inside the agent container.</span>
                  {account.warning ? (
                    <span className="block text-amber-600 dark:text-amber-400">{account.warning}</span>
                  ) : null}
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {/* Plan usage — the subscription's equivalent of a spend chart. Only
          shown on that path: on an API key the limits are billing, not
          windows, and belong on the Usage dashboard.

          THE NUMBERS ARE HIDDEN ON A LONG-LIVED TOKEN (2026-09-07). Claude
          limits those tokens to inference, so the plan's usage screen cannot
          be read on one — measured, not assumed. What was left was a panel
          whose five-hour window quietly vanished (rolled over, correctly
          hidden as stale) beside a seven-day percentage frozen at whatever
          it was when the token went in. A number that never changes is worse
          than no number: it reads as current. The panel says so instead.
          The reading code is intact and still tested — see
          `planUsageViaVolumeEnabled` in limits-store.ts for the way back. */}
      {credential === "subscription" ? (
        <div className="rounded-xl border border-border p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-semibold text-foreground">Plan usage</h4>
            {tokenSource === "token" ? null : (
              <button
                type="button"
                onClick={() => {
                  setMsg({});
                  start(async () => {
                    const res = await clearAgentPlanUsage();
                    setMsg(res);
                    if (res.success) router.refresh();
                  });
                }}
                disabled={pending}
                className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear readings
              </button>
            )}
          </div>
          {tokenSource === "token" ? (
            <p className="text-xs text-muted" data-plan-usage="hidden">
              Not tracked on a long-lived token — Claude limits those to running work, so
              the plan&apos;s usage figures can&apos;t be read. Nothing about your runs is
              affected. You&apos;ll still be alerted if the plan refuses one; what you
              don&apos;t get is the warning beforehand.
            </p>
          ) : (
            <AgentLimitsPanel state={limits} hits={limitHits} />
          )}
          {/* Test sends (owner ask): the real alert wording, marked TEST. */}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted">
            <span>Alert emails go out at 90% and when the plan refuses (Admin → SMTP → error alerts). Try them:</span>
            <button
              type="button"
              disabled={pending}
              onClick={() => { setMsg({}); start(async () => setMsg(await sendTestPlanAlert("warn"))); }}
              className="rounded-md border border-border px-2 py-1 text-foreground transition-colors hover:bg-surface-hover"
            >
              Send test: 90% warning
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => { setMsg({}); start(async () => setMsg(await sendTestPlanAlert("limit"))); }}
              className="rounded-md border border-border px-2 py-1 text-foreground transition-colors hover:bg-surface-hover"
            >
              Send test: limit reached
            </button>
          </div>
        </div>
      ) : null}

      {/* Model + per-run limits. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">Reasoning effort</span>
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className={fieldCls}
          >
            {AGENT_EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">
            Max agent turns per run
          </span>
          <input
            type="number"
            step={1}
            min={AGENT_BOUNDS.maxTurns.min}
            max={AGENT_BOUNDS.maxTurns.max}
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">Max minutes per run</span>
          <input
            type="number"
            step={1}
            min={AGENT_BOUNDS.maxMinutes.min}
            max={AGENT_BOUNDS.maxMinutes.max}
            value={maxMinutes}
            onChange={(e) => setMaxMinutes(e.target.value)}
            className={fieldCls}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">
            Budget guard per run (USD)
          </span>
          <input
            type="number"
            step={0.01}
            min={AGENT_BOUNDS.maxBudgetUsd.min}
            max={AGENT_BOUNDS.maxBudgetUsd.max}
            value={maxBudgetUsd}
            onChange={(e) => setMaxBudgetUsd(e.target.value)}
            className={fieldCls}
          />
          <span className="mt-1 block text-xs text-muted">
            Estimate-based soft stop. Ignored on a subscription (your plan&apos;s limits
            apply instead).
          </span>
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-foreground">
          Steering — how strongly the assistant is pushed to use the Sandbox
        </span>
        <textarea
          value={steering}
          onChange={(e) => setSteering(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder={AGENT_DEFAULT_STEERING}
          className={`${fieldCls} min-h-24`}
        />
        <span className="mt-1 block text-xs text-muted">
          Leave empty for the default (shown greyed). This is what the assistant reads
          when deciding whether to hand a task to the Sandbox.
        </span>
      </label>

      {msg.error ? <FormMessage error={msg.error} /> : null}
      {msg.success ? <FormMessage success={msg.success} /> : null}
      <Button onClick={save} disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
