import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startTurn,
  getTurn,
  hasActiveTurn,
  publishTurn,
  endTurn,
  subscribeTurn,
  abortTurn,
} from "./turn-stream";

// Each test gets a unique conversation id — the registry is a global map.
let n = 0;
const cid = () => `conv-${++n}`;

describe("turn-stream registry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("startTurn registers; a second start while running is refused (409 path)", () => {
    const id = cid();
    const turn = startTurn(id);
    expect(turn).not.toBeNull();
    expect(hasActiveTurn(id)).toBe(true);
    expect(startTurn(id)).toBeNull(); // one turn per conversation
  });

  it("a finished turn can be replaced by a new one", () => {
    const id = cid();
    const t1 = startTurn(id)!;
    endTurn(t1);
    expect(hasActiveTurn(id)).toBe(false);
    const t2 = startTurn(id);
    expect(t2).not.toBeNull();
    expect(getTurn(id)).toBe(t2);
  });

  it("subscriber gets live events in order", () => {
    const turn = startTurn(cid())!;
    const seen: string[] = [];
    subscribeTurn(turn, (ev) => seen.push(ev.type), () => seen.push("<end>"));
    publishTurn(turn, { type: "meta" });
    publishTurn(turn, { type: "text", delta: "hi" });
    endTurn(turn);
    expect(seen).toEqual(["meta", "text", "<end>"]);
  });

  it("late subscriber REPLAYS the buffer first, then follows live (the resume)", () => {
    const turn = startTurn(cid())!;
    publishTurn(turn, { type: "meta" });
    publishTurn(turn, { type: "text", delta: "already " });
    const seen: string[] = [];
    subscribeTurn(
      turn,
      (ev) => seen.push(ev.type === "text" ? `text:${ev.delta}` : ev.type),
      () => seen.push("<end>"),
    );
    expect(seen).toEqual(["meta", "text:already "]); // instant catch-up
    publishTurn(turn, { type: "text", delta: "streamed" });
    endTurn(turn);
    expect(seen).toEqual(["meta", "text:already ", "text:streamed", "<end>"]);
  });

  it("subscribing to an ENDED turn (grace window) replays everything and ends immediately", () => {
    const turn = startTurn(cid())!;
    publishTurn(turn, { type: "text", delta: "full reply" });
    publishTurn(turn, { type: "done", messageId: "m1" });
    endTurn(turn);
    const seen: string[] = [];
    subscribeTurn(turn, (ev) => seen.push(ev.type), () => seen.push("<end>"));
    expect(seen).toEqual(["text", "done", "<end>"]);
  });

  it("unsubscribe detaches without affecting the turn or other subscribers", () => {
    const turn = startTurn(cid())!;
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeTurn(turn, (ev) => a.push(ev.type), () => a.push("<end>"));
    subscribeTurn(turn, (ev) => b.push(ev.type), () => b.push("<end>"));
    publishTurn(turn, { type: "text" });
    unsubA(); // tab A navigated away — generation must be unaffected
    publishTurn(turn, { type: "text" });
    endTurn(turn);
    expect(a).toEqual(["text"]);
    expect(b).toEqual(["text", "text", "<end>"]);
    expect(turn.abort.signal.aborted).toBe(false); // detach never aborts
  });

  it("abortTurn fires the turn's AbortController (stop button) — running only", () => {
    const id = cid();
    const turn = startTurn(id)!;
    expect(abortTurn(id)).toBe(true);
    expect(turn.abort.signal.aborted).toBe(true);
    endTurn(turn);
    expect(abortTurn(id)).toBe(false); // already over
    expect(abortTurn("nope")).toBe(false); // never existed
  });

  it("the buffer stays resumable for the grace window, then is dropped", () => {
    const id = cid();
    const turn = startTurn(id)!;
    publishTurn(turn, { type: "done" });
    endTurn(turn);
    expect(getTurn(id)).toBe(turn); // grace: late resume still replays
    vi.advanceTimersByTime(46_000);
    expect(getTurn(id)).toBeUndefined(); // gone after grace
  });

  it("grace cleanup never deletes a NEWER turn that replaced the entry", () => {
    const id = cid();
    const t1 = startTurn(id)!;
    endTurn(t1);
    const t2 = startTurn(id)!; // next user turn starts within t1's grace
    vi.advanceTimersByTime(46_000); // t1's timer fires
    expect(getTurn(id)).toBe(t2); // t2 must survive
  });

  it("publish after end is ignored; a throwing subscriber is evicted", () => {
    const turn = startTurn(cid())!;
    const seen: string[] = [];
    subscribeTurn(turn, () => { throw new Error("boom"); }, () => {});
    subscribeTurn(turn, (ev) => seen.push(ev.type), () => {});
    publishTurn(turn, { type: "a" }); // thrower evicted here, healthy one survives
    publishTurn(turn, { type: "b" });
    endTurn(turn);
    publishTurn(turn, { type: "c" }); // ignored
    expect(seen).toEqual(["a", "b"]);
    expect(turn.events.map((e) => e.type)).toEqual(["a", "b"]);
  });
});
