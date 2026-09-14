/**
 * view_image live smoke (NOT in the test suite; one real model call). Seeds a
 * pool image, then runs the REAL pipeline (runAssistant + registry toolset)
 * with a question only answerable by viewing it — proving the tool→image→
 * synthetic-user-turn→model loop end to end, including Anthropic's
 * role-alternation merge.
 *
 *   $env:FIXTURES_DIR='…'
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-view-image.ts
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { getAssistantConfig } from "../src/lib/assistant";
import { runAssistant } from "../src/lib/pipeline";
import { buildToolset } from "../src/lib/tools/registry";
import { executeViewImage } from "../src/lib/tools/view-image";

const STORAGE = resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
const TENANT = process.env.OPNINFER_TENANT_ID ?? "default";
const FIXTURES = process.env.FIXTURES_DIR ?? "";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const src = join(FIXTURES, "word.png");
  if (!existsSync(src)) throw new Error("Missing fixture word.png (set FIXTURES_DIR).");

  let userId = "";
  let convId = "";
  try {
    const user = await db.user.create({
      data: {
        email: `viewimg-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword("viewimg-pw-1!"),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const convo = await db.conversation.create({ data: { userId, title: "view_image smoke" } });
    convId = convo.id;
    const ctx = { userId, conversationId: convId };

    // Seed the pool with the PINEAPPLE image (pre-ingested row, no worker needed).
    const poolDir = join(STORAGE, TENANT, "chats", convId);
    mkdirSync(poolDir, { recursive: true });
    copyFileSync(src, join(poolDir, "word.png"));
    await db.file.create({
      data: {
        userId,
        conversationId: convId,
        filename: "word.png",
        mimeType: "image/png",
        detectedMime: "image/png",
        sizeBytes: BigInt(statSync(src).size),
        storagePath: `${TENANT}/chats/${convId}/word.png`,
        status: "ready",
        processorGroup: "image",
        meta: { width: 600, height: 200 },
      },
    });

    // --- executor direct checks ---------------------------------------------
    const direct = await executeViewImage({ name: "word.png" }, ctx);
    check(
      "executor returns text + image part",
      typeof direct === "object" && direct.images?.length === 1 &&
        direct.images[0].mimeType === "image/png" && direct.images[0].dataBase64.length > 100,
    );
    const missing = await executeViewImage({ name: "nope.png" }, ctx);
    check(
      "missing image → friendly error listing available images",
      typeof missing === "string" && missing.includes("word.png"),
      String(missing),
    );

    // --- full pipeline: model must CALL view_image to answer -----------------
    const config = await getAssistantConfig();
    if (!config.roles.conversation) throw new Error("Assistant not configured.");
    const toolset = await buildToolset(ctx, { includeFiles: true });
    let text = "";
    const notices: string[] = [];
    for await (const chunk of runAssistant(
      config,
      [
        {
          role: "system",
          content:
            "FILES: this conversation has files. - word.png — image, 5 KB · 600×200 · image — use view_image to look at it",
        },
        {
          role: "user",
          content:
            "There's an image called word.png in this chat's files. What single word is written in it? You must look at it with view_image — answer with just the word.",
        },
      ],
      { userId, tools: toolset.tools, executeTool: toolset.executeTool },
    )) {
      if (chunk.type === "text") text += chunk.delta;
      else if (chunk.type === "notice") notices.push(chunk.message);
      // v0.3.x: tool activity streams as tool_status chunks, not notices.
      else if (chunk.type === "tool_status") notices.push(chunk.label);
      else if (chunk.type === "error") throw new Error(chunk.message);
    }
    check("pipeline emitted a 'Looking at word.png' status", notices.some((n) => n.includes("word.png")), JSON.stringify(notices));
    check("model SAW the image (answered PINEAPPLE)", text.toLowerCase().includes("pineapple"), text.slice(0, 120));
  } finally {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    if (convId) {
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up throwaway user and pool.");
  }

  console.log(`\n${failures === 0 ? "ALL VIEW_IMAGE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
