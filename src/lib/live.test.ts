import { describe, expect, it } from "vitest";
import {
  broadcastPresence,
  chatViewers,
  liveConnectionCount,
  publishToChat,
  publishToUsers,
  subscribeLive,
  type LiveEvent,
} from "./live";

function tab(userId: string, clientId: string, viewing: string | null) {
  const got: LiveEvent[] = [];
  const off = subscribeLive({ userId, clientId, viewing, send: (ev) => got.push(ev) });
  return { got, off };
}

describe("live feed registry", () => {
  it("chat events reach only the tabs viewing that chat, and can skip the origin tab", () => {
    const a1 = tab("alice", "a1", "chat-1");
    const a2 = tab("alice", "a2", "chat-2");
    const b1 = tab("bob", "b1", "chat-1");
    publishToChat("chat-1", { type: "message", text: "hi" }, { exceptClient: "a1" });
    expect(a1.got).toEqual([]);
    expect(a2.got).toEqual([]);
    expect(b1.got).toEqual([{ conversationId: "chat-1", type: "message", text: "hi" }]);
    a1.off();
    a2.off();
    b1.off();
  });

  it("user events reach every tab of those people, wherever they are", () => {
    const a1 = tab("alice", "a1", "chat-1");
    const a2 = tab("alice", "a2", null);
    const b1 = tab("bob", "b1", null);
    const seen: string[] = [];
    publishToUsers(["alice"], { type: "chat_added" }, { onDeliver: (s) => seen.push(s.clientId) });
    expect(a1.got.length).toBe(1);
    expect(a2.got.length).toBe(1);
    expect(b1.got.length).toBe(0);
    expect(seen.sort()).toEqual(["a1", "a2"]);
    a1.off();
    a2.off();
    b1.off();
  });

  it("presence is the distinct people viewing; a broken sender is dropped", () => {
    const a1 = tab("alice", "a1", "chat-9");
    const a2 = tab("alice", "a2", "chat-9");
    const b1 = tab("bob", "b1", "chat-9");
    const before = liveConnectionCount();
    const broken = subscribeLive({
      userId: "carol",
      clientId: "c1",
      viewing: "chat-9",
      send: () => {
        throw new Error("gone");
      },
    });
    expect(chatViewers("chat-9").sort()).toEqual(["alice", "bob", "carol"]);
    broadcastPresence("chat-9");
    expect(a1.got[0]).toEqual({ conversationId: "chat-9", type: "presence", online: ["alice", "bob", "carol"] });
    expect(a2.got.length).toBe(1);
    expect(b1.got.length).toBe(1);
    // The throwing subscriber was removed on its first failed delivery.
    expect(liveConnectionCount()).toBe(before);
    expect(chatViewers("chat-9").sort()).toEqual(["alice", "bob"]);
    broken();
    a1.off();
    a2.off();
    b1.off();
  });
});
