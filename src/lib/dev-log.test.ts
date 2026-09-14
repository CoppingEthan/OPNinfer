import { describe, expect, it } from "vitest";
import { sanitize } from "./dev-log";

describe("dev-log sanitize", () => {
  it("redacts secret-ish keys (never write keys/passwords/tokens)", () => {
    const out = sanitize({
      apiKey: "sk-abc123",
      api_key: "x",
      password: "hunter2",
      token: "t",
      authorization: "Bearer y",
      masterKey: "m",
      cookie: "sid=1",
      keepme: "visible",
    }) as Record<string, string>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.token).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.masterKey).toBe("[redacted]");
    expect(out.cookie).toBe("[redacted]");
    expect(out.keepme).toBe("visible");
  });

  it("shrinks base64 blob fields to a size hint (no megabytes in the log)", () => {
    const out = sanitize({ dataBase64: "A".repeat(5000), inlineData: "B".repeat(9000) }) as Record<string, string>;
    expect(out.dataBase64).toMatch(/^\[blob 5000 chars\]$/);
    expect(out.inlineData).toMatch(/^\[blob 9000 chars\]$/);
  });

  it("truncates long strings", () => {
    const out = sanitize("z".repeat(2000)) as string;
    expect(out.length).toBeLessThan(900);
    expect(out).toContain("(+1200 chars)");
  });

  it("caps big arrays and deep nesting", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const out = sanitize(arr) as unknown[];
    expect(out.length).toBe(41); // 40 + the "…(+60 more)" marker
    expect(out[40]).toBe("…(+60 more)");
  });

  it("passes through primitives and normalizes errors + bigint", () => {
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
    expect(sanitize(10n)).toBe("10n");
    expect(sanitize(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });

  it("redacts nested secrets too", () => {
    const out = sanitize({ cred: { secret: "s", model: "gpt" } }) as { cred: Record<string, string> };
    expect(out.cred.secret).toBe("[redacted]");
    expect(out.cred.model).toBe("gpt");
  });
});
