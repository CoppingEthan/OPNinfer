/**
 * Live web-tools smoke (NOT in the test suite; uses the real Tavily key and
 * the ingestion worker). Executes the four web tools directly (no LLM cost):
 * search, scrape, search+read, and download_file — including SSRF blocks and
 * the worker picking up the downloaded file.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-web-tools.ts
 */
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import {
  executeWebSearch,
  executeWebScrape,
  executeWebSearchAndRead,
  executeDownloadFile,
} from "../src/lib/tools/web";

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
        email: `web-smoke-${Date.now()}@example.test`,
        passwordHash: await hashPassword("web-smoke-pw-1234!"),
        role: "user",
        emailVerified: new Date(),
      },
    });
    userId = user.id;
    const convo = await db.conversation.create({
      data: { userId, title: "web smoke" },
    });
    convId = convo.id;
    const ctx = { userId, conversationId: convId };

    // Executors now return rich ToolOutput (text + sources) — normalize the
    // way the registry does, and keep the sources for their own checks.
    const text = (r: string | { text: string }) => (typeof r === "string" ? r : r.text);
    const sources = (r: string | { sources?: { url: string; title?: string }[] }) =>
      typeof r === "string" ? [] : (r.sources ?? []);

    // --- web_search ---------------------------------------------------------
    const sRaw = await executeWebSearch({ query: "OpenAI GPT-5 release", num_results: 3 });
    const s = text(sRaw);
    check("web_search returns formatted results", s.includes("1.") && s.includes("URL:"), s.slice(0, 120));
    check(
      "web_search returns sources (url+title)",
      sources(sRaw).length > 0 && sources(sRaw).every((x) => /^https?:\/\//.test(x.url)),
      JSON.stringify(sources(sRaw).slice(0, 2)),
    );

    // --- web_scrape ----------------------------------------------------------
    const scRaw = await executeWebScrape({ urls: ["https://example.com"] });
    const sc = text(scRaw);
    check("web_scrape reads a page", sc.includes("Example Domain"), sc.slice(0, 120));
    check("web_scrape returns the page as a source", sources(scRaw).some((x) => x.url.includes("example.com")));
    const scBad = text(await executeWebScrape({ urls: [] }));
    check("web_scrape rejects empty urls", scBad.startsWith("Error:"));

    // --- web_search_and_read --------------------------------------------------
    const sr = text(await executeWebSearchAndRead({ query: "Bank of England base rate today", num_results: 2 }));
    check(
      "web_search_and_read lists results + reads top page",
      sr.includes("Results for") && sr.includes("Full content of top result"),
      sr.slice(0, 120),
    );

    // --- download_file: SSRF blocks -------------------------------------------
    for (const bad of [
      "http://localhost:3000/api/files",
      "http://127.0.0.1:5432/",
      "http://169.254.169.254/latest/meta-data/",
      "http://db.internal/secret",
      "ftp://example.com/file.zip",
    ]) {
      const out = text(await executeDownloadFile({ url: bad }, ctx));
      check(`download_file blocks ${bad}`, out.startsWith("Error:"), out.slice(0, 80));
    }

    // --- download_file: real file into the pool --------------------------------
    const dl = text(
      await executeDownloadFile(
        { url: "https://raw.githubusercontent.com/anthropics/skills/main/README.md" },
        ctx,
      ),
    );
    check("download_file fetches a real file", dl.startsWith("Downloaded"), dl.slice(0, 120));
    const poolFile = join(STORAGE, TENANT, "chats", convId, "README.md");
    check("…bytes are in the conversation pool", existsSync(poolFile));
    const row = await db.file.findFirst({ where: { conversationId: convId, filename: "README.md" } });
    check(
      "…files row created (kind=generated, pending for the worker)",
      row?.kind === "generated" && (row?.status === "pending" || row?.status === "processing" || row?.status === "ready"),
      `${row?.kind}/${row?.status}`,
    );

    // --- worker ingests the download -------------------------------------------
    if (row) {
      const deadline = Date.now() + 60_000;
      let final = row;
      for (;;) {
        final = (await db.file.findUnique({ where: { id: row.id } }))!;
        if (final.status !== "pending" && final.status !== "processing") break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      check(
        "ingestion worker prepared the downloaded file",
        final.status === "ready" && !!final.contentPath,
        `${final.status}/${final.processorGroup}`,
      );
    }
  } finally {
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    if (convId) {
      const dir = join(STORAGE, TENANT, "chats", convId);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    await db.$disconnect();
    console.log("\nCleaned up throwaway user and pool.");
  }

  console.log(`\n${failures === 0 ? "ALL WEB-TOOL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
