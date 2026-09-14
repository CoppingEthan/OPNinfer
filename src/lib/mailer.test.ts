import { beforeAll, describe, expect, it } from "vitest";

/**
 * How the SMTP relay password is stored and read back.
 *
 * Two bugs met here. It was the ONE admin secret kept in plaintext — so a
 * backup zip, which is a plain JSON dump, carried working mail credentials for
 * the client's domain, while the provider keys in the same file were useless
 * without the master key. And saving the SMTP form without retyping the
 * password (the field renders "•••••• (unchanged)") wrote `undefined` over the
 * stored value, so an admin who edited the From address silently broke every
 * invite and password-reset email — the only way migrated users get back in.
 */

let mailer: typeof import("./mailer");
let crypto: typeof import("./crypto");

beforeAll(async () => {
  // 32 random bytes, base64 — the shape crypto.ts expects.
  process.env.OPNINFER_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  crypto = await import("./crypto");
  mailer = await import("./mailer");
});

describe("readStoredSmtpPassword", () => {
  it("decrypts a password stored the current way", () => {
    const enc = crypto.encrypt("hunter2").toString("base64");
    expect(mailer.readStoredSmtpPassword({ passwordEncrypted: enc })).toBe("hunter2");
  });

  it("still reads a legacy plaintext password, so existing installs keep sending", () => {
    expect(mailer.readStoredSmtpPassword({ password: "legacy-pw" })).toBe("legacy-pw");
  });

  it("prefers the encrypted value when both are present", () => {
    const enc = crypto.encrypt("current").toString("base64");
    expect(
      mailer.readStoredSmtpPassword({ password: "stale", passwordEncrypted: enc }),
    ).toBe("current");
  });

  it("treats an undecryptable value as unset rather than throwing", () => {
    // A backup restored onto an instance with a different master key.
    expect(
      mailer.readStoredSmtpPassword({ passwordEncrypted: "bm90LXJlYWxseS1lbmNyeXB0ZWQ=" }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(mailer.readStoredSmtpPassword(null)).toBeUndefined();
    expect(mailer.readStoredSmtpPassword({})).toBeUndefined();
    expect(mailer.readStoredSmtpPassword({ password: "" })).toBeUndefined();
  });

  it("round-trips a password with awkward characters", () => {
    const pw = 'p@ss "word" £5 \\ \n ünïcode';
    const enc = crypto.encrypt(pw).toString("base64");
    expect(mailer.readStoredSmtpPassword({ passwordEncrypted: enc })).toBe(pw);
  });
});
