"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addCredential,
  type CredentialFormState,
} from "@/app/actions/credentials";
import { SELECTABLE_PROVIDERS } from "@/lib/providers/labels";
import type { ProviderId } from "@/lib/providers/types";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormMessage } from "@/components/ui/form-message";

export function CredentialForm() {
  const [state, action] = useActionState<CredentialFormState, FormData>(
    addCredential,
    {},
  );
  const [provider, setProvider] = useState<ProviderId>(
    SELECTABLE_PROVIDERS[0].id,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the inputs after a successful add (the verified key is now stored).
  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  const hint = SELECTABLE_PROVIDERS.find((p) => p.id === provider)?.hint;

  return (
    <form ref={formRef} action={action} className="space-y-4">
      {state.error ? <FormMessage error={state.error} /> : null}
      {state.success ? <FormMessage success={state.success} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="provider">Provider</Label>
          <Select
            id="provider"
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            {SELECTABLE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="label">Name</Label>
          <Input
            id="label"
            name="label"
            placeholder="e.g. Work OpenAI"
            required
            maxLength={80}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="secret">API key</Label>
        <Input
          id="secret"
          name="secret"
          type="password"
          autoComplete="off"
          placeholder="Paste your key — it's encrypted at rest"
          required
        />
        {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
      </div>

      <SubmitButton pendingText="Verifying…">Add &amp; verify key</SubmitButton>
    </form>
  );
}
