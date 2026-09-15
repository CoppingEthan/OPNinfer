/**
 * Screenshots of this round's UI, for eyeballing (NOT a test).
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/shot-workspace.ts
 *
 * Writes into logs/: the sidebar with folders, the composer's `+` menu open on
 * its Workflows submenu, an in-app confirm dialog (the browser ones are gone),
 * and the artifact panel showing a Word document, a spreadsheet drawn as a
 * table and a markdown file — light and dark, plus the panel at phone width.
 *
 * Everything it needs is seeded and deleted again, so it costs nothing and
 * shows the same thing every run.
 */
import { chromium, type Page } from "@playwright/test";
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolDir, chatPoolRelDir } from "../src/lib/storage";
import { upsertWorkflow } from "../src/lib/workflow-store";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "shot-workspace-1!";
const OUT = "logs";

async function signIn(email: string) {
  const jar = new Map<string, string>();
  const store = (cs: string[]) => {
    for (const c of cs) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  };
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
  store(r1.headers.getSetCookie());
  const { csrfToken } = (await r1.json()) as { csrfToken: string };
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD }),
    redirect: "manual",
  });
  store(r2.headers.getSetCookie());
  return [...jar].map(([name, value]) => ({ name, value, url: BASE }));
}

async function shot(page: Page, name: string) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${file}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const stamp = Date.now();
  const user = await db.user.create({
    data: {
      email: `shots-${stamp}@example.test`,
      name: "Sam Sample",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  for (const [name, description] of [
    ["Rewrite a document", "Rewrite or tighten anything already written, in our tone"],
    ["Reply to an email", "Draft a reply in the way we answer clients"],
    ["Weekly numbers", "Pull the week's figures together the way the board reads them"],
  ] as const) {
    await upsertWorkflow({ userId: user.id, name, description, body: `# ${name}\n\n## Steps\n\n1. …\n\n## Notes from past runs\n` });
  }

  // REAL Chrome: Playwright's bundled Chromium ships no PDF viewer, so an
  // Office preview photographs as a blank frame however well it works.
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome" });
  } catch {
    console.log("(no local Chrome — PDF previews will photograph blank)");
    browser = await chromium.launch();
  }
  try {
    // A couple of folders with chats in them, so the spacing is visible.
    const folders = [];
    for (const name of ["Clients", "Internal"]) {
      folders.push(await db.folder.create({ data: { userId: user.id, name } }));
    }
    for (const [i, title] of [
      "📦 Stock count process",
      "✉️ Supplier chase-up",
      "📊 Q3 board pack",
      "🧾 Invoice queries",
      "🛠️ Site survey notes",
    ].entries()) {
      await db.conversation.create({
        data: {
          userId: user.id,
          title,
          folderId: i < 3 ? folders[i % 2].id : null,
          updatedAt: new Date(Date.now() - i * 3_600_000),
        },
      });
    }

    const convo = await db.conversation.create({ data: { userId: user.id, title: "🗂️ Handover pack" } });
    const dir = chatPoolDir(convo.id);
    await mkdir(dir, { recursive: true });

    const NOTE =
      "# Handover — Tuesday\n\n" +
      "The **stock count** runs every Monday before opening.\n\n" +
      "1. Print the sheet from the back office\n2. Walk the aisles in order\n3. Key the totals in before 10am\n\n" +
      "> Anything that does not reconcile goes to the duty manager, not into the next week.\n";
    await writeFile(path.join(dir, "handover.md"), NOTE, "utf8");

    const CSV =
      "Region,Orders,Value,Variance\n" +
      "North,124,\"1,240.00\",+3.1%\nSouth,98,980.00,-0.4%\nWest,7,70.00,+11.2%\nEast,63,630.00,+0.8%\n";
    await writeFile(path.join(dir, "orders.csv"), CSV, "utf8");

    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    const para = (t: string, style = "") =>
      `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        para("Weekly stock count — standard operating procedure", "Title") +
        para("") +
        para("The count is run before opening on Monday. It exists so that what the system believes is on the shelf and what is actually on the shelf do not drift apart across a quarter.") +
        para("") +
        para("1. Print the count sheet from the back office terminal.") +
        para("2. Walk the aisles in the order printed, not the order they are stocked.") +
        para("3. Key the totals in before 10am so the replenishment run picks them up.") +
        para("") +
        para("Anything that does not reconcile is raised with the duty manager the same morning. It is never carried into the following week.") +
        "</w:body></w:document>",
    );
    const docx = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(path.join(dir, "stock-count-sop.docx"), docx);

    const mk = (filename: string, mimeType: string, size: number) =>
      db.file.create({
        data: {
          userId: user.id,
          conversationId: convo.id,
          filename,
          mimeType,
          sizeBytes: BigInt(size),
          storagePath: `${chatPoolRelDir(convo.id)}/${filename}`,
          kind: "generated",
          status: "ready",
        },
      });
    const doc = await mk("handover.md", "application/octet-stream", NOTE.length);
    const csv = await mk("orders.csv", "text/csv", CSV.length);
    const office = await mk("stock-count-sop.docx", "application/octet-stream", docx.length);

    const now = Date.now();
    await db.message.create({
      data: {
        conversationId: convo.id,
        userId: user.id,
        role: "user",
        content: "Put together the handover pack for the stock count.",
        createdAt: new Date(now),
      },
    });
    await db.message.create({
      data: {
        conversationId: convo.id,
        role: "assistant",
        content:
          "Here's the pack. The procedure is written up in full, the handover note is the short version for whoever is on the floor, and the regional numbers are attached so you can see where the variance sits.",
        createdAt: new Date(now + 1000),
        meta: { fileIds: [office.id, doc.id, csv.id] },
      },
    });

    const cookies = await signIn(user.email);

    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-composer-menu]", { timeout: 60_000 });
      await page.waitForTimeout(2500);

      console.log(`\n${theme}:`);
      await shot(page, `workspace-folders-${theme}`);

      // The + menu, open on its Workflows submenu.
      await page.locator("[data-composer-menu]").click();
      await page.locator("[data-composer-menu-open]").getByText("Workflows", { exact: false }).first().hover();
      await page.waitForTimeout(600);
      await shot(page, `workspace-plus-menu-${theme}`);
      await page.keyboard.press("Escape");

      // The artifact panel: a Word document laid out as the office suite draws
      // it, then a spreadsheet as a table, then markdown.
      for (const [id, label] of [
        [office.id, "office"],
        [csv.id, "csv"],
        [doc.id, "markdown"],
      ] as const) {
        await page.evaluate(
          `window.dispatchEvent(new CustomEvent("oi-open-artifact", { detail: { fileId: ${JSON.stringify(id)} } }))`,
        );
        await page.waitForSelector("[data-artifact-panel]", { timeout: 20_000 });
        // PDF rendering in particular takes a beat to paint inside the frame.
        await page.waitForTimeout(label === "office" ? 4000 : 1500);
        await shot(page, `workspace-artifact-${label}-${theme}`);
      }

      // An in-app dialog — the browser's own prompt() is gone everywhere.
      await page.evaluate(`document.querySelector("[aria-label='Close']")?.click()`);
      await page.waitForTimeout(400);
      await page.goto(`${BASE}/workflows`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      const newBtn = page.getByRole("button", { name: "+ New" }).first();
      if (await newBtn.count()) {
        await newBtn.click();
        await page.waitForTimeout(500);
        await shot(page, `workspace-dialog-${theme}`);
      }

      await ctx.close();
    }

    // …and the panel on a phone, where it takes the whole screen.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await phone.addCookies(cookies);
    const small = await phone.newPage();
    await small.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await small.waitForSelector("[data-composer-menu]", { timeout: 60_000 });
    await small.waitForTimeout(2500);
    await small.evaluate(
      `window.dispatchEvent(new CustomEvent("oi-open-artifact", { detail: { fileId: ${JSON.stringify(office.id)} } }))`,
    );
    await small.waitForSelector("[data-artifact-panel]", { timeout: 20_000 });
    await small.waitForTimeout(4000);
    console.log("\nphone:");
    await shot(small, "workspace-artifact-phone");
    await phone.close();
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { userId: user.id } });
    await db.folder.deleteMany({ where: { userId: user.id } });
    await db.workflow.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
