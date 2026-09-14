"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAssistantRoles } from "@/app/actions/assistant";
import {
  ASSISTANT_ROLES,
  ROLE_LABELS,
  type AssistantConfig,
  type AssistantRole,
} from "@/lib/assistant";
import type { CredentialModels } from "@/lib/providers/user-models";
import { reasoningOptions } from "@/lib/providers/reasoning";
import { Button } from "@/components/ui/button";
import { Card, Field, fieldCls } from "./ui";

interface RoleState {
  credentialId: string;
  model: string;
  reasoning: string;
  reasoningExtended: string;
}

/**
 * Models tab: bind each assistant role to a stored key + model and pick its
 * reasoning level from a provider-aware dropdown. The Conversation role also
 * gets an optional "Extended thinking" level — when set, users see a "Think"
 * toggle in chat that swaps between the quick and extended levels.
 */
export function ModelRolesForm({
  initial,
  credentialModels,
}: {
  initial: AssistantConfig;
  credentialModels: CredentialModels[];
}) {
  const router = useRouter();
  const [roles, setRoles] = useState<Record<AssistantRole, RoleState>>(() => {
    const out = {} as Record<AssistantRole, RoleState>;
    for (const role of ASSISTANT_ROLES) {
      const v = initial.roles[role];
      out[role] = {
        credentialId: v?.credentialId ?? "",
        model: v?.model ?? "",
        reasoning: v?.reasoning ?? "",
        reasoningExtended: v?.reasoningExtended ?? "",
      };
    }
    return out;
  });
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [pending, startTransition] = useTransition();

  const setRole = (role: AssistantRole, patch: Partial<RoleState>) =>
    setRoles((p) => ({ ...p, [role]: { ...p[role], ...patch } }));

  const modelsFor = (credentialId: string) =>
    credentialModels.find((c) => c.credentialId === credentialId)?.models ?? [];
  const providerFor = (credentialId: string) =>
    credentialModels.find((c) => c.credentialId === credentialId)?.provider;

  const hasCreds = credentialModels.length > 0;

  const save = () =>
    startTransition(async () => {
      setMsg({});
      const cfgRoles: AssistantConfig["roles"] = {};
      for (const role of ASSISTANT_ROLES) {
        const s = roles[role];
        const provider = providerFor(s.credentialId);
        if (s.credentialId && s.model && provider) {
          cfgRoles[role] = {
            credentialId: s.credentialId,
            provider,
            model: s.model,
            reasoning: s.reasoning || undefined,
            reasoningExtended:
              role === "conversation" ? s.reasoningExtended || undefined : undefined,
          };
        }
      }
      const res = await saveAssistantRoles(cfgRoles);
      setMsg(res);
      if (res.success) router.refresh();
    });

  if (!hasCreds) {
    return (
      <Card className="text-sm text-muted">
        Add a provider key under{" "}
        <a href="/admin/api" className="text-accent hover:underline">
          API
        </a>{" "}
        first, then bind each role to a key and model here.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {ASSISTANT_ROLES.map((role) => {
          const s = roles[role];
          const models = modelsFor(s.credentialId);
          const provider = providerFor(s.credentialId);
          const options = reasoningOptions(provider);
          const isConvo = role === "conversation";
          return (
            <Card key={role}>
              <div className="mb-3">
                <span className="text-sm font-semibold text-foreground">
                  {ROLE_LABELS[role].title}
                </span>
                {isConvo ? (
                  <span className="ml-1.5 text-xs font-medium text-accent">required</span>
                ) : null}
                <p className="text-xs text-muted">{ROLE_LABELS[role].blurb}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Provider key">
                  <select
                    aria-label={`${ROLE_LABELS[role].title} key`}
                    value={s.credentialId}
                    onChange={(e) => setRole(role, { credentialId: e.target.value, model: "" })}
                    className={fieldCls}
                  >
                    <option value="">— None —</option>
                    {credentialModels.map((c) => (
                      <option key={c.credentialId} value={c.credentialId} disabled={!c.ok}>
                        {c.label} ({c.vendor}){c.ok ? "" : " — unavailable"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model">
                  <select
                    aria-label={`${ROLE_LABELS[role].title} model`}
                    value={s.model}
                    onChange={(e) => setRole(role, { model: e.target.value })}
                    disabled={!s.credentialId}
                    className={fieldCls}
                  >
                    <option value="">{s.credentialId ? "— Model —" : "Pick a key first"}</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={isConvo ? "Quick reasoning" : "Reasoning"}>
                  <select
                    aria-label={`${ROLE_LABELS[role].title} reasoning`}
                    value={s.reasoning}
                    onChange={(e) => setRole(role, { reasoning: e.target.value })}
                    disabled={!s.credentialId}
                    className={fieldCls}
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {isConvo ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field
                    label="Extended thinking"
                    hint="Set a deeper level to give users a “Think” toggle in chat. Leave on Default for none."
                  >
                    <select
                      aria-label="Extended thinking level"
                      value={s.reasoningExtended}
                      onChange={(e) => setRole(role, { reasoningExtended: e.target.value })}
                      disabled={!s.credentialId}
                      className={fieldCls}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save models"}
        </Button>
        {msg.error ? (
          <span className="text-sm text-red-600 dark:text-red-400">{msg.error}</span>
        ) : null}
        {msg.success ? (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">{msg.success}</span>
        ) : null}
      </div>
    </div>
  );
}
