import { afterEach, describe, expect, it } from "vitest";
import { configuredOperators, operatorId, parseOperators } from "./operators";

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo";

describe("console operator accounts", () => {
  it("parses email:hash pairs separated by ; or newline", () => {
    expect(parseOperators(`a@x.com:${HASH};b@y.com:${HASH}`)).toEqual([
      { email: "a@x.com", hash: HASH },
      { email: "b@y.com", hash: HASH },
    ]);
    expect(parseOperators(`a@x.com:${HASH}\nb@y.com:${HASH}`)).toHaveLength(2);
  });

  it("splits on the FIRST colon, so the hash survives intact", () => {
    // An argon2 encoding contains $ , = and base64 — but never a colon, which
    // is the whole reason this separator is safe.
    const [op] = parseOperators(`a@x.com:${HASH}`);
    expect(op.hash).toBe(HASH);
  });

  it("lower-cases and trims the address", () => {
    expect(parseOperators(`  Alice@Example.COM :${HASH}`)[0].email).toBe("alice@example.com");
  });

  it("refuses anything that is not an argon2 hash", () => {
    // A plaintext password left in the file by hand must never quietly work.
    expect(parseOperators("a@x.com:hunter2")).toEqual([]);
    expect(parseOperators("a@x.com:$2b$10$abcdefghijklmnop")).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    // One bad line must not lock the operator out of their own overview.
    const out = parseOperators(`nonsense;no-at-sign:${HASH};;a@x.com:${HASH}`);
    expect(out).toEqual([{ email: "a@x.com", hash: HASH }]);
  });

  it("ignores comments and blank entries", () => {
    expect(parseOperators(`# a comment\n\na@x.com:${HASH}`)).toHaveLength(1);
  });

  it("keeps the first of a duplicated address", () => {
    const out = parseOperators(`a@x.com:${HASH};a@x.com:$argon2id$other`);
    expect(out).toHaveLength(1);
    expect(out[0].hash).toBe(HASH);
  });

  it("treats no configuration as no accounts", () => {
    expect(parseOperators(undefined)).toEqual([]);
    expect(parseOperators("")).toEqual([]);
  });

  it("gives a stable, recognisable id", () => {
    expect(operatorId("A@x.com")).toBe("operator:a@x.com");
  });

  /**
   * THE BUG (found live, 2026-09-07): docker compose INTERPOLATES `$` in an
   * env_file, and an argon2 encoding is `$argon2id$v=19$m=...$salt$hash`. It
   * substituted `$argon2id`, `$v`, `$m` and `$p` as undefined variables, so
   * 147 bytes in the file arrived as 88 in the container with the algorithm
   * name gone — and the console said "no operator accounts are configured",
   * which is indistinguishable from never having set one. Base64 has no `$`.
   */
  describe("reading the configured accounts", () => {
    const env = process.env;
    afterEach(() => {
      delete process.env.CONSOLE_OPERATORS_B64;
      delete process.env.CONSOLE_OPERATORS;
      Object.assign(process.env, env);
    });

    it("prefers the base64 form", () => {
      process.env.CONSOLE_OPERATORS_B64 = Buffer.from(`a@x.com:${HASH}`).toString("base64");
      process.env.CONSOLE_OPERATORS = `plain@x.com:${HASH}`;
      expect(configuredOperators()).toEqual([{ email: "a@x.com", hash: HASH }]);
    });

    it("round-trips a hash through base64 with every $ intact", () => {
      const encoded = Buffer.from(`a@x.com:${HASH}`).toString("base64");
      expect(encoded).not.toContain("$");
      process.env.CONSOLE_OPERATORS_B64 = encoded;
      expect(configuredOperators()[0].hash).toBe(HASH);
    });

    it("still accepts the plain form when there is no base64 one", () => {
      process.env.CONSOLE_OPERATORS = `a@x.com:${HASH}`;
      expect(configuredOperators()).toHaveLength(1);
    });

    it("treats unusable base64 as no accounts, not as a crash", () => {
      process.env.CONSOLE_OPERATORS_B64 = "not really base64 !!!";
      expect(configuredOperators()).toEqual([]);
    });

    it("would reject the mangled hash compose actually produced", () => {
      // Verbatim shape of what reached the container that day.
      process.env.CONSOLE_OPERATORS = "support@example.com:=19=19456,t=2,p=1";
      expect(configuredOperators()).toEqual([]);
    });
  });
});
