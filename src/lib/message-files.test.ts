import { describe, expect, it } from "vitest";
import { attachFilesToMessages, type FileLite, type MessageLite } from "./message-files";

const d = (s: string) => new Date(s);

function msg(id: string, role: "user" | "assistant", t: string, fileIds?: string[]): MessageLite {
  return { id, role, createdAt: d(t), ...(fileIds ? { fileIds } : {}) };
}
function file(id: string, kind: string, t: string): FileLite {
  return { id, kind, createdAt: d(t) };
}

describe("attachFilesToMessages", () => {
  it("shows a file on EVERY message that names it — attached, then presented back", () => {
    // The owner's report: "presented files disappear from the chat, they were
    // there before". Both turns name the same two files, because the person
    // attached them and the assistant presented them back. While the reply
    // streamed, its cards came from the SSE event and looked right; on reload
    // the user's turn had claimed both ids and the reply rendered nothing.
    const messages = [
      msg("u1", "user", "2026-09-15T12:17:17Z", ["fpdf", "fdocx"]),
      msg("a1", "assistant", "2026-09-15T12:17:25Z", ["fpdf", "fdocx"]),
    ];
    const files = [
      file("fpdf", "upload", "2026-09-15T12:17:00Z"),
      file("fdocx", "upload", "2026-09-15T12:17:02Z"),
    ];
    const { byMessage, pending } = attachFilesToMessages(messages, files);
    expect(byMessage.get("u1")?.map((f) => f.id)).toEqual(["fpdf", "fdocx"]);
    expect(byMessage.get("a1")?.map((f) => f.id)).toEqual(["fpdf", "fdocx"]);
    // …and naming a file twice does not mean showing it twice.
    expect(pending).toHaveLength(0);
  });

  it("does not draw the same card twice when one message lists an id twice", () => {
    const messages = [msg("m1", "user", "2026-09-15T12:00:00Z", ["f1", "f1"])];
    const files = [file("f1", "upload", "2026-09-15T11:59:00Z")];
    const { byMessage } = attachFilesToMessages(messages, files);
    expect(byMessage.get("m1")?.map((f) => f.id)).toEqual(["f1"]);
  });

  it("a file named by a later reply is still not 'pending' — it has a home", () => {
    // The claimed set still governs the composer-restore path: a file that
    // any message names must never be dumped back into the composer.
    const messages = [
      msg("u1", "user", "2026-09-15T12:00:00Z", ["f1"]),
      msg("a1", "assistant", "2026-09-15T12:00:09Z", ["f1"]),
    ];
    const files = [file("f1", "upload", "2026-09-15T11:59:00Z")];
    expect(attachFilesToMessages(messages, files).pending).toHaveLength(0);
  });

  it("uses exact meta.fileIds linkage when present", () => {
    const messages = [
      msg("m1", "user", "2026-07-02T10:00:00Z", ["f1"]),
      msg("m2", "assistant", "2026-07-02T10:00:05Z"),
    ];
    const files = [file("f1", "upload", "2026-07-02T09:59:00Z")];
    const { byMessage, pending } = attachFilesToMessages(messages, files);
    expect(byMessage.get("m1")?.map((f) => f.id)).toEqual(["f1"]);
    expect(pending).toHaveLength(0);
  });

  it("reconstructs the reported chat: two uploads before the 2nd user turn land on it, not the 1st", () => {
    // Exactly the reported conversation's shape/timestamps.
    const messages = [
      msg("u1", "user", "2026-07-02T15:20:44Z"),
      msg("a1", "assistant", "2026-07-02T15:21:02Z"),
      msg("u2", "user", "2026-07-02T15:21:54Z"),
      msg("a2", "assistant", "2026-07-02T15:22:01Z"),
    ];
    const files = [
      file("png", "upload", "2026-07-02T15:21:24Z"),
      file("pdf", "upload", "2026-07-02T15:21:38Z"),
    ];
    const { byMessage, pending } = attachFilesToMessages(messages, files);
    expect(byMessage.get("u2")?.map((f) => f.id)).toEqual(["png", "pdf"]);
    expect(byMessage.has("u1")).toBe(false);
    expect(pending).toHaveLength(0);
  });

  it("links a PRESENTED generated file via meta.fileIds", () => {
    const messages = [
      msg("u1", "user", "2026-07-02T10:00:00Z"),
      msg("a1", "assistant", "2026-07-02T10:00:30Z", ["g1"]),
    ];
    const files = [file("g1", "generated", "2026-07-02T10:00:20Z")];
    const { byMessage } = attachFilesToMessages(messages, files);
    expect(byMessage.get("a1")?.map((f) => f.id)).toEqual(["g1"]);
  });

  it("MASKS unpresented generated files: no time fallback, never pending", () => {
    // Presentation (2026-07-19): the pool is the assistant's workspace — a
    // generated file not in any meta.fileIds must stay invisible on reload.
    const messages = [
      msg("u1", "user", "2026-07-02T10:00:00Z"),
      msg("a1", "assistant", "2026-07-02T10:00:30Z"),
    ];
    const files = [
      file("g1", "generated", "2026-07-02T10:00:20Z"),
      file("g2", "generated", "2026-07-02T10:00:31Z"),
    ];
    const { byMessage, pending } = attachFilesToMessages(messages, files);
    expect(byMessage.size).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it("returns an unsent upload as pending (composer abandoned mid-attach)", () => {
    const messages = [msg("u1", "user", "2026-07-02T10:00:00Z")];
    // uploaded AFTER the only (earlier) user turn, never sent
    const files = [file("f1", "upload", "2026-07-02T10:05:00Z")];
    const { byMessage, pending } = attachFilesToMessages(messages, files);
    expect(byMessage.size).toBe(0);
    expect(pending.map((f) => f.id)).toEqual(["f1"]);
  });

  it("never double-claims a file across meta + time passes", () => {
    const messages = [
      msg("u1", "user", "2026-07-02T10:00:00Z", ["f1"]),
      msg("u2", "user", "2026-07-02T10:01:00Z"),
    ];
    const files = [file("f1", "upload", "2026-07-02T09:59:00Z")];
    const { byMessage } = attachFilesToMessages(messages, files);
    expect(byMessage.get("u1")?.map((f) => f.id)).toEqual(["f1"]);
    expect(byMessage.has("u2")).toBe(false);
  });
});
