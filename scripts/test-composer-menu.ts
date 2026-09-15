/**
 * Live test of the composer's `+` menu, the workflow it FORCES, and the
 * in-app dialogs that replaced the browser's own.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-composer-menu.ts
 *
 * Two things here, and the second is the one that matters.
 *
 * The menu itself is ordinary UI: `+` offers "Upload a file" and a "Workflows"
 * submenu listing the person's own playbooks, and picking one puts a chip on
 * the composer. A browser is needed only because it is a portal, a hover timer
 * and a server action.
 *
 * The claim underneath it is the owner's: picking a workflow here should
 * *force* the assistant to follow it, rather than hoping the per-turn WORKFLOWS
 * list catches its eye. That can only be proven by a NEGATIVE CONTROL — the
 * SAME message is sent twice, once without picking and once with, and the
 * workflow's unmistakable house rule must be absent the first time and present
 * the second. Sending it only once and finding the rule would prove nothing:
 * the model might have done it anyway.
 *
 * The dialogs ride along at the end because they are the same round of chrome
 * and the harness already has a signed-in person with a workflow. `prompt()`
 * and `confirm()` are gone from the whole app (pinned from source by
 * ui/dialog.test.ts); what a source test CANNOT show is that the thing that
 * replaced them returns a value and creates the workflow. If the provider ever
 * went missing, `useDialog` would fall back to the browser's own box — which
 * looks like it works, and is exactly what was complained about.
 *
 * Needs provider keys and a running dev server.
 */
import { chromium, type Page } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { upsertWorkflow } from "../src/lib/workflow-store";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "composer-test-1!";

/**
 * A house rule the model would never invent: it must close with this exact
 * line. Deliberately mechanical — "be concise" could be satisfied by accident,
 * a fixed token cannot.
 */
const SIGN_OFF = "Filed under: NORTHERLY";
const ASK = "Summarise in two sentences why weekly stock counts matter.";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 220)}` : ""}`,
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

/** Send the composer's current contents and wait for the reply to be saved. */
async function sendAndRead(page: Page, conversationId: string, text: string): Promise<string> {
  const before = await db.message.count({ where: { conversationId, role: "assistant" } });
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
  // Wait for the OUTCOME — a persisted reply — not for a stopwatch. The paced
  // reveal keeps writing to the screen long after the turn has ended.
  for (let i = 0; i < 180; i++) {
    const rows = await db.message.findMany({
      where: { conversationId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (rows.length && (await db.message.count({ where: { conversationId, role: "assistant" } })) > before) {
      return rows[0].content;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("no reply within 180s");
}

async function main() {
  const stamp = Date.now();
  const user = await db.user.create({
    data: {
      email: `composer-${stamp}@example.test`,
      name: "Wes Workflow",
      passwordHash: await hashPassword(PASSWORD),
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  const wf = await upsertWorkflow({
    userId: user.id,
    name: "House style",
    description: "How we write anything that leaves the building",
    body: [
      "# House style",
      "",
      "## Steps",
      "",
      "1. Answer the question first, in plain words.",
      `2. End every reply with this line, exactly: ${SIGN_OFF}`,
      "",
      "## Notes from past runs",
      "",
    ].join("\n"),
  });

  const browser = await chromium.launch();
  try {
    const convo = await db.conversation.create({
      data: { userId: user.id, title: "Composer menu test" },
    });

    const cookies = await signIn(user.email);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`${BASE}/chat/${convo.id}`, { waitUntil: "domcontentloaded" });
    try {
      // The COMPOSER, not the thread: this chat is empty, and an empty chat
      // renders the greeting screen with no scroller at all.
      await page.waitForSelector("[data-composer-menu]", { timeout: 60_000 });
    } catch (e) {
      console.error("landed on", page.url());
      console.error((await page.innerText("body")).slice(0, 400));
      throw e;
    }
    await page.waitForTimeout(2500);

    // ---- 1. the menu ----------------------------------------------------
    const plus = page.locator("[data-composer-menu]");
    check("the composer has a + button", (await plus.count()) === 1);
    check("…and it says what it does", (await plus.getAttribute("aria-label")) === "Attach a file or choose a workflow");

    const menu = page.locator("[data-composer-menu-open]");
    check("nothing is open until asked", (await menu.count()) === 0);

    // Hover alone opens it, after a beat — so the owner's "hover on the plus"
    // works without a click.
    await plus.hover();
    await page.waitForTimeout(700);
    check("hovering opens it", (await menu.count()) === 1);

    const items = await menu.innerText();
    check("it offers Upload a file", /Upload a file/i.test(items), items.split("\n")[0]);
    check("…and Workflows", /Workflows/i.test(items));

    // …and it opens ABOVE the button: the composer is at the bottom of the
    // screen, so a menu dropping downwards would open off the edge.
    const mb = await menu.boundingBox();
    const pb = await plus.boundingBox();
    check(
      "it opens upwards, not off the bottom of the screen",
      !!mb && !!pb && mb.y + mb.height <= pb.y + 2,
      mb && pb ? `menu ends ${Math.round(mb.y + mb.height)}, button starts ${Math.round(pb.y)}` : "no box",
    );

    // Hover first, THEN click — the way a hand actually arrives at a row.
    // The first cut toggled on click, so pointing at the row opened the
    // submenu and the click that followed shut it again.
    const wfRow = menu.getByText("Workflows", { exact: false }).first();
    await wfRow.hover();
    const option = page.locator(`[data-workflow-option="${wf.id}"]`);
    await option.waitFor({ state: "visible", timeout: 15_000 });
    check("the submenu lists this person's own workflows", (await option.innerText()).includes("House style"));
    await wfRow.click();
    await page.waitForTimeout(250);
    check(
      "…and clicking the row you were already pointing at does not shut it",
      await option.isVisible(),
    );

    await option.click();
    const chip = page.locator(`[data-picked-workflow="${wf.id}"]`);
    await chip.waitFor({ state: "visible", timeout: 10_000 });
    check("picking one puts a chip on the composer", (await chip.innerText()).includes("House style"));
    check("…and the menu closes behind it", (await menu.count()) === 0);

    // Dismissable — a chip you cannot take off is a trap.
    await chip.getByLabel("Don't use this workflow").click();
    await page.waitForTimeout(300);
    check("the chip can be taken off again", (await page.locator("[data-picked-workflow]").count()) === 0);

    // ---- 2. NEGATIVE CONTROL: the same ask, unforced ---------------------
    const plain = await sendAndRead(page, convo.id, ASK);
    check(
      "NEGATIVE CONTROL: without picking it, the house rule is absent",
      !plain.includes(SIGN_OFF),
      plain.slice(-90),
    );

    // ---- 3. the same ask, forced ----------------------------------------
    await plus.click();
    await menu.getByText("Workflows", { exact: false }).first().click();
    await page.locator(`[data-workflow-option="${wf.id}"]`).click();
    await chip.waitFor({ state: "visible", timeout: 10_000 });

    const forced = await sendAndRead(page, convo.id, ASK);
    check(
      "picking it FORCES the assistant to follow the workflow",
      forced.includes(SIGN_OFF),
      forced.slice(-90),
    );
    check(
      "…and it did not ask permission or narrate the workflow instead of answering",
      !/would you like me to|shall I use/i.test(forced) && forced.length > SIGN_OFF.length + 40,
      `${forced.length} chars`,
    );

    // A pick is for ONE message. Leaving it on would silently apply a playbook
    // to a conversation the person thought they had finished with.
    await page.waitForTimeout(1500);
    check("the chip clears after sending", (await page.locator("[data-picked-workflow]").count()) === 0);

    const after = await sendAndRead(page, convo.id, "And in one word, what is the risk of not doing it?");
    check(
      "…so the NEXT message is not silently run through it",
      !after.includes(SIGN_OFF),
      after.slice(-90),
    );

    // ---- 4. the in-app dialogs ------------------------------------------
    // A native dialog is not part of the page, so Playwright can only see one
    // through the `dialog` event. Listening for it is the negative control:
    // if one ever opens, this fails rather than quietly auto-dismissing.
    let native = "";
    page.on("dialog", async (d) => {
      native = `${d.type()}: ${d.message()}`;
      await d.dismiss();
    });

    await page.goto(`${BASE}/workflows`, { waitUntil: "domcontentloaded" });
    const dlg = page.locator("[data-app-dialog]");

    /**
     * Click until it opens. The button is in the server-rendered HTML, so it
     * is clickable well before React has attached anything to it — the same
     * hydration race the Admin → Logs and system-prompt harnesses hit, where
     * the DOM accepts the click and nothing happens. Retrying until the
     * OUTCOME appears is the only honest way to drive it.
     */
    const openDialog = async () => {
      const btn = page.getByRole("button", { name: "+ New" }).first();
      await btn.waitFor({ timeout: 30_000 });
      for (let i = 0; i < 20; i++) {
        await btn.click();
        await page.waitForTimeout(500);
        if (await dlg.count()) return;
      }
      throw new Error("the New button never opened a dialog");
    };
    await openDialog();
    check("New opens an in-app dialog, on the page", (await dlg.innerText()).includes("New workflow"));
    check("NEGATIVE CONTROL: no browser dialog opened", native === "", native);

    // Escape must dismiss it, or it is a modal with no way out.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check("Escape dismisses it", (await dlg.count()) === 0);

    await openDialog();
    const made = `Chase a late invoice ${stamp}`;
    await dlg.locator("input, textarea").first().fill(made);
    await dlg.locator("[data-dialog-confirm]").click();
    await page.waitForTimeout(2500);
    const row = await db.workflow.findFirst({ where: { userId: user.id, name: made } });
    check("…and what was typed into it really creates the workflow", !!row, made);
    check("NEGATIVE CONTROL: still no browser dialog", native === "", native);

    check("no page errors throughout", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  } finally {
    await browser.close();
    await db.conversation.deleteMany({ where: { userId: user.id } });
    await db.workflow.deleteMany({ where: { userId: user.id } });
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
