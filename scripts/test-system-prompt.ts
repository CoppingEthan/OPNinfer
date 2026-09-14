/**
 * Live test of the per-instance assistant instructions (Admin → Customise).
 *
 * The feature only counts if the admin's text actually reaches the model, so
 * this drives REAL turns and then reads the prompt that was really sent (from
 * logs/dev.log, which records every LLM request's message list in order):
 *
 *   1. The setting round-trips through the assistant config.
 *   2. The standing block names the assistant even with no instructions set.
 *   3. Admin → Customise renders the saved text in the form.
 *   4. Saving in the browser persists to the database.
 *   5. A real conversation turn OBEYS the instruction (behavioural proof).
 *   6. The block is the FIRST system message in the request that was sent.
 *   7. It carries into the escalation hand-off (the escalated model gets it).
 *   8. The front-end role does NOT get it — titles stay unaffected.
 *
 * Costs a few pennies of real tokens (Sonnet + one Opus escalation). The
 * instance's existing assistant_config is snapshotted and restored, so running
 * this against a live dev instance leaves no trace.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-system-prompt.ts
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import {
  buildAssistantSystemBlock,
  getAssistantConfig,
  setAssistantConfig,
  DEFAULT_ASSISTANT_NAME,
} from "../src/lib/assistant";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "sysprompt-admin-1!";
const STAMP = Date.now();
const DEV_LOG = join(process.cwd(), "logs", "dev.log");

/** A marker the model can only produce if the instructions reached it. */
const MARKER = "ZEBRA-42";
const INSTRUCTIONS = [
  "You are helping staff at a Lincolnshire estate agency.",
  "",
  `Finish EVERY reply with the exact token ${MARKER} on its own final line.`,
  "Keep answers to one short sentence unless asked otherwise.",
].join("\n");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
  );
  if (!ok) failures++;
}

interface LoggedCall {
  model: string;
  messages: { role: string; preview?: string }[];
}

/** Parse the LLM requests dev.log recorded after `fromByte` — the exact
 *  prompts that went out during this run, nothing historical. */
async function llmCallsSince(fromByte: number): Promise<LoggedCall[]> {
  // Slice as BYTES, not characters: dev.log is UTF-8 and full of multi-byte
  // glyphs (the → in these very lines), so `string.slice(size)` overshoots and
  // silently drops the run we're trying to inspect.
  const buf = await readFile(DEV_LOG).catch(() => Buffer.alloc(0));
  const text = buf.subarray(fromByte).toString("utf8");
  const calls: LoggedCall[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("[llm] → ");
    if (at === -1) continue;
    const brace = line.indexOf(" {", at);
    if (brace === -1) continue;
    const model = line.slice(at + "[llm] → ".length, brace).trim();
    try {
      const details = JSON.parse(line.slice(brace + 1)) as LoggedCall;
      calls.push({ model, messages: details.messages ?? [] });
    } catch {
      /* a truncated line — skip it */
    }
  }
  return calls;
}

async function logSize(): Promise<number> {
  return (await stat(DEV_LOG).catch(() => null))?.size ?? 0;
}

/**
 * Type into the instructions box and wait until Save actually goes live.
 *
 * `fill` can land BEFORE React hydrates: the DOM value changes, no onChange
 * listener exists yet, so the component's state never moves and Save stays
 * (correctly) disabled forever. Re-filling until the button enables is the
 * deterministic fix — same hydration race the Admin → Logs harness hit.
 */
async function typeInstructions(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  const box = page.locator("#system-prompt");
  const save = page.getByRole("button", { name: /save instructions/i });
  for (let attempt = 0; attempt < 20; attempt++) {
    await box.fill(text);
    if (await save.isEnabled()) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Save never became enabled — the form did not hydrate.");
}

/** Drive one real turn and return its streamed text. */
async function turn(
  cookie: string,
  conversationId: string,
  content: string,
): Promise<{ text: string; status: number }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ conversationId, content }),
  });
  let full = "";
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
    }
  }
  const events = [...full.matchAll(/^data: (.+)$/gm)].map((m) => {
    try {
      return JSON.parse(m[1]) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  return {
    status: res.status,
    text: events
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string)
      .join(""),
  };
}

async function main() {
  const original = await getAssistantConfig();
  const user = await db.user.create({
    data: {
      email: `sysprompt-${STAMP}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      emailVerified: new Date(),
    },
  });
  let convoId: string | null = null;

  try {
    // --- 1/2: the config layer + the pure block builder ---------------------
    await setAssistantConfig({ ...original, systemPrompt: INSTRUCTIONS });
    const saved = await getAssistantConfig();
    check("instructions round-trip through the assistant config", saved.systemPrompt === INSTRUCTIONS);

    const withPrompt = buildAssistantSystemBlock(saved);
    check(
      "standing block carries the assistant's name and the instructions",
      withPrompt.includes(saved.name) && withPrompt.includes(MARKER),
    );
    const bare = buildAssistantSystemBlock({ name: saved.name });
    check(
      "a blank instructions field still names the assistant",
      bare.includes(saved.name) || bare.includes(DEFAULT_ASSISTANT_NAME),
    );

    // --- sign in ------------------------------------------------------------
    const jar = new Map<string, string>();
    const store = (cs: string[]) => {
      for (const c of cs) {
        const p = c.split(";")[0];
        const i = p.indexOf("=");
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
      }
    };
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r1 = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    store(r1.headers.getSetCookie());
    const { csrfToken } = (await r1.json()) as { csrfToken: string };
    const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
      body: new URLSearchParams({ csrfToken, email: user.email, password: PASSWORD }),
      redirect: "manual",
    });
    store(r2.headers.getSetCookie());

    // --- 3/4: the admin form ------------------------------------------------
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
      await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: BASE })));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/customise`, { waitUntil: "domcontentloaded" });
      const box = page.locator("#system-prompt");
      await box.waitFor({ state: "visible", timeout: 20_000 });
      check("Customise shows the saved instructions in the form", (await box.inputValue()).includes(MARKER));

      const edited = `${INSTRUCTIONS}\nMention Bourne when asked where we are.`;
      await typeInstructions(page, edited);
      await page.getByRole("button", { name: /save instructions/i }).click();
      await page.getByText(/instructions saved/i).waitFor({ timeout: 20_000 });
      const afterSave = await getAssistantConfig();
      check(
        "saving in the browser persists to the database",
        afterSave.systemPrompt === edited,
        afterSave.systemPrompt === edited
          ? ""
          : `stored ${JSON.stringify(afterSave.systemPrompt?.slice(-60) ?? null)} vs expected ${JSON.stringify(edited.slice(-60))}`,
      );

      // Put the canonical text back for the model checks below.
      await typeInstructions(page, INSTRUCTIONS);
      await page.getByRole("button", { name: /save instructions/i }).click();
      await page.getByText(/instructions saved/i).waitFor({ timeout: 20_000 });
    } finally {
      await browser.close();
    }

    // --- 5/6/8: a real conversation turn ------------------------------------
    const convo = await db.conversation.create({ data: { userId: user.id, title: "sys prompt fixture" } });
    convoId = convo.id;
    const mark = await logSize();
    const first = await turn(cookieHeader(), convo.id, "In one short sentence: what is 2 + 2?");
    check("chat turn responds 200", first.status === 200, `status ${first.status}`);
    check(
      "the model OBEYED the instruction (marker present in the reply)",
      first.text.includes(MARKER),
      first.text.slice(0, 160),
    );

    // Give the queued dev-log writes a moment to flush before reading.
    await new Promise((r) => setTimeout(r, 1500));
    const calls = await llmCallsSince(mark);
    const convoModel = original.roles.conversation?.model ?? "";
    const convoCalls = calls.filter((c) => c.model.includes(convoModel));
    const firstSystem = convoCalls[0]?.messages[0];
    check(
      "the standing block is the FIRST message in the request actually sent",
      !!firstSystem &&
        firstSystem.role === "system" &&
        (firstSystem.preview ?? "").includes("You are"),
      firstSystem ? `${firstSystem.role}: ${(firstSystem.preview ?? "").slice(0, 90)}` : "no llm call logged",
    );

    const frontendModel = original.roles.frontend?.model ?? "";
    const frontendCalls = frontendModel
      ? calls.filter((c) => c.model.includes(frontendModel))
      : [];
    // NB: the marker is NOT a valid discriminator here — the title prompt
    // quotes the assistant's reply, which legitimately ends with it. The
    // standing block's identity sentence appears nowhere else, so that's the
    // thing to look for.
    const BLOCK_SIGNATURE = "the AI assistant for this organisation's private portal";
    check(
      "the front-end role (titles) does NOT receive the standing block",
      frontendCalls.length > 0 &&
        !frontendCalls.some((c) =>
          c.messages.some((m) => (m.preview ?? "").includes(BLOCK_SIGNATURE)),
        ),
      frontendCalls.length === 0 ? "no front-end call logged (title pass skipped)" : "",
    );

    // --- 7: escalation carries it -------------------------------------------
    if (original.roles.escalation) {
      const mark2 = await logSize();
      await turn(
        cookieHeader(),
        convo.id,
        "Please escalate this to the more powerful model, then just say hello.",
      );
      await new Promise((r) => setTimeout(r, 1500));
      const escModel = original.roles.escalation.model;
      const escCalls = (await llmCallsSince(mark2)).filter((c) => c.model.includes(escModel));
      check(
        "the escalation model also receives the standing block",
        escCalls.length > 0 &&
          escCalls.some((c) =>
            c.messages.some((m) => m.role === "system" && (m.preview ?? "").includes("You are")),
          ),
        escCalls.length === 0 ? "no escalation call logged" : "",
      );
    } else {
      check("escalation role configured (skipped)", true, "no escalation model bound");
    }
  } finally {
    // Leave the instance exactly as it was found — verified, not assumed:
    // this runs against the owner's real dev instance.
    await setAssistantConfig(original).catch(() => {});
    const restored = await getAssistantConfig().catch(() => null);
    check(
      "the instance's original assistant config was restored",
      restored?.systemPrompt === original.systemPrompt && restored?.name === original.name,
    );
    if (convoId) await db.conversation.delete({ where: { id: convoId } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  console.log(
    `\n${failures === 0 ? "ALL SYSTEM-PROMPT CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Harness error:", e);
  await db.$disconnect();
  process.exit(1);
});
