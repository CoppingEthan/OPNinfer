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
 *      opened and not shut. Nothing but measuring it at phone width finds it.
 *
 * No model calls — the files are seeded, so this is free and deterministic.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-artifact-panel.ts
 */
import { chromium, type Page } from "@playwright/test";
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
        meta: { fileIds: [doc.id, img.id] },
      },
    });

    const cookies = await signIn(user.email);
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // NEVER networkidle on /chat — the live feed holds a request open forever.
    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-chat-scroll]", { timeout: 60_000 });
    await page.waitForTimeout(2500);

    check("the panel is not there until something asks for it", (await panel(page).count()) === 0);

    // ---- 1. a card opens that file -------------------------------------
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
    const box = await panel(small).boundingBox();
    check("on a phone it fills the width", !!box && box.width >= 380 && box.width <= 391, `${box?.width ?? "?"}px of 390`);

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
