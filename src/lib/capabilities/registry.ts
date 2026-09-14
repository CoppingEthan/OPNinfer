import "server-only";
import { getSetting, setSetting } from "@/lib/settings";
import { encrypt, decrypt } from "@/lib/crypto";
import type { RegisteredTool, ToolCtx } from "@/lib/tools/types";
import { sandboxAgent } from "./sandbox-agent";
import { LOCAL_CAPABILITIES } from "./local";
import type { Capability, CapabilityStored } from "./types";

/**
 * All capabilities available on this instance, each OFF until an admin enables
 * it: the ones that ship in the product, plus whatever `local.ts` adds.
 *
 * Client-specific capabilities come through `LOCAL_CAPABILITIES` rather than
 * being listed here, so that a deployment carrying private tooling changes ONE
 * file and adds its own — see the note in `local.ts`.
 */
export const CAPABILITIES: Capability[] = [...LOCAL_CAPABILITIES, sandboxAgent];

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

const settingKey = (id: string) => `capability_${id}`;

/** Read a capability's stored state, decrypting secret fields. */
export async function getCapabilityState(
  cap: Capability,
): Promise<{ enabled: boolean; config: Record<string, unknown> }> {
  const stored = await getSetting<CapabilityStored>(settingKey(cap.id));
  if (!stored) return { enabled: false, config: {} };
  const config = { ...stored.config };
  for (const field of cap.secretFields) {
    const v = config[field];
    if (typeof v === "string" && v) {
      try {
        config[field] = decrypt(Buffer.from(v, "base64"));
      } catch {
        config[field] = ""; // master key changed — treat as unset
      }
    }
  }
  return { enabled: stored.enabled === true, config };
}

/** Persist a capability's state, encrypting secret fields at rest. */
export async function setCapabilityState(
  cap: Capability,
  enabled: boolean,
  config: Record<string, unknown>,
): Promise<void> {
  const toStore = { ...config };
  for (const field of cap.secretFields) {
    const v = toStore[field];
    if (typeof v === "string" && v) {
      toStore[field] = encrypt(v).toString("base64");
    }
  }
  await setSetting(settingKey(cap.id), {
    enabled,
    config: toStore,
  } satisfies CapabilityStored);
}

/**
 * The enabled capabilities' tools as registry-shaped entries — merged into
 * the per-turn toolset by buildToolset. Config is captured per turn (admin
 * changes apply on the next message).
 */
export async function loadCapabilityTools(): Promise<RegisteredTool[]> {
  const out: RegisteredTool[] = [];
  for (const cap of CAPABILITIES) {
    const state = await getCapabilityState(cap);
    if (!state.enabled) continue;
    const parsed = cap.configSchema.safeParse(state.config);
    if (!parsed.success) continue; // misconfigured → tools stay off
    const config = parsed.data as Record<string, unknown>;
    for (const def of cap.toolsFor ? await cap.toolsFor(config) : cap.tools) {
      out.push({
        def,
        group: "capability",
        execute: (args: Record<string, unknown>, ctx: ToolCtx) =>
          cap.execute(def.name, args, config, ctx),
      });
    }
  }
  return out;
}
