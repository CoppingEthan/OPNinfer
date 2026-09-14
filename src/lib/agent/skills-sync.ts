import "server-only";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Give the Sandbox agent the SAME skills the assistant has (owner ask,
 * 2026-09-02). Claude Code reads personal skills from
 * `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`; the agent's config dir is the
 * chat's state directory (mounted at ~/.claude), so mirroring the repo's
 * `skills/` into `<stateDir>/skills/` before each run makes them appear as
 * native skills — the design-graphics recipe reaches the agent that renders
 * it, not just the model that delegates. Mirrored fresh every run (a skill
 * edit applies to the next run with no restart); nothing else in the state
 * dir is touched.
 */
export async function syncAgentSkills(stateDir: string): Promise<string[]> {
  const src = resolve(process.env.OPNINFER_SKILLS_DIR ?? "./skills");
  const dest = join(stateDir, "skills");
  let names: string[] = [];
  try {
    names = (await readdir(src, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // The state dir is the CLI's `user` settings source AND writable by the
  // agent (audit 2026-09-05): a poisoned run could leave a settings.json
  // whose permission rules and hooks the CLI honours BEFORE canUseTool, on
  // every later turn of that chat. Nothing we ship lives in these files, so
  // they are cleared before each run.
  for (const stray of ["settings.json", "settings.local.json", "CLAUDE.md"]) {
    await rm(join(stateDir, stray), { force: true }).catch(() => {});
  }
  for (const name of names) {
    await cp(join(src, name), join(dest, name), { recursive: true, force: true });
  }
  return names;
}
