/**
 * Skills smoke (NOT in the test suite; fs + db, no LLM cost). Uses a scratch
 * skills dir with a fixture skill + assets to prove L1 listing, L2 loading,
 * asset staging (incl. non-overwrite), and name-traversal rejection — then
 * checks the repo's real seeded skills list.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-skills.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";

const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // Scratch skills dir with one fixture skill + assets.
  const scratch = join(tmpdir(), `oi-skills-${Date.now()}`);
  mkdirSync(join(scratch, "test-skill", "assets"), { recursive: true });
  writeFileSync(
    join(scratch, "test-skill", "SKILL.md"),
    "---\nname: test-skill\ndescription: A fixture skill for the smoke test.\n---\n\n# Test skill\nDo the test thing.",
  );
  writeFileSync(join(scratch, "test-skill", "assets", "template.md"), "TEMPLATE v1");
  process.env.OPNINFER_SKILLS_DIR = scratch;

  // Import AFTER setting the env so skillsRoot() resolves to the scratch dir.
  const { listSkills, buildSkillsBlock, executeLoadSkill, invalidateSkillsCache } =
    await import("../src/lib/tools/skills");
  invalidateSkillsCache();

  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `skills-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword("skills-pw-1!"),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const convo = await db.conversation.create({ data: { userId, title: "skills smoke" } });
    convId = convo.id;
    const ctx = { userId, conversationId: convId };

    // --- L1 ---------------------------------------------------------------
    const skills = await listSkills();
    check("listSkills finds the fixture", skills.some((s) => s.name === "test-skill"));
    const block = await buildSkillsBlock();
    check("L1 block lists name + description only", !!block && block.includes("test-skill: A fixture skill") && !block.includes("Do the test thing"));

    // --- L2 + assets --------------------------------------------------------
    const loaded = await executeLoadSkill({ name: "test-skill" }, ctx);
    check("load_skill returns the full body", loaded.includes("Do the test thing"));
    check("…and staged the asset", loaded.includes("Staged into this chat's files: template.md"));
    const poolAsset = join(STORAGE, TENANT, "chats", convId, "template.md");
    check("asset bytes in the pool", existsSync(poolAsset) && readFileSync(poolAsset, "utf8") === "TEMPLATE v1");
    const row = await db.file.findFirst({ where: { conversationId: convId, filename: "template.md" } });
    check("asset registered as a files row", row?.kind === "generated");

    // --- non-overwrite -------------------------------------------------------
    writeFileSync(poolAsset, "USER EDITED");
    const again = await executeLoadSkill({ name: "test-skill" }, ctx);
    check("re-load keeps the user's edits", again.includes("Already present (kept your edits): template.md"));
    check("…file untouched", readFileSync(poolAsset, "utf8") === "USER EDITED");

    // --- safety ---------------------------------------------------------------
    const traversal = await executeLoadSkill({ name: "../secrets" }, ctx);
    check("traversal-ish names rejected", traversal.startsWith("Error:"), traversal.slice(0, 80));
    const missing = await executeLoadSkill({ name: "nope" }, ctx);
    check("unknown skill lists available", missing.includes("Available: test-skill"));

    // --- the repo's real seeded skills -----------------------------------------
    process.env.OPNINFER_SKILLS_DIR = resolve("./skills");
    invalidateSkillsCache();
    const real = await listSkills();
    check(
      "repo seed skills present (email-drafting, meeting-notes)",
      real.some((s) => s.name === "email-drafting") && real.some((s) => s.name === "meeting-notes"),
      real.map((s) => s.name).join(", "),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    if (convId) {
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up scratch skills, throwaway user and pool.");
  }

  console.log(`\n${failures === 0 ? "ALL SKILLS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
