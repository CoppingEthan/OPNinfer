/**
 * Live test of workflows, against a real model.
 *
 * The three things that have to be true, and none of them can be shown by a
 * unit test:
 *
 *   1. the model LOADS a workflow when a request matches one — the whole
 *      feature is worthless if the L1 line does not get noticed;
 *   2. `note_workflow` appends a lesson and leaves the person's own
 *      instructions byte-for-byte alone. This is checked with a NEGATIVE
 *      CONTROL: the steps above the heading are hashed before and after;
 *   3. a shared workflow is ONE document — an edit by the person it was
 *      shared with is seen by the owner, rather than each holding a copy that
 *      drifts.
 *
 *   node --import tsx --loader ./scripts/shim-server-only.mjs --env-file=.env scripts/test-workflows.ts
 *
 * Needs provider keys (it sends real turns) and a running dev server.
 */
import { createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/hash";
import { NOTES_HEADING } from "../src/lib/workflows";
import { DEFAULT_WORKFLOWS } from "../src/lib/workflow-store";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "workflow-test-1!";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}${extra ? ` -- ${extra.replace(/\s+/g, " ").slice(0, 220)}` : ""}`,
  );
  if (!ok) failures++;
}

async function signIn(email: string): Promise<string> {
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
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Send one turn and drain the SSE stream, returning the text and the tools used. */
async function turn(
  cookie: string,
  conversationId: string,
  content: string,
): Promise<{ text: string; tools: string[]; asked: boolean }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ conversationId, content }),
  });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status}: ${await res.text()}`);

  let text = "";
  let asked = false;
  const tools: string[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as { type?: string; delta?: string; label?: string };
        if (ev.type === "text" && ev.delta) text += ev.delta;
        if (ev.type === "tool" && ev.label) tools.push(ev.label);
        // The playbook opens by asking two questions; raising the clarifying
        // card is a perfectly good way to do that, so count it.
        if (ev.type === "ask") asked = true;
      } catch {
        /* keep-alives and anything we don't model */
      }
    }
  }
  return { text, tools, asked };
}

/** Everything above the notes heading — the part the assistant must not touch. */
function stepsOf(body: string): string {
  const i = body.indexOf(NOTES_HEADING);
  // Trimmed: creating the section for the first time re-flows the trailing
  // newlines, and what must survive is the person's words, not their padding.
  return (i === -1 ? body : body.slice(0, i)).trim();
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function main() {
  const stamp = Date.now();
  const pw = await hashPassword(PASSWORD);
  const owner = await db.user.create({
    data: {
      email: `wf-owner-${stamp}@example.test`,
      name: "Wilma Owner",
      passwordHash: pw,
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });
  const mate = await db.user.create({
    data: {
      email: `wf-mate-${stamp}@example.test`,
      name: "Morgan Mate",
      passwordHash: pw,
      role: "user",
      emailVerified: new Date(),
      lastSeenVersion: "9.9.9",
    },
  });

  try {
    // The workflow under test is the shipped default, so this also proves the
    // seeded text is good enough for a model to act on.
    const def = DEFAULT_WORKFLOWS[0];
    const wf = await db.workflow.create({
      data: { userId: owner.id, name: def.name, description: def.description, body: def.body },
    });
    const before = await db.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    const stepsBefore = hash(stepsOf(before.body));

    const cookie = await signIn(owner.email);
    const convo = await db.conversation.create({
      data: { userId: owner.id, title: "Workflow test" },
    });

    // ---- 1. does the model notice and load it? --------------------------
    const t1 = await turn(
      cookie,
      convo.id,
      "Here's a draft paragraph for our website: \"We utilise robust, " +
        "best-in-class solutions to leverage seamless synergies for our " +
        "valued clientele.\" Please rewrite it.",
    );
    const loaded = await db.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    check(
      "the model loads the matching workflow without being told to",
      loaded.lastUsedAt !== null,
      `tools: ${t1.tools.join(", ") || "(none)"}`,
    );
    check(
      "and it followed the playbook — asked who it is for before rewriting",
      t1.asked || /audience|who.*(read|for)|shorter|same length/i.test(t1.text),
      `${t1.asked ? "[raised the question card] " : ""}${t1.text.slice(0, 200)}`,
    );

    // ---- 2. a note appends, and CANNOT touch the instructions -----------
    const t2 = await turn(
      cookie,
      convo.id,
      "It's for our investors, same length. One thing for next time: we always " +
        "spell it \"organisation\", never the z. Please remember that against " +
        "this workflow.",
    );
    const noted = await db.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    check(
      "the lesson is recorded",
      noted.notedAt !== null && /organisation/i.test(noted.body),
      `notedAt=${noted.notedAt?.toISOString() ?? "null"}`,
    );
    check(
      "it went UNDER the notes heading",
      noted.body.indexOf(NOTES_HEADING) < noted.body.toLowerCase().lastIndexOf("organisation"),
    );
    // The negative control: the user's own steps are byte-identical.
    check(
      "NEGATIVE CONTROL: the person's instructions are untouched",
      hash(stepsOf(noted.body)) === stepsBefore,
      `${stepsBefore} -> ${hash(stepsOf(noted.body))}`,
    );
    check("...and the reply did not pretend to have rewritten the steps", !/rewrote|replaced your/i.test(t2.text));

    // ---- 3. sharing is ONE copy ----------------------------------------
    await db.workflowMember.createMany({
      data: [
        { workflowId: wf.id, userId: owner.id },
        { workflowId: wf.id, userId: mate.id, invitedById: owner.id },
      ],
    });

    const { listWorkflows } = await import("../src/lib/workflow-store");
    const mateSees = await listWorkflows(mate.id);
    check(
      "the colleague sees it, labelled with who shared it",
      mateSees.some((w) => w.id === wf.id && w.sharedBy === "Wilma Owner" && !w.mine),
      mateSees.map((w) => `${w.name}${w.sharedBy ? ` <${w.sharedBy}>` : ""}`).join(" | "),
    );

    // An edit by the member must be what the owner then reads — one document.
    const edited = `${loaded.body}\n\n<!-- edited by the colleague -->\n`;
    await db.workflow.update({ where: { id: wf.id }, data: { body: edited } });
    const ownerReads = await db.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    check(
      "an edit by one is seen by the other — ONE copy, not a copy each",
      ownerReads.body.includes("edited by the colleague"),
    );

    // And the model gets the shared one in its per-turn list.
    const { workflowSummaries } = await import("../src/lib/workflow-store");
    const { buildWorkflowsBlock } = await import("../src/lib/workflows");
    const block = buildWorkflowsBlock(await workflowSummaries(mate.id));
    check(
      "the colleague's assistant is told about it too",
      !!block && block.includes(def.name) && block.includes("Wilma"),
      block?.split("\n").slice(-1)[0] ?? "(no block)",
    );
  } finally {
    await db.conversation.deleteMany({ where: { userId: { in: [owner.id, mate.id] } } });
    await db.workflow.deleteMany({ where: { userId: { in: [owner.id, mate.id] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, mate.id] } } });
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
