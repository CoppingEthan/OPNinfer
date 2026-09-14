import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "./anthropic";
import { toGoogleContents } from "./google";
import type { ChatMessage, ChatRequest } from "./types";

/**
 * The two message mappers — the code with all the cross-provider trapdoors.
 *
 * Every rule pinned here was written after something broke in production, and
 * until now the only thing guarding them was a live harness needing provider
 * keys. A refactor that reordered blocks or dropped a signature would have
 * 400'd every tool-using turn on that provider, for all users at once, on the
 * first deploy, with CI green.
 */

const req = (messages: ChatMessage[]): ChatRequest => ({
  model: "test-model",
  messages,
});

describe("toAnthropicMessages", () => {
  it("splits system out and keeps the rest in order", () => {
    const { system, messages } = toAnthropicMessages(
      req([
        { role: "system", content: "You are Acme AI." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    );
    expect(system?.[0].text).toBe("You are Acme AI.");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops an assistant turn with no text instead of sending an empty block", () => {
    // A reply that was only a visualisation or a generated image, or one
    // stopped just after a tool call, is saved with content "". Anthropic
    // rejects an empty text block, and a 4xx is never failed over — so
    // replaying one would break that conversation for good.
    const { messages } = toAnthropicMessages(
      req([
        { role: "user", content: "chart it" },
        { role: "assistant", content: "" },
        { role: "user", content: "and now?" },
      ]),
    );
    const blocks = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(blocks.some((b) => b.type === "text" && b.text === "")).toBe(false);
    expect(messages.every((m) => m.role === "user")).toBe(true);
  });

  it("puts tool_result blocks at the FRONT of a merged user turn", () => {
    // Anthropic 400s when a tool_result is stranded behind other content, which
    // is what happens when one tool returns images and another returns text in
    // the same round.
    const { messages } = toAnthropicMessages(
      req([
        { role: "user", content: "look at both" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "view_image", arguments: "{}" },
            { id: "c2", name: "read_file", arguments: "{}" },
          ],
        },
        { role: "tool", content: "here is the image", toolCallId: "c1" },
        {
          role: "user",
          content: "caption",
          images: [{ mimeType: "image/png", dataBase64: "AAA" }],
        },
        { role: "tool", content: "file text", toolCallId: "c2" },
      ]),
    );
    const merged = messages[messages.length - 1];
    const kinds = (merged.content as { type: string }[]).map((b) => b.type);
    const lastResult = kinds.lastIndexOf("tool_result");
    const firstOther = kinds.findIndex((k) => k !== "tool_result");
    expect(kinds.filter((k) => k === "tool_result")).toHaveLength(2);
    expect(lastResult).toBeLessThan(firstOther);
  });

  it("merges consecutive user turns so roles stay alternating", () => {
    const { messages } = toAnthropicMessages(
      req([
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ]),
    );
    expect(messages).toHaveLength(1);
    expect((messages[0].content as { type: string }[]).length).toBe(2);
  });

  it("marks a cache breakpoint on the last block of the last message", () => {
    const { messages } = toAnthropicMessages(req([{ role: "user", content: "hi" }]));
    const blocks = messages[0].content as { cache_control?: unknown }[];
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("carries tool calls as tool_use blocks, with parsed arguments", () => {
    const { messages } = toAnthropicMessages(
      req([
        {
          role: "assistant",
          content: "working on it",
          toolCalls: [{ id: "c1", name: "write_file", arguments: '{"name":"a.py"}' }],
        },
      ]),
    );
    const blocks = messages[0].content as { type: string; input?: unknown }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(blocks[1].input).toEqual({ name: "a.py" });
  });

  it("survives malformed tool arguments rather than throwing", () => {
    const { messages } = toAnthropicMessages(
      req([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "run_script", arguments: "{not json" }],
        },
      ]),
    );
    const blocks = messages[0].content as { type: string; input?: unknown }[];
    expect(blocks[0].input).toEqual({});
  });
});

describe("toGoogleContents", () => {
  it("uses model/user roles and leaves system out", () => {
    const contents = toGoogleContents([
      { role: "system", content: "ignored here" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
  });

  it("echoes thoughtSignature back on a replayed tool call", () => {
    // Gemini 3 returns 400 without it.
    const contents = toGoogleContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_file#0", name: "read_file", arguments: "{}", signature: "sig-abc" },
        ],
      },
    ]);
    const parts = contents[0].parts as { thoughtSignature?: string }[];
    expect(parts[0].thoughtSignature).toBe("sig-abc");
  });

  it("omits thoughtSignature entirely when there isn't one", () => {
    const contents = toGoogleContents([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
      },
    ]);
    const parts = contents[0].parts as Record<string, unknown>[];
    expect("thoughtSignature" in parts[0]).toBe(false);
  });

  it("drops a turn with nothing in it rather than sending an empty part", () => {
    const contents = toGoogleContents([
      { role: "user", content: "chart it" },
      { role: "assistant", content: "" },
      { role: "user", content: "and now?" },
    ]);
    expect(contents).toHaveLength(2);
    for (const c of contents) {
      for (const p of c.parts as { text?: string }[]) expect(p.text).not.toBe("");
    }
  });

  it("maps a tool result to a functionResponse matched by NAME", () => {
    const contents = toGoogleContents([
      { role: "tool", content: "file text", toolCallId: "read_file#1", toolName: "read_file" },
    ]);
    const parts = contents[0].parts as { functionResponse: { name: string } }[];
    expect(contents[0].role).toBe("user");
    expect(parts[0].functionResponse.name).toBe("read_file");
  });

  it("puts user images ahead of the text", () => {
    const contents = toGoogleContents([
      {
        role: "user",
        content: "what is this?",
        images: [{ mimeType: "image/png", dataBase64: "AAA" }],
      },
    ]);
    const parts = contents[0].parts as Record<string, unknown>[];
    expect("inlineData" in parts[0]).toBe(true);
    expect(parts[1].text).toBe("what is this?");
  });
});
