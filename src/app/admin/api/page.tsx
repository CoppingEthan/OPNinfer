import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { toProviderId } from "@/lib/providers/mapping";
import { PageHeader } from "@/components/admin/page-header";
import { CredentialForm } from "@/components/settings/credential-form";
import {
  CredentialList,
  type CredentialItem,
} from "@/components/settings/credential-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "API keys · Admin" };

/**
 * Provider API keys (point 3 "API"). Keys are managed centrally by admins and
 * power the shared assistant. Encrypted at rest (AES-256-GCM). Org-wide
 * sharing across multiple admins + the chat-route switch land in the next phase;
 * for now this manages the configuring admin's keys.
 */
export default async function ApiKeysPage() {
  await requireAdmin();

  const rows = await db.providerCredential.findMany({
    orderBy: { createdAt: "desc" },
  });

  const items: CredentialItem[] = rows.map((r) => ({
    id: r.id,
    provider: toProviderId(r.provider),
    label: r.label,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <div>
      <PageHeader
        title="API keys"
        subtitle="Provider credentials that power the assistant. Encrypted at rest and never shown again after saving."
      />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Add a provider key
        </h2>
        <div className="mt-3 rounded-2xl border border-border bg-surface p-5">
          <CredentialForm />
        </div>
        <p className="mt-3 text-xs text-muted">
          Paste a Console <strong>API key</strong> for OpenAI, Anthropic, or
          Google — pay-as-you-go at standard rates. Never paste keys into a chat
          message.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Configured keys
        </h2>
        <div className="mt-3">
          <CredentialList items={items} />
        </div>
      </section>
    </div>
  );
}
