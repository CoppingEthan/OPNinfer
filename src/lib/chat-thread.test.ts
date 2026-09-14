import { describe, expect, it } from "vitest";
import { buildChatThread, type ThreadMessageRow } from "./chat-thread";

const at = (mins: number) => new Date(Date.UTC(2026, 7, 21, 12, mins, 0));

function row(
  id: string,
  role: "user" | "assistant",
  content: string,
  mins: number,
  meta: unknown = null,
): ThreadMessageRow {
  return { id, role, content, createdAt: at(mins), meta };
}

describe("buildChatThread — answers to a question card", () => {
  /**
   * The ordering problem this filter exists for: the answer is persisted the
   * moment it is given (mid-turn), while the reply that used it is only saved
   * when the turn ends — so by timestamp the answer sorts ABOVE the question
   * card that asked for it. The card already shows the chosen answer inline,
   * in the position it was asked, so the bubble is dropped rather than
   * reordered.
   */
  const rows = [
    row("m1", "user", "Write me a poem about the sea.", 0),
    row("m2", "user", "Form: Haiku", 1, { askAnswer: true }),
    row("m3", "assistant", "[Haiku] Salt on the harbour…", 2, {
      asks: [
        {
          id: "a1",
          status: "answered",
          questions: [{ header: "Form", question: "Which form?", options: [] }],
          answers: [{ header: "Form", chosen: ["Haiku"] }],
        },
      ],
      activity: [{ kind: "ask", id: "a1", at: 0 }],
    }),
  ];

  it("drops the answer row from the rendered thread", () => {
    const { messages } = buildChatThread(rows, []);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("still renders the card, which carries the answer", () => {
    const { messages } = buildChatThread(rows, []);
    const reply = messages[1];
    const ask = reply.activity?.find((a) => a.kind === "ask");
    expect(ask).toBeDefined();
    expect(JSON.stringify(ask)).toContain("Haiku");
  });

  it("keeps ordinary user messages, including ones that merely look similar", () => {
    const { messages } = buildChatThread(
      [
        row("m1", "user", "Form: Haiku", 0), // typed by hand, not via a card
        row("m2", "user", "Form: Haiku", 1, { askAnswer: false }),
        row("m3", "assistant", "Right you are.", 2),
      ],
      [],
    );
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("leaves system and tool rows out, as before", () => {
    const { messages } = buildChatThread(
      [
        { id: "s1", role: "system", content: "…", createdAt: at(0), meta: null },
        row("m1", "user", "Hello", 1),
        { id: "t1", role: "tool", content: "…", createdAt: at(2), meta: null },
        row("m2", "assistant", "Hi", 3),
      ],
      [],
    );
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});
