import { describe, expect, it } from "vitest";
import {
  closeInterjectionMailbox,
  drainInterjections,
  offerInterjection,
  openInterjectionMailbox,
  peekInterjections,
  withdrawInterjection,
} from "./interject";

const msg = (id: string, content: string, userId = "u1") => ({ id, userId, content });

describe("interjection mailbox", () => {
  it("refuses offers when no turn is listening", () => {
    expect(offerInterjection("conv-a", msg("1", "hello"))).toBe(false);
    expect(drainInterjections("conv-a")).toEqual([]);
  });

  it("queues offers in order while open, drains them once", () => {
    openInterjectionMailbox("conv-b");
    expect(offerInterjection("conv-b", msg("1", "first"))).toBe(true);
    expect(offerInterjection("conv-b", msg("2", "second", "u2"))).toBe(true);
    expect(drainInterjections("conv-b")).toEqual([msg("1", "first"), msg("2", "second", "u2")]);
    expect(drainInterjections("conv-b")).toEqual([]);
    expect(offerInterjection("conv-b", msg("3", "third"))).toBe(true);
    expect(drainInterjections("conv-b")).toEqual([msg("3", "third")]);
    closeInterjectionMailbox("conv-b");
  });

  it("closing drops unconsumed offers and refuses new ones", () => {
    openInterjectionMailbox("conv-c");
    expect(offerInterjection("conv-c", msg("1", "too late"))).toBe(true);
    closeInterjectionMailbox("conv-c");
    expect(drainInterjections("conv-c")).toEqual([]);
    expect(offerInterjection("conv-c", msg("2", "after close"))).toBe(false);
  });

  it("mailboxes are per conversation", () => {
    openInterjectionMailbox("conv-d");
    offerInterjection("conv-d", msg("1", "for d"));
    expect(drainInterjections("conv-e")).toEqual([]);
    expect(drainInterjections("conv-d")).toEqual([msg("1", "for d")]);
    closeInterjectionMailbox("conv-d");
  });

  it("peek looks without taking; withdraw takes one back by id", () => {
    openInterjectionMailbox("conv-f");
    offerInterjection("conv-f", msg("1", "one"));
    offerInterjection("conv-f", msg("2", "two"));
    expect(peekInterjections("conv-f").map((x) => x.id)).toEqual(["1", "2"]);
    expect(withdrawInterjection("conv-f", "1")).toBe(true);
    expect(withdrawInterjection("conv-f", "1")).toBe(false);
    expect(drainInterjections("conv-f")).toEqual([msg("2", "two")]);
    expect(withdrawInterjection("conv-zzz", "1")).toBe(false);
    closeInterjectionMailbox("conv-f");
  });
});
