/**
 * Live browser test of the artifact panel.
 *
 * What only a real browser can answer:
 *
 *   1. clicking a file card opens THAT file beside the chat;
 *   2. an IMAGE never opens a preview — the owner's rule, checked as a
 *      NEGATIVE CONTROL in both places it is enforced (the panel refuses to
 *      show one, and the route answers 415);
 *   3. at 390px the panel fills the screen AND its close cross is reachable.
 *      That last one is not hypothetical: an inline `width` beat `inset-0`
 *      and pushed every control off the right edge, so the panel could be
 *      opened and not shut. Nothing but measuring it at phone width finds it;
 *   4. it SLIDES in rather than appearing — measured frame by frame, because
 *      "the class is on the element" proves nothing about motion;
 *   5. a Word document previews as a laid-out PDF, a CSV draws as a table,
 *      and an SVG is framed rather than refused for being an image.
 *
 * No model calls — the files are seeded, so this is free and deterministic.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-artifact-panel.ts
 */
import { chromium, type Page } from "@playwright/test";
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { chatPoolDir, chatPoolRelDir } from "../src/lib/storage";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "artifact-test-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

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

const panel = (page: Page) => page.locator("[data-artifact-panel]");

/**
 * Wait until the panel has finished sliding.
 *
 * Not politeness — the first version of this harness measured the close cross
 * the instant the panel became "visible", which is frame ONE of a 220ms
 * animation, and reported it as off-screen at x=738 on a 390px phone. The
 * panel was fine; the stopwatch was wrong. Waiting for the outcome (transform
 * back to zero) rather than for a duration is the same rule as everywhere else.
 */
async function settled(page: Page, timeoutMs = 5_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const x = (await page.evaluate(`
      (() => {
        const el = document.querySelector("[data-artifact-panel]");
        if (!el) return null;
        return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      })()
    `)) as number | null;
    if (x !== null && Math.abs(x) < 0.5) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`panel never settled (x=${x})`);
    await page.waitForTimeout(25);
  }
}

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: {
      email: `artifact-${stamp}@example.test`,
      name: "Ada Artifact",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  const browser = await chromium.launch();
  try {
    const convo = await db.conversation.create({
      data: { userId: user.id, title: "Artifact test" },
    });

    // Two real files on disk: one readable, one an image that must never open.
    const dir = chatPoolDir(convo.id);
    await mkdir(dir, { recursive: true });
    const NOTE = "# Handover\n\nThis is the **document** under test.\n\n- one\n- two\n";
    await writeFile(path.join(dir, "handover.md"), NOTE, "utf8");
    // A 1x1 PNG, so it is a genuine image rather than a name that looks like one.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(dir, "chart.png"), png);
    const CSV = "Region,Orders,Value\nNorth,124,\"1,240.00\"\nSouth,98,980.00\nWest,7,70.00\n";
    await writeFile(path.join(dir, "orders.csv"), CSV, "utf8");
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">' +
      '<rect width="120" height="40" fill="#123"/><text x="8" y="26" fill="#fff">MARK</text></svg>';
    await writeFile(path.join(dir, "mark.svg"), SVG, "utf8");
    // A REAL .docx, built here rather than copied from whatever this instance
    // happens to hold — so the check is the same on an empty install, and no
    // one's document is dragged into a test run.
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        // Several real paragraphs on purpose: counting the ink on a page with
        // one short line on it is mostly counting antialiasing, and would pass
        // on a render that had very nearly failed.
        '<w:p><w:r><w:t>Quarterly handover</w:t></w:r></w:p><w:p><w:r><w:t>The stock count runs before opening on Monday so that what the system believes is on the shelf and what is actually on the shelf do not drift apart across a quarter.</w:t></w:r></w:p><w:p><w:r><w:t>Print the count sheet from the back office terminal before the doors open.</w:t></w:r></w:p><w:p><w:r><w:t>Walk the aisles in the order printed, not the order they happen to be stocked.</w:t></w:r></w:p><w:p><w:r><w:t>Key the totals in before ten so the replenishment run picks them up the same day.</w:t></w:r></w:p><w:p><w:r><w:t>Anything that does not reconcile is raised with the duty manager that morning and never carried into the following week.</w:t></w:r></w:p>' +
        "</w:body></w:document>",
    );
    const docx = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(path.join(dir, "report.docx"), docx);

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
    const img = await mk("chart.png", "image/png", png.length);
    const csv = await mk("orders.csv", "text/csv", CSV.length);
    const svg = await mk("mark.svg", "image/svg+xml", SVG.length);
    // Deliberately NO contentPath: nothing has prepared text for it, so the
    // only way it can preview at all is the conversion engine. That makes this
    // one file a probe for whether the server under test actually has one.
    const office = await mk("report.docx", "application/octet-stream", docx.length);

    // A reply that presents both, so the cards render in the thread.
    const now = Date.now();
    await db.message.create({
      data: {
        conversationId: convo.id,
        userId: user.id,
        role: "user",
        content: "Show me the handover",
        createdAt: new Date(now),
      },
    });
    await db.message.create({
      data: {
        conversationId: convo.id,
        role: "assistant",
        content: "Here it is.",
        createdAt: new Date(now + 1000),
        meta: { fileIds: [doc.id, img.id, csv.id, svg.id, office.id] },
      },
    });

    const cookies = await signIn(user.email);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      // A REAL screen, not a 1x one. Everything this harness checks about the
      // PDF renderer — the backing-store scaling especially — takes a
      // different path at devicePixelRatio 1, which is where an owner's
      // "page 1 is upside down" would hide from it entirely.
      deviceScaleFactor: 2,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const console_: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console_.push(`${m.type()}: ${m.text()}`);
    });
    const bad: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });

    // A SAVED PANEL WIDTH, because anyone who has ever dragged the panel has
    // one. It is read from localStorage in an effect, so the panel mounts at
    // the 480px default and changes width a moment later — which re-renders
    // whichever page is already on screen while its first render is still in
    // flight. Two render() calls on one canvas is undefined behaviour in
    // pdf.js, and the owner saw it as page 1 upside down. A fresh profile
    // never has this value, which is exactly why the harness could not see it.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("oi-artifact-width", "560");
      } catch {
        /* private window */
      }
    });

    // NEVER networkidle on /chat — the live feed holds a request open forever.
    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-chat-scroll]", { timeout: 60_000 });
    await page.waitForTimeout(2500);

    check("the panel is not there until something asks for it", (await panel(page).count()) === 0);

    // ---- 1. a card opens that file -------------------------------------
    // Plant the sampler BEFORE the click: an animation cannot be measured
    // after it has finished, and reading a class name would only prove the
    // class is there — not that anything moved.
    await page.evaluate(`
      window.__slide = [];
      const obs = new MutationObserver(() => {
        const el = document.querySelector("[data-artifact-panel]");
        if (!el || window.__watching) return;
        window.__watching = true;
        let n = 0;
        const tick = () => {
          const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          window.__slide.push(Math.round(m.m41));
          if (++n < 45) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    `);
    await page.locator('[data-file-card="handover.md"] button').first().click();
    await panel(page).waitFor({ state: "visible", timeout: 20_000 });
    check(
      "clicking a file card opens THAT file",
      (await panel(page).getAttribute("data-artifact-panel")) === doc.id,
    );
    // Visible is not loaded: the header says "Loading…" until the metadata
    // lands. Wait for the outcome, never for a stopwatch.
    await panel(page)
      .getByText("handover.md", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    // …and metadata is not the body: it is fetched separately, so wait for the
    // document's own words before asking whether they rendered.
    await panel(page)
      .getByText("under test", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const header = await panel(page).innerText();
    check("the header names the file and its size", /handover\.md/.test(header) && /B|KB/.test(header), header.split("\n").slice(0, 2).join(" · "));
    check(
      "the markdown is rendered, not shown as source",
      (await panel(page).locator("strong").count()) > 0,
      `${await panel(page).locator("strong").count()} bold runs`,
    );

    for (const label of ["Download", "Close"]) {
      check(`the ${label} control is there`, (await panel(page).getByLabel(label).count()) > 0);
    }

    // ---- 1b. it slides, and lands ---------------------------------------
    const settleMs = await settled(page);
    const slide = (await page.evaluate("window.__slide")) as number[];
    const moved = new Set(slide).size;
    check(
      "it STARTS off-screen to the right",
      slide.length > 0 && Math.max(...slide) > 100,
      `first ${slide[0]}px, max ${slide.length ? Math.max(...slide) : "-"}px`,
    );
    check(
      "…travels across several frames rather than snapping",
      moved >= 3,
      `${moved} distinct positions over ${slide.length} frames`,
    );
    check(
      "…and settles flush against the conversation, quickly",
      slide.length > 0 && Math.abs(slide[slide.length - 1]) <= 1 && settleMs < 1_000,
      `${slide[slide.length - 1]}px after ${settleMs}ms`,
    );

    // ---- 2. an image must NEVER be RENDERED ---------------------------
    // (Opening the panel on one is fine and better than a dead click — it
    // says so and offers the download. What must never happen is the image
    // being shown here, where it would duplicate the inline copy.)
    const imgCard = page.locator('[data-file-card="chart.png"]');
    if ((await imgCard.count()) > 0) {
      await imgCard.locator("button").first().click();
      await page.waitForTimeout(1200);
      const shown = await panel(page).innerText().catch(() => "");
      check(
        "NEGATIVE CONTROL: an image never renders in the panel",
        !shown.includes("chart.png") || /doesn't preview here/i.test(shown),
        shown.split("\n").slice(0, 3).join(" · "),
      );
    } else {
      check("NEGATIVE CONTROL: an image is not offered as a file card at all", true, "(rendered inline instead)");
    }

    // …and the route refuses it too, so the rule does not rest on the UI.
    const res = await page.request.get(`${BASE}/api/files/${img.id}/preview`);
    check("NEGATIVE CONTROL: the preview route refuses an image (415)", res.status() === 415, `status ${res.status()}`);
    const ok = await page.request.get(`${BASE}/api/files/${doc.id}/preview`);
    check("…while serving the document inline", ok.status() === 200 && (ok.headers()["content-disposition"] ?? "").startsWith("inline"), `${ok.status()} ${ok.headers()["content-disposition"] ?? ""}`);
    check("…sandboxed, so an HTML artifact cannot touch this origin", (ok.headers()["content-security-policy"] ?? "") === "sandbox");

    // ---- 2b. the formats that are the point of this round ---------------
    const openIt = async (fileId: string, waitFor: RegExp | string) => {
      await page.evaluate(
        `window.dispatchEvent(new CustomEvent("oi-open-artifact", { detail: { fileId: ${JSON.stringify(fileId)} } }))`,
      );
      await panel(page).waitFor({ state: "visible", timeout: 20_000 });
      await panel(page).getByText(waitFor).first().waitFor({ state: "visible", timeout: 20_000 });
    };

    // A spreadsheet-shaped file is drawn as a TABLE, not dumped as raw text —
    // and the quoted comma stays inside one cell.
    await openIt(csv.id, "orders.csv");
    const table = panel(page).locator("table");
    await table.first().waitFor({ state: "visible", timeout: 20_000 });
    const headers = await table.locator("th").allInnerTexts();
    check("a CSV draws as a table with its own header row", headers.join("|") === "Region|Orders|Value", headers.join("|"));
    const firstRow = await table.locator("tbody tr").first().locator("td").allInnerTexts();
    check(
      "…and a quoted comma stays in ONE cell",
      firstRow[2] === "1,240.00",
      firstRow.join(" / "),
    );

    // An SVG is vector source and never renders inline in a reply, so unlike a
    // PNG there is nothing to duplicate — it must NOT be swept up by the image
    // rule. This is the counterpart to the image negative control above.
    const svgRes = await page.request.get(`${BASE}/api/files/${svg.id}/preview`);
    check(
      "an SVG previews rather than being refused as an image",
      svgRes.status() === 200 && (svgRes.headers()["content-type"] ?? "").startsWith("image/svg"),
      `${svgRes.status()} ${svgRes.headers()["content-type"] ?? ""}`,
    );

    // The owner's ask: Office files shown exactly as the office suite would.
    // This file has no prepared text, so a 200 here can only have come from the
    // LibreOffice conversion.
    const offRes = await page.request.get(`${BASE}/api/files/${office.id}/preview`);
    const offType = offRes.headers()["content-type"] ?? "";
    if (offRes.status() === 415) {
      check(
        "a .docx converts to PDF for preview",
        false,
        "415 — the SERVER under test has no GOTENBERG_URL. Add it to .env and restart pnpm dev.",
      );
    } else {
      check(
        "a .docx converts to PDF for preview — the real layout, not extracted text",
        offRes.status() === 200 && offType.startsWith("application/pdf"),
        `${offRes.status()} ${offType}`,
      );
      const head = (await offRes.body()).subarray(0, 5).toString("latin1");
      check("…and the bytes really are a PDF", head === "%PDF-", head);
      await openIt(office.id, "report.docx");

      /**
       * THE point of this whole section, and the reason it is worth running in
       * headless Chromium specifically: Playwright's bundled Chromium ships NO
       * PDF VIEWER AT ALL. An <iframe> here could never draw a page. So if the
       * pixels below exist, they were produced by our own renderer and by
       * nothing the browser brought — which is exactly the property the owner's
       * report demanded, their Chrome having been set to download PDFs rather
       * than display them.
       */
      const view = panel(page).locator("[data-pdf-view]");
      await view.waitFor({ state: "visible", timeout: 20_000 });
      // The text layer only exists once a page has finished rendering.
      try {
        await view.locator("[data-pdf-text] span").first().waitFor({ state: "attached", timeout: 30_000 });
      } catch (e) {
        // A render that never happens must say why, or the next hour goes on
        // guessing which of the worker, the fetch and the canvas gave up.
        console.error("panel says:", (await panel(page).innerText()).replace(/\s+/g, " ").slice(0, 200));
        console.error("console:", console_.slice(0, 6).join(" | ") || "(nothing)");
        console.error("failed requests:", bad.slice(0, 6).join(" | ") || "(none)");
        throw e;
      }

      check(
        "NEGATIVE CONTROL: no iframe at all — this browser cannot draw a PDF",
        (await panel(page).locator("iframe").count()) === 0,
      );

      const canvas = await view.locator("canvas").first().boundingBox();
      check(
        "a .docx is DRAWN as a laid-out page",
        !!canvas && canvas.width > 200 && canvas.height > 200,
        canvas ? `${Math.round(canvas.width)}x${Math.round(canvas.height)}` : "no canvas",
      );
      // …and it is not blank: a canvas of the right size full of nothing is
      // exactly what a broken render looks like.
      const ink = await view.locator("canvas").first().evaluate((c) => {
        const el = c as HTMLCanvasElement;
        const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
        return n;
      });
      check("…with actual ink on it, not an empty canvas", ink > 3_000, `${ink} dark pixels`);

      // WHICH WAY UP. The test document is several paragraphs at the top of an
      // otherwise empty A4 page, so a correct render is top-heavy by a mile
      // and a flipped one is bottom-heavy. Counting ink alone cannot tell them
      // apart — it is the same pixels either way.
      const halves = await view.locator("canvas").first().evaluate((c) => {
        const el = c as HTMLCanvasElement;
        const half = Math.floor(el.height / 2);
        const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
        let top = 0;
        let bottom = 0;
        for (let y = 0; y < el.height; y++) {
          for (let x = 0; x < el.width; x++) {
            if (d[(y * el.width + x) * 4] < 200) {
              if (y < half) top++;
              else bottom++;
            }
          }
        }
        return { top, bottom };
      });
      check(
        "…the RIGHT WAY UP — the text is at the top of the page, not the bottom",
        halves.top > halves.bottom * 3,
        `top ${halves.top} vs bottom ${halves.bottom}`,
      );

      // A picture of a page would lose this, which is why it is not a picture.
      const words = await view.locator("[data-pdf-text] span").allInnerTexts();
      check(
        "…and the words are still text — selectable, copyable, searchable",
        words.join(" ").includes("Quarterly handover"),
        words.join(" ").slice(0, 60),
      );
    }

    /**
     * A file whose ROW SIZE IS WRONG must still be served whole.
     *
     * `files.size_bytes` lags — `present_files` fires mid-run and `syncPool`
     * only re-stamps the row when the agent finishes — so the column can say
     * one thing while the disk says another. The route used to put that column
     * in Content-Length while streaming the real file, and the browser stopped
     * reading at the number: a 116 KB PDF arrived as a fragment and pdf.js
     * refused it as "Invalid PDF structure". Found live on a real document.
     */
    {
      const bytes = await (await page.request.get(`${BASE}/api/files/${office.id}/preview`)).body();
      await writeFile(path.join(dir, "stale.pdf"), bytes);
      const stale = await db.file.create({
        data: {
          userId: user.id,
          conversationId: convo.id,
          filename: "stale.pdf",
          mimeType: "application/pdf",
          // Deliberately, badly wrong — as a lagging row is.
          sizeBytes: BigInt(512),
          storagePath: `${chatPoolRelDir(convo.id)}/stale.pdf`,
          kind: "generated",
          status: "ready",
        },
      });
      const res2 = await page.request.get(`${BASE}/api/files/${stale.id}/preview`);
      const got = await res2.body();
      check(
        "a file whose row size is stale is still served WHOLE, not truncated",
        got.length === bytes.length,
        `${got.length} of ${bytes.length} bytes, header said ${res2.headers()["content-length"]}`,
      );
    }

    // Markup is still framed, and still sandboxed — that is what makes reading
    // an agent-written page here safe, and it is the half that must NOT relax.
    await openIt(svg.id, "mark.svg");
    {
      const frame = panel(page).locator("iframe").first();
      check(
        "an SVG IS sandboxed — the half that must not be relaxed",
        (await frame.getAttribute("sandbox")) === "",
        `sandbox=${JSON.stringify(await frame.getAttribute("sandbox"))}`,
      );
    }

    // ---- 3. close, then the phone ---------------------------------------
    await panel(page).getByLabel("Close").click();
    await page.waitForTimeout(500);
    check("Close shuts it", (await panel(page).count()) === 0);

    await ctx.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    await phone.addCookies(cookies);
    const small = await phone.newPage();
    await small.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await small.waitForSelector("[data-chat-scroll]", { timeout: 60_000 });
    await small.waitForTimeout(2000);
    await small.evaluate(
      `window.dispatchEvent(new CustomEvent("oi-open-artifact", { detail: { fileId: ${JSON.stringify(doc.id)} } }))`,
    );
    await panel(small).waitFor({ state: "visible", timeout: 20_000 });
    await settled(small);
    const box = await panel(small).boundingBox();
    check(
      "on a phone it fills the width, flush to the left edge",
      !!box && box.width >= 380 && box.width <= 391 && Math.abs(box.x) < 1,
      `${box?.width ?? "?"}px of 390 at x=${Math.round(box?.x ?? -1)}`,
    );

    // The regression that mattered: an inline width beat inset-0, the controls
    // went off the right edge, and the panel could be opened but not shut.
    const close = panel(small).getByLabel("Close");
    const cb = await close.boundingBox();
    check(
      "…and the close cross is ON screen, not pushed off the edge",
      !!cb && cb.x >= 0 && cb.x + cb.width <= 390,
      cb ? `x=${Math.round(cb.x)} w=${Math.round(cb.width)}` : "no box",
    );
    await close.click();
    await small.waitForTimeout(400);
    check("…and it actually closes from the phone", (await panel(small).count()) === 0);

    check("no page errors throughout", errors.length === 0, errors.slice(0, 2).join(" | "));
    await phone.close();
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { userId: user.id } });
    await db.user.deleteMany({ where: { id: user.id } });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
