import type { ToolDef } from "@/lib/providers/types";
import type { ToolGroup, ToolOutput, ToolStreamEvent } from "./types";
import type { Toolset } from "./registry";

/**
 * Progressive tool disclosure — the conversation model decides its own tools.
 *
 * Replaces the frontend-role "tool router" (which pre-filtered tool groups by
 * classifying the user's message — and could starve the model of tools it
 * turned out to need). Instead, the turn starts with the cheap always-useful
 * tools plus a compact DIRECTORY of the heavier groups; the model calls
 * `enable_tools` to activate a group mid-turn, and the tool loop re-offers
 * the grown list on the next round. The powerful model makes the call, not a
 * classifier — it can never be locked out of a capability.
 */

/** Heavier groups withheld until the model asks (their schemas are the bulk
 *  of the per-turn tool cost). Everything else is live from round 1. */
export const DEFERRED_GROUPS: readonly ToolGroup[] = [
  "web",
  "image",
  "capability",
];

/** view_image is registered under `image`, but the file manifest tells the
 *  model to use it — it must be live from round 1 alongside read_file. */
/** `sandbox_task` too (owner decision, 2026-09-01): the steering says most
 *  substantive work should go through the Sandbox, and a tool the model must
 *  reach for constantly cannot sit behind a directory it has to unlock first
 *  — that would spend a round on enable_tools for nearly every real task. */
const CORE_EXCEPTIONS = new Set(["view_image", "sandbox_task"]);

/** One-line pitch per deferred group for the directory block. */
const GROUP_BLURBS: Record<string, string> = {
  web: "search the internet, read web pages, download files/repos into this chat",
  image: "generate, edit or blend images — photos, illustrations and concept art ONLY; adverts, social posts, posters, mockups or anything with text are BUILT via the design-graphics skill, not generated",
  capability: "client-specific data lookups",
};

export const ENABLE_TOOLS_DEF: ToolDef = {
  name: "enable_tools",
  description:
    "Activate additional tool groups from the MORE TOOLS directory. Call this FIRST when you need any tool listed there — the group's tools become callable immediately after.",
  parameters: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: { type: "string" },
        description: 'Group names to activate, e.g. ["web"] or ["sandbox","image"].',
      },
    },
    required: ["groups"],
  },
};

export interface ProgressiveToolset {
  /** Live tool list — GROWS IN PLACE when the model enables a group. The
   *  pipeline re-reads this array every round, so mutation is the contract. */
  defs: ToolDef[];
  /** System block describing the withheld groups; null when nothing is deferred. */
  directory: string | null;
  executeTool(name: string, argsJson: string, emit?: (evt: ToolStreamEvent) => void): Promise<ToolOutput>;
}

/** Wrap a full toolset: core tools stay live, deferred groups hide behind
 *  `enable_tools`. Pure over its inputs — unit-testable with a fake Toolset. */
export function buildProgressiveToolset(toolset: Toolset): ProgressiveToolset {
  const deferred = new Map<ToolGroup, ToolDef[]>();
  const core: ToolDef[] = [];
  for (const { group, def } of toolset.entries) {
    if (DEFERRED_GROUPS.includes(group) && !CORE_EXCEPTIONS.has(def.name)) {
      deferred.set(group, [...(deferred.get(group) ?? []), def]);
    } else {
      core.push(def);
    }
  }

  if (deferred.size === 0) {
    return { defs: [...core], directory: null, executeTool: toolset.executeTool };
  }

  const defs: ToolDef[] = [...core, ENABLE_TOOLS_DEF];
  const live = new Set(defs.map((d) => d.name));
  const directory =
    "MORE TOOLS — not yet active (deferred to save tokens), but fully yours. " +
    'When a task needs one, call enable_tools({"groups":[…]}) first; the ' +
    "group's tools become callable immediately after. Use them PROACTIVELY: " +
    "if the user's request implies current/live information, reading a URL, " +
    "running code, or working with files or images, enable the group and DO " +
    "the work in this same turn — never ask for permission first and never " +
    "offer to do it as a follow-up (the request itself is the permission; " +
    "only genuinely destructive or costly actions warrant checking). Never " +
    "claim a capability below is unavailable to you.\n" +
    [...deferred.entries()]
      .map(([g, list]) => `- ${g} — ${GROUP_BLURBS[g] ?? g}: ${list.map((d) => d.name).join(", ")}`)
      .join("\n");

  return {
    defs,
    directory,
    async executeTool(name, argsJson, emit) {
      if (name !== "enable_tools") return toolset.executeTool(name, argsJson, emit);
      let requested: string[] = [];
      try {
        const parsed = JSON.parse(argsJson || "{}") as { groups?: unknown };
        requested = Array.isArray(parsed.groups) ? parsed.groups.map(String) : [];
      } catch {
        /* falls through to the error below */
      }
      const valid = requested.filter((g) => deferred.has(g as ToolGroup));
      if (valid.length === 0) {
        return {
          text: `Error: no valid group named. Available groups: ${[...deferred.keys()].join(", ")}.`,
        };
      }
      const added: string[] = [];
      for (const g of valid) {
        for (const def of deferred.get(g as ToolGroup)!) {
          if (!live.has(def.name)) {
            live.add(def.name);
            defs.push(def);
            added.push(def.name);
          }
        }
      }
      return {
        text: added.length
          ? `Enabled ${valid.join(", ")} — now callable: ${added.join(", ")}. Proceed with the task.`
          : `Group(s) already enabled: ${valid.join(", ")}.`,
      };
    },
  };
}
