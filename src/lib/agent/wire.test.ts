import { describe, expect, it } from "vitest";
import {
  WireParser,
  encodeAttachHeader,
  encodeChunk,
  encodeExit,
  parseAttachHeader,
} from "./wire";

describe("attach header", () => {
  it("round-trips args + env", () => {
    const h = {
      args: ["--output-format", "stream-json", "--input-format", "stream-json"],
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/sandbox/.claude" },
    };
    const parsed = parseAttachHeader(encodeAttachHeader(h).trimEnd());
    expect(parsed).toEqual(h);
  });

  it("rejects garbage, non-string args, and missing args", () => {
    expect(parseAttachHeader("not json")).toBeNull();
    expect(parseAttachHeader('{"args": [1,2]}')).toBeNull();
    expect(parseAttachHeader('{"env": {}}')).toBeNull();
  });

  it("drops non-string env values instead of failing the whole header", () => {
    const parsed = parseAttachHeader('{"args": [], "env": {"A": "1", "B": 2}}');
    expect(parsed).toEqual({ args: [], env: { A: "1" } });
  });
});

describe("WireParser", () => {
  it("decodes stdout/stderr/exit envelopes in order", () => {
    const p = new WireParser();
    const events = p.feed(
      encodeChunk("o", "hello ") + encodeChunk("e", "warn!") + encodeChunk("o", "world") + encodeExit(0),
    );
    expect(events.map((e) => e.kind)).toEqual(["o", "e", "o", "exit"]);
    expect(Buffer.concat(events.filter((e) => e.kind === "o").map((e) => (e as { data: Buffer }).data)).toString()).toBe(
      "hello world",
    );
    expect(events[3]).toEqual({ kind: "exit", code: 0 });
  });

  it("survives arbitrary chunk boundaries (mid-envelope, mid-base64)", () => {
    const wire = encodeChunk("o", "the quick brown fox") + encodeExit(137);
    for (const size of [1, 2, 3, 7, 10]) {
      const p = new WireParser();
      const events = [];
      for (let i = 0; i < wire.length; i += size) events.push(...p.feed(wire.slice(i, i + size)));
      expect(events.map((e) => e.kind)).toEqual(["o", "exit"]);
      expect((events[0] as { data: Buffer }).data.toString()).toBe("the quick brown fox");
      expect(events[1]).toEqual({ kind: "exit", code: 137 });
    }
  });

  it("binary-safe: multi-byte UTF-8 and raw bytes round-trip", () => {
    const raw = Buffer.concat([Buffer.from("émoji → 🎯 "), Buffer.from([0, 1, 2, 255])]);
    const p = new WireParser();
    const [ev] = p.feed(encodeChunk("o", raw));
    expect(ev.kind).toBe("o");
    expect((ev as { data: Buffer }).data.equals(raw)).toBe(true);
  });

  it("drops corrupt lines without losing what follows", () => {
    const p = new WireParser();
    const events = p.feed("this is not json\n" + '{"weird": true}\n' + encodeExit(1));
    expect(events).toEqual([{ kind: "exit", code: 1 }]);
  });

  it("empty lines are ignored", () => {
    const p = new WireParser();
    expect(p.feed("\n\n" + encodeChunk("o", "x"))).toHaveLength(1);
  });
});
