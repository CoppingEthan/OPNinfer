import { describe, expect, it } from "vitest";
import {
  QUEUE_CAP,
  clearQueued,
  enqueueMessage,
  listQueued,
  queueSnapshot,
  removeQueued,
  shiftQueued,
  type QueuedMessage,
} from "./chat-queue";

function item(conversationId: string, id: string, userId = "u1", fileIds: string[] = []): QueuedMessage {
  return {
    id,
    conversationId,
    userId,
    author: { id: userId, name: userId.toUpperCase(), image: null },
    content: `msg ${id}`,
    fileIds,
    extendedThinking: false,
    steering: fileIds.length === 0,
    createdAt: Date.now(),
  };
}

describe("scheduled-message queue", () => {
  it("keeps arrival order per chat and hands entries out one at a time", () => {
    expect(enqueueMessage(item("c1", "a", "alice"))).toBe(true);
    expect(enqueueMessage(item("c1", "b", "bob"))).toBe(true);
    expect(enqueueMessage(item("c2", "z"))).toBe(true);
    expect(listQueued("c1").map((x) => x.id)).toEqual(["a", "b"]);
    expect(shiftQueued("c1")?.userId).toBe("alice");
    expect(shiftQueued("c1")?.userId).toBe("bob");
    expect(shiftQueued("c1")).toBeNull();
    expect(listQueued("c2").length).toBe(1);
    clearQueued("c2");
    expect(listQueued("c2")).toEqual([]);
  });

  it("removes by id (cancel / consumed as a steer) and reports what it removed", () => {
    enqueueMessage(item("c3", "a"));
    enqueueMessage(item("c3", "b"));
    expect(removeQueued("c3", "a")?.id).toBe("a");
    expect(removeQueued("c3", "a")).toBeNull();
    expect(listQueued("c3").map((x) => x.id)).toEqual(["b"]);
    clearQueued("c3");
  });

  it("the snapshot hides file ids and the thinking flag but says how many files ride along", () => {
    enqueueMessage(item("c4", "a", "alice", ["f1", "f2"]));
    expect(queueSnapshot("c4")).toEqual([
      {
        id: "a",
        userId: "alice",
        author: { id: "alice", name: "ALICE", image: null },
        content: "msg a",
        steering: false,
        fileCount: 2,
      },
    ]);
    clearQueued("c4");
  });

  it("refuses beyond the cap", () => {
    for (let i = 0; i < QUEUE_CAP; i++) expect(enqueueMessage(item("c5", `i${i}`))).toBe(true);
    expect(enqueueMessage(item("c5", "overflow"))).toBe(false);
    clearQueued("c5");
  });
});
