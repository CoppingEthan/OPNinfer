/**
 * Seed provider keys from .env into the app for local testing.
 *
 *   node --env-file=.env --import tsx scripts/seed-keys.ts
 *
 * For each of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY present in
 * .env it: verifies the key against the live API, stores it as an encrypted
 * ORG credential (idempotent — keyed by a stable label), and then configures
 * the assistant (front-end / conversation / escalation, plus failover on a
 * second provider when available) so chat works immediately. Refine anything in
 * Admin → Models afterwards. Dev convenience only; .env is git-ignored.
 */
import { db } from "../src/lib/db";
import { encrypt } from "../src/lib/crypto";
import { getProvider } from "../src/lib/providers/registry";
import { toDbProvider } from "../src/lib/providers/mapping";
import { providerVendor } from "../src/lib/providers/labels";
import {
  getAssistantConfig,
  setAssistantConfig,
  type AssistantConfig,
  type RoleConfig,
} from "../src/lib/assistant";
import type { Credential, Model, ProviderId } from "../src/lib/providers/types";

interface Seeded {
  provider: ProviderId;
  credentialId: string;
  models: Model[];
}

const KEYS: { provider: ProviderId; env: string }[] = [
  { provider: "anthropic-api", env: "ANTHROPIC_API_KEY" },
  { provider: "openai", env: "OPENAI_API_KEY" },
  { provider: "google", env: "GOOGLE_API_KEY" },
];

/** First model id whose name contains one of the substrings (in priority order). */
function pick(ids: string[], subs: string[]): string | undefined {
  for (const s of subs) {
    const hit = ids.find((id) => id.toLowerCase().includes(s));
    if (hit) return hit;
  }
  return undefined;
}

/** Heuristic cheap/standard/strong picks for a provider's model list. */
function rolesFor(provider: ProviderId, models: Model[]) {
  const ids = models.map((m) => m.id);
  if (ids.length === 0) return {} as Record<string, string | undefined>;
  if (provider === "anthropic-api") {
    return {
      frontend: pick(ids, ["haiku"]) ?? ids[0],
      conversation: pick(ids, ["sonnet", "opus"]) ?? ids[0],
      escalation: pick(ids, ["opus", "sonnet"]) ?? ids[0],
    };
  }
  if (provider === "openai") {
    return {
      frontend: pick(ids, ["nano", "mini"]) ?? ids[0],
      conversation: pick(ids, ["gpt-5.4", "gpt-5", "gpt-4.1"]) ?? ids[0],
      escalation: pick(ids, ["gpt-5.5", "gpt-5"]) ?? ids[0],
    };
  }
  if (provider === "google") {
    return {
      frontend: pick(ids, ["flash-lite", "flash"]) ?? ids[0],
      conversation: pick(ids, ["pro", "flash"]) ?? ids[0],
      escalation: pick(ids, ["pro"]) ?? ids[0],
    };
  }
  return { conversation: ids[0] };
}

async function main() {
  const seeded: Seeded[] = [];

  for (const { provider, env } of KEYS) {
    const key = process.env[env]?.trim();
    if (!key) continue;

    const probe: Credential = { id: "verify", provider, secret: key };
    let models: Model[];
    try {
      models = await getProvider(provider).listModels(probe);
    } catch (e) {
      console.error(`✗ ${env}: key rejected — ${(e as Error).message}`);
      continue;
    }

    const label = `${providerVendor(provider)} (env)`;
    const existing = await db.providerCredential.findFirst({
      where: { provider: toDbProvider(provider), label },
    });
    const data = {
      provider: toDbProvider(provider),
      label,
      encryptedValue: new Uint8Array(encrypt(key)),
    };
    const cred = existing
      ? await db.providerCredential.update({ where: { id: existing.id }, data })
      : await db.providerCredential.create({ data });

    seeded.push({ provider, credentialId: cred.id, models });
    console.log(`✓ ${label}: ${models.length} models (cred ${cred.id.slice(0, 8)})`);
  }

  if (seeded.length === 0) {
    console.log(
      "\nNo keys found in .env. Paste at least one of OPENAI_API_KEY / " +
        "ANTHROPIC_API_KEY / GOOGLE_API_KEY, then re-run.",
    );
    await db.$disconnect();
    return;
  }

  // Primary provider drives front-end/conversation/escalation; a second
  // provider (if present) becomes the cross-provider failover.
  const primary = seeded[0];
  const picks = rolesFor(primary.provider, primary.models);
  const role = (model?: string): RoleConfig | undefined =>
    model
      ? { credentialId: primary.credentialId, provider: primary.provider, model }
      : undefined;

  const roles: AssistantConfig["roles"] = {};
  const fe = role(picks.frontend);
  const conv = role(picks.conversation);
  const esc = role(picks.escalation);
  if (fe) roles.frontend = fe;
  if (conv) roles.conversation = conv;
  if (esc) roles.escalation = esc;

  const other = seeded.find((s) => s.provider !== primary.provider);
  if (other) {
    const op = rolesFor(other.provider, other.models);
    if (op.conversation) {
      roles.failover = {
        credentialId: other.credentialId,
        provider: other.provider,
        model: op.conversation,
      };
    }
  }

  const current = await getAssistantConfig();
  const config: AssistantConfig = {
    name:
      current.name && current.name !== "AI Assistant" ? current.name : "Test Assistant",
    logo: current.logo,
    roles,
  };
  await setAssistantConfig(config);

  console.log("\nAssistant configured:");
  for (const [r, c] of Object.entries(roles)) {
    const rc = c as RoleConfig;
    console.log(`  ${r.padEnd(13)} ${rc.provider} · ${rc.model}`);
  }
  console.log(`\nName: ${config.name}. Refine in Admin → Models. Ready to chat.`);
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
