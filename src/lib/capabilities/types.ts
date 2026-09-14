import type { ZodTypeAny } from "zod";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx, ToolOutput } from "@/lib/tools/types";

/**
 * Client-specific capabilities (v0.3 step 10). OPNinfer is one instance per
 * org, so a capability is simply a named tool bundle that ships in the
 * product SWITCHED OFF and is enabled + configured per instance on the
 * Admin → Tools page (owner-approved design — no email-domain grants).
 *
 * Adding a capability = one module + one registry entry, mirroring the
 * provider pattern.
 */
export interface Capability {
  id: string;
  label: string;
  description: string;
  /** Tools this capability contributes (group is always "capability"). */
  tools: ToolDef[];
  /** Optional: build the tool definitions from the instance's parsed config
   *  instead of `tools` — for a description that must carry admin-edited
   *  text (the Sandbox's steering) rather than a static string. */
  toolsFor?(config: Record<string, unknown>): ToolDef[] | Promise<ToolDef[]>;
  /** Validates the admin's config form. `z.object({})` = nothing to configure,
   *  and the Tools page then shows only the on/off switch. */
  configSchema: ZodTypeAny;
  /**
   * Optional read-only line under the switch naming where the data comes from,
   * so an admin can see it without being able to break it (a fixed source is
   * the design — see the note on `configSchema`). It belongs to the capability
   * rather than to the Tools page, so a capability that ships outside this
   * repository can carry its own without the page knowing its id.
   */
  source?: { label: string; value: string };
  /** Config fields encrypted with the master key at rest (API keys etc). */
  secretFields: string[];
  /**
   * Execute one of `tools` with the instance's validated config.
   *
   * Returns plain text, or a `ToolOutput` when the call has more to hand back
   * than words — property_search returns each listing as a SOURCE so the reply
   * carries the clickable sources pill, the same as the web tools.
   */
  execute(
    tool: string,
    args: Record<string, unknown>,
    config: Record<string, unknown>,
    ctx: ToolCtx,
  ): Promise<string | ToolOutput>;
}

/** Stored shape of `capability_<id>` settings keys. */
export interface CapabilityStored {
  enabled: boolean;
  /** Plain config; secret fields hold base64(encrypt(value)) instead. */
  config: Record<string, unknown>;
}
