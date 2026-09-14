import { describe, expect, it } from "vitest";
import {
  canCancelQueued,
  canEditMessage,
  canLeaveChat,
  canManageChat,
  canUseChat,
  displayName,
  isSharedChat,
  memoryAllowed,
  roleFor,
  shortName,
} from "./chat-rules";

const OWNER = "owner-1";
const MEMBER = "member-1";
const OTHER = "someone-else";

describe("roleFor / isSharedChat", () => {
  const privateChat = { userId: OWNER, members: [] };
  const shared = { userId: OWNER, members: [{ userId: OWNER }, { userId: MEMBER }] };

  it("owner, member, or nothing", () => {
    expect(roleFor(privateChat, OWNER)).toBe("owner");
    expect(roleFor(privateChat, MEMBER)).toBeNull();
    expect(roleFor(shared, OWNER)).toBe("owner");
    expect(roleFor(shared, MEMBER)).toBe("member");
    expect(roleFor(shared, OTHER)).toBeNull();
  });

  it("the owner is the owner even with a member row of their own", () => {
    expect(roleFor({ userId: OWNER, members: [{ userId: OWNER }] }, OWNER)).toBe("owner");
  });

  it("shared = any member rows; a chat with no rows (or none loaded) is private", () => {
    expect(isSharedChat(privateChat)).toBe(false);
    expect(isSharedChat({ userId: OWNER })).toBe(false);
    expect(isSharedChat(shared)).toBe(true);
  });
});

describe("what each role may do", () => {
  it("manage (invite/remove/delete) is the owner's; leave is the member's; use is anyone in it", () => {
    expect(canManageChat("owner")).toBe(true);
    expect(canManageChat("member")).toBe(false);
    expect(canManageChat(null)).toBe(false);
    expect(canLeaveChat("member")).toBe(true);
    expect(canLeaveChat("owner")).toBe(false);
    expect(canUseChat("owner")).toBe(true);
    expect(canUseChat("member")).toBe(true);
    expect(canUseChat(null)).toBe(false);
  });

  it("a scheduled message is cancelled by its author or the owner, nobody else", () => {
    expect(canCancelQueued("member", MEMBER, MEMBER)).toBe(true);
    expect(canCancelQueued("owner", MEMBER, OWNER)).toBe(true);
    expect(canCancelQueued("member", OWNER, MEMBER)).toBe(false);
  });

  it("memory is off in incognito AND in any shared chat", () => {
    expect(memoryAllowed({ incognito: false, members: [] })).toBe(true);
    expect(memoryAllowed({ incognito: true, members: [] })).toBe(false);
    expect(memoryAllowed({ incognito: false, members: [{ userId: OWNER }, { userId: MEMBER }] })).toBe(false);
  });
});

describe("canEditMessage — the revert must never delete someone else's words", () => {
  const u = (userId: string | null) => ({ role: "user", userId });
  const a = () => ({ role: "assistant", userId: null });

  it("a private chat: every user turn is mine, so editing is always allowed", () => {
    expect(canEditMessage({ me: OWNER, message: u(OWNER), later: [a(), u(OWNER), a()] })).toBe(true);
  });

  it("only my own message, and only a user turn", () => {
    expect(canEditMessage({ me: MEMBER, message: u(OWNER), later: [] })).toBe(false);
    expect(canEditMessage({ me: OWNER, message: a(), later: [] })).toBe(false);
    expect(canEditMessage({ me: OWNER, message: u(null), later: [] })).toBe(false);
  });

  it("blocked once someone else has written after it; the assistant's replies don't count", () => {
    expect(canEditMessage({ me: OWNER, message: u(OWNER), later: [a()] })).toBe(true);
    expect(canEditMessage({ me: OWNER, message: u(OWNER), later: [a(), u(MEMBER)] })).toBe(false);
    expect(canEditMessage({ me: MEMBER, message: u(MEMBER), later: [a(), u(MEMBER), a()] })).toBe(true);
  });
});

describe("names", () => {
  it("prefers the profile name, falls back to the email's local part", () => {
    expect(displayName({ name: "Priya Barker", email: "d@x.test" })).toBe("Priya Barker");
    expect(displayName({ name: "  ", email: "sam.k@x.test" })).toBe("sam.k");
    expect(displayName({})).toBe("Someone");
    expect(shortName({ name: "Priya Barker" })).toBe("Priya");
    expect(shortName({ email: "sam.k@x.test" })).toBe("sam.k");
  });
});
