import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asUuid,
  cleanOwuiContent,
  linearizeOwuiChat,
  owuiDate,
} from "./owui-import";

const msg = (
  id: string,
  parentId: string | null,
  role: string,
  content: string,
  timestamp = 0,
) => ({ id, parentId, role, content, timestamp });

describe("owuiDate", () => {
  it("converts unix seconds", () => {
    expect(owuiDate(1784550985)?.toISOString()).toBe(
      new Date(1784550985 * 1000).toISOString(),
    );
  });
  it("passes through millisecond timestamps", () => {
    expect(owuiDate(1784550985123)?.getTime()).toBe(1784550985123);
  });
  it("rejects garbage", () => {
    expect(owuiDate(null)).toBeUndefined();
    expect(owuiDate(0)).toBeUndefined();
    expect(owuiDate("soon")).toBeUndefined();
  });
});

describe("cleanOwuiContent", () => {
  it("strips reasoning details blocks", () => {
    const raw =
      '<details type="reasoning" done="true">\nthinking…\n</details>\n\n\nThe answer is 4.';
    expect(cleanOwuiContent(raw)).toBe("The answer is 4.");
  });
  it("strips multiple blocks and collapses blank runs", () => {
    const raw =
      "Before\n\n<details>a</details>\n\n\n\nMiddle\n<details x>b</details>\nAfter";
    expect(cleanOwuiContent(raw)).toBe("Before\n\nMiddle\n\nAfter");
  });
  it("leaves plain markdown untouched", () => {
    const raw = "# Title\n\nSome **bold** text.";
    expect(cleanOwuiContent(raw)).toBe(raw);
  });
});

describe("linearizeOwuiChat", () => {
  it("walks the active branch from currentId (branching chat)", () => {
    // root user turn → two assistant siblings (a regenerate); currentId picks B.
    const chat = {
      history: {
        currentId: "b",
        messages: {
          u1: msg("u1", null, "user", "hello", 1),
          a: msg("a", "u1", "assistant", "first try", 2),
          b: msg("b", "u1", "assistant", "second try", 3),
        },
      },
    };
    const out = linearizeOwuiChat(chat);
    expect(out.map((m) => m.content)).toEqual(["hello", "second try"]);
  });

  it("falls back to the newest leaf when currentId is missing", () => {
    const chat = {
      history: {
        messages: {
          u1: msg("u1", null, "user", "hi", 1),
          a: msg("a", "u1", "assistant", "old", 2),
          u2: msg("u2", "a", "user", "again", 3),
          b: msg("b", "u2", "assistant", "newest", 4),
        },
      },
    };
    expect(linearizeOwuiChat(chat).map((m) => m.content)).toEqual([
      "hi",
      "old",
      "again",
      "newest",
    ]);
  });

  it("uses the legacy messages array when there is no history", () => {
    const chat = {
      messages: [
        msg("1", null, "user", "q"),
        msg("2", "1", "assistant", "a"),
      ],
    };
    expect(linearizeOwuiChat(chat).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("drops system turns, non-string content, and empty-after-clean messages", () => {
    const chat = {
      messages: [
        msg("1", null, "system", "prompt"),
        { id: "2", parentId: "1", role: "user", content: ["parts"] },
        msg("3", "2", "assistant", "<details>only thinking</details>"),
        msg("4", "3", "assistant", "real reply"),
      ],
    };
    expect(linearizeOwuiChat(chat).map((m) => m.content)).toEqual([
      "real reply",
    ]);
  });

  it("survives cycles and missing parents", () => {
    const chat = {
      history: {
        currentId: "b",
        messages: {
          a: { ...msg("a", "b", "user", "loop a", 1) },
          b: { ...msg("b", "a", "assistant", "loop b", 2) },
        },
      },
    };
    // Cycle guard: each node visited once, ordered parent-first.
    expect(linearizeOwuiChat(chat).map((m) => m.content)).toEqual([
      "loop a",
      "loop b",
    ]);
  });

  it("captures model and attachment flags", () => {
    const chat = {
      history: {
        currentId: "a",
        messages: {
          u: { ...msg("u", null, "user", "look", 1), files: [{ id: "f" }] },
          a: { ...msg("a", "u", "assistant", "seen", 2), model: "gpt-x" },
        },
      },
    };
    const out = linearizeOwuiChat(chat);
    expect(out[0].hadFiles).toBe(true);
    expect(out[1].model).toBe("gpt-x");
  });

  it("returns [] for null/empty chat JSON", () => {
    expect(linearizeOwuiChat(null)).toEqual([]);
    expect(linearizeOwuiChat({})).toEqual([]);
  });
});

describe("asUuid", () => {
  it("accepts and lowercases uuids", () => {
    expect(asUuid("D8425DBE-F0D9-4F09-96E9-731C5B8216F0")).toBe(
      "d8425dbe-f0d9-4f09-96e9-731c5b8216f0",
    );
  });
  it("rejects non-uuids", () => {
    expect(asUuid("local-chat-1")).toBeUndefined();
    expect(asUuid(42)).toBeUndefined();
  });
});

describe("imported messages carry their author (audit 2026-09-05)", () => {
  // The importer writes rows with createMany, so this is pinned against the
  // SOURCE — the same technique as standalone-trace.test.ts. Before v0.5 a
  // message had no author column; afterwards NULL means "the account is
  // gone" and the thread builder renders "Former member". An imported chat
  // would show that for its own owner's messages as soon as it was shared,
  // and a re-import cannot repair it (existing chats are skipped).
  const src = readFileSync(new URL("./owui-import.ts", import.meta.url), "utf8");

  it("stamps user turns with the chat's owner and leaves assistant turns null", () => {
    expect(src).toMatch(/userId: m\.role === "user" \? ownerId : null/);
  });
});
