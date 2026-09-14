/**
 * Gemini image tools live smoke (NOT in the test suite; costs ~$0.20 of
 * image credit). Generates, edits, and quota-blocks for real.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-image-tools.ts
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import {
  executeImageGeneration,
  executeImageEdit,
} from "../src/lib/tools/images";

const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `img-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword("img-smoke-pw-1!"),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const convo = await db.conversation.create({ data: { userId, title: "image smoke" } });
    convId = convo.id;
    const ctx = { userId, conversationId: convId };

    // --- generate --------------------------------------------------------------
    const gen = await executeImageGeneration(
      { prompt: "A solid red circle centered on a plain white background, flat minimal style", aspect_ratio: "1:1" },
      ctx,
    );
    check(
      "image_generation returns file + review image",
      typeof gen === "object" && gen.images?.length === 1 && gen.text.includes("Created"),
      typeof gen === "string" ? gen : gen.text,
    );
    if (typeof gen === "string") throw new Error("generation failed, aborting");

    const genName = gen.text.match(/"([^"]+)"/)?.[1] ?? "";
    check("…file exists in the pool", existsSync(join(STORAGE, TENANT, "chats", convId, genName)), genName);
    const row = await db.file.findFirst({ where: { conversationId: convId, filename: genName } });
    check("…files row kind=generated with meta", row?.kind === "generated" && !!(row?.meta as { model?: string })?.model);
    const usage = await db.usageRecord.findFirst({ where: { userId, role: "image" } });
    check("…usage row with flat image cost", !!usage && Number(usage.costEstimate) > 0.01, `$${usage?.costEstimate}`);

    // --- edit -------------------------------------------------------------------
    const edit = await executeImageEdit(
      { prompt: "Change the red circle to a blue square", image: genName },
      ctx,
    );
    check(
      "image_edit consumes the pool image and produces a new file",
      typeof edit === "object" && edit.text.includes("Created"),
      typeof edit === "string" ? edit : edit.text,
    );

    // --- honest error on missing source ------------------------------------------
    const bad = await executeImageEdit({ prompt: "x", image: "ghost.png" }, ctx);
    check("missing source → friendly error", typeof bad === "string" && bad.startsWith("Error:"), String(bad));

    // --- quota -------------------------------------------------------------------
    await db.setting.upsert({
      where: { key: "image_tools_config" },
      create: { key: "image_tools_config", value: { flashWeeklyLimit: 2 } },
      update: { value: { flashWeeklyLimit: 2 } },
    });
    const blocked = await executeImageGeneration({ prompt: "another circle" }, ctx);
    check(
      "weekly quota blocks the 3rd standard image (limit 2)",
      typeof blocked === "string" && blocked.includes("quota"),
      String(blocked).slice(0, 100),
    );
  } finally {
    await db.setting.delete({ where: { key: "image_tools_config" } }).catch(() => {});
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    if (convId) {
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up throwaway user, pool, and quota override.");
  }

  console.log(`\n${failures === 0 ? "ALL IMAGE-TOOL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
