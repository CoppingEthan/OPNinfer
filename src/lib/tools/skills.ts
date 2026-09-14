import "server-only";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@/lib/db";
import { chatPoolDir, chatPoolRelDir } from "@/lib/storage";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx } from "./types";

/**
 * Skills — progressive disclosure (v0.3 step 7). A skill is a directory
 * `skills/<name>/SKILL.md` with `name:`/`description:` frontmatter (the
 * https://github.com/anthropics/skills format, so those are drop-in):
 *
 *  L1  every turn: just name + description in the system prompt.
 *  L2  on demand: `load_skill` returns the full body (read fresh from disk,
 *      so edits apply without a restart) and stages `assets/` into the
 *      conversation pool WITHOUT overwriting (mid-session edits survive).
 */

function skillsRoot(): string {
  return resolve(process.env.OPNINFER_SKILLS_DIR ?? "./skills");
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** Parse `--- name: x / description: y ---` frontmatter + body. */
export function parseSkillMd(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

// Cheap cache — the list is re-scanned at most once per minute.
let cache: { at: number; skills: SkillInfo[] } | null = null;
const CACHE_MS = 60_000;

export async function listSkills(): Promise<SkillInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.skills;
  const skills: SkillInfo[] = [];
  try {
    const entries = await readdir(skillsRoot(), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        const raw = await readFile(join(skillsRoot(), e.name, "SKILL.md"), "utf8");
        const { meta } = parseSkillMd(raw);
        skills.push({
          name: meta.name || e.name,
          description: meta.description || "(no description)",
        });
      } catch {
        /* no SKILL.md — not a skill */
      }
    }
  } catch {
    /* no skills directory — fine */
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), skills };
  return skills;
}

/** Test hook / admin refresh. */
export function invalidateSkillsCache(): void {
  cache = null;
}

/** L1 block for the system prompt; null when no skills are installed. */
export async function buildSkillsBlock(): Promise<string | null> {
  const skills = await listSkills();
  if (skills.length === 0) return null;
  return (
    "SKILLS — specialised playbooks you can load with the load_skill tool " +
    "when a task matches (load BEFORE attempting the task):\n" +
    skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
  );
}

export const LOAD_SKILL_DEF: ToolDef = {
  name: "load_skill",
  description:
    "Load a skill's full instructions by name (from the SKILLS list). Any bundled asset files are staged into this conversation's files.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact skill name from the SKILLS list." },
    },
    required: ["name"],
  },
};

/** Resolve a skill name to its directory, refusing traversal. */
async function skillDir(name: string): Promise<string | null> {
  const safe = name.trim();
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(safe)) return null;
  const dir = join(skillsRoot(), safe);
  try {
    const st = await stat(dir);
    return st.isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export async function executeLoadSkill(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const name = String(args.name ?? "").trim();
  const dir = await skillDir(name);
  if (!dir) {
    const available = (await listSkills()).map((s) => s.name).join(", ");
    return `Error: no skill named "${name}". Available: ${available || "(none)"}.`;
  }

  let body: string;
  try {
    body = parseSkillMd(await readFile(join(dir, "SKILL.md"), "utf8")).body;
  } catch {
    return `Error: skill "${name}" has no readable SKILL.md.`;
  }

  // Stage assets/ into the pool, never overwriting; register files rows so
  // they show in the manifest and are downloadable.
  const staged: string[] = [];
  const kept: string[] = [];
  const assetsDir = join(dir, "assets");
  if (existsSync(assetsDir)) {
    const poolDir = chatPoolDir(ctx.conversationId);
    await mkdir(poolDir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = (await readdir(assetsDir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      /* unreadable assets dir — skip staging */
    }
    for (const file of entries) {
      const dest = join(poolDir, file);
      if (existsSync(dest)) {
        kept.push(file);
        continue;
      }
      try {
        await copyFile(join(assetsDir, file), dest);
        const st = await stat(dest);
        await db.file.create({
          data: {
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            filename: file,
            mimeType: "application/octet-stream",
            sizeBytes: BigInt(st.size),
            storagePath: `${chatPoolRelDir(ctx.conversationId)}/${file}`,
            kind: "generated",
            meta: { stagedFromSkill: name },
          },
        });
        staged.push(file);
      } catch {
        /* one bad asset must not sink the skill */
      }
    }
  }

  let footer = "";
  if (staged.length) footer += `\n\n[Staged into this chat's files: ${staged.join(", ")}]`;
  if (kept.length) footer += `\n[Already present (kept your edits): ${kept.join(", ")}]`;
  return `SKILL ${name} loaded — follow these instructions:\n\n${body}${footer}`;
}
