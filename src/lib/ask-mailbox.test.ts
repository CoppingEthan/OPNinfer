import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_TIMEOUT_MS, dismissAsk, openAsk, peekAsk, settleAsk } from "./ask-mailbox";
import type { AskAnswer, AskQuestion } from "./ask";

const CONV = "11111111-1111-4111-8111-111111111111";
const questions: AskQuestion[] = [
  { header: "City", question: "Which city?", options: [{ label: "Manchester" }, { label: "Bristol" }] },
];
const answers: AskAnswer[] = [{ header: "City", question: "Which city?", chosen: ["Bristol"] }];

afterEach(() => {
  dismissAsk(CONV);
  vi.useRealTimers();
});

describe("ask mailbox", () => {
  it("resolves with the answers the route delivers", async () => {
    const waiting = openAsk(CONV, "a1", questions);
    expect(settleAsk(CONV, "a1", answers)).toBe(true);
    await expect(waiting).resolves.toEqual({ status: "answered", answers });
  });

  it("exposes what was asked so the route can validate against it", () => {
    void openAsk(CONV, "a1", questions);
    expect(peekAsk(CONV)).toEqual({ id: "a1", questions });
    dismissAsk(CONV);
    expect(peekAsk(CONV)).toBeNull();
  });

  it("refuses an answer for a different card — a stale one must not resolve a new one", async () => {
    const waiting = openAsk(CONV, "a2", questions);
    expect(settleAsk(CONV, "a1", answers)).toBe(false);
    expect(settleAsk(CONV, "a2", answers)).toBe(true);
    await expect(waiting).resolves.toMatchObject({ status: "answered" });
  });

  it("refuses an answer when nothing is waiting", () => {
    expect(settleAsk(CONV, "a1", answers)).toBe(false);
  });

  it("resolves as dismissed when the turn ends under it", async () => {
    const waiting = openAsk(CONV, "a1", questions);
    dismissAsk(CONV);
    await expect(waiting).resolves.toEqual({ status: "dismissed" });
  });

  it("expires rather than hanging when nobody answers", async () => {
    vi.useFakeTimers();
    const waiting = openAsk(CONV, "a1", questions, { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    await expect(waiting).resolves.toEqual({ status: "expired" });
    expect(peekAsk(CONV)).toBeNull();
  });

  it("releases the wait when the TURN is aborted (Stop)", async () => {
    // The whole point of threading the signal through: this promise is
    // otherwise invisible to an abort, and a stopped turn would sit on an
    // unanswerable card for the full timeout.
    const ac = new AbortController();
    const waiting = openAsk(CONV, "a1", questions, { signal: ac.signal });
    ac.abort();
    await expect(waiting).resolves.toEqual({ status: "dismissed" });
    expect(peekAsk(CONV)).toBeNull();
  });

  it("settles immediately if the turn was already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(openAsk(CONV, "a1", questions, { signal: ac.signal })).resolves.toEqual({
      status: "dismissed",
    });
  });

  it("only ever holds one card per conversation, dismissing the old one", async () => {
    const first = openAsk(CONV, "a1", questions);
    const second = openAsk(CONV, "a2", questions);
    await expect(first).resolves.toEqual({ status: "dismissed" });
    expect(peekAsk(CONV)?.id).toBe("a2");
    settleAsk(CONV, "a2", answers);
    await expect(second).resolves.toMatchObject({ status: "answered" });
  });

  it("ignores a second settlement — the first one wins", async () => {
    const waiting = openAsk(CONV, "a1", questions);
    expect(settleAsk(CONV, "a1", answers)).toBe(true);
    expect(settleAsk(CONV, "a1", [])).toBe(false);
    await expect(waiting).resolves.toEqual({ status: "answered", answers });
  });

  it("waits well inside the per-turn hard stop, so an ignored card still replies", () => {
    // 15 minutes is when the turn is killed outright; the card has to give up
    // first or the user gets a dead stream instead of a default-driven answer.
    expect(ASK_TIMEOUT_MS).toBeLessThan(15 * 60_000);
  });
});
