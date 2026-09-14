import { describe, expect, it } from "vitest";
import { envSuffix, parseInstances } from "./instances";

describe("console portal list", () => {
  it("builds one entry per named portal", () => {
    expect(
      parseInstances({
        CONSOLE_INSTANCES: "acme globex",
        CONSOLE_DB_ACME: "postgresql://console_ro:x@opninfer-acme-db-1:5432/opninfer",
        CONSOLE_LABEL_ACME: "chat.acme.example",
        CONSOLE_DB_GLOBEX: "postgresql://console_ro:y@opninfer-globex-db-1:5432/opninfer",
      }),
    ).toEqual([
      {
        name: "acme",
        label: "chat.acme.example",
        url: "postgresql://console_ro:x@opninfer-acme-db-1:5432/opninfer",
      },
      {
        // No label configured — the name is a usable fallback, never blank.
        name: "globex",
        label: "globex",
        url: "postgresql://console_ro:y@opninfer-globex-db-1:5432/opninfer",
      },
    ]);
  });

  it("accepts commas and newlines as separators", () => {
    const env = {
      CONSOLE_INSTANCES: "a,\n b",
      CONSOLE_DB_A: "postgresql://a",
      CONSOLE_DB_B: "postgresql://b",
    };
    expect(parseInstances(env).map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("DROPS a portal with no connection string", () => {
    // It means deploy.sh could not create the read-only role there. Three
    // portals shown truthfully beats four with one permanently erroring.
    const out = parseInstances({
      CONSOLE_INSTANCES: "acme ghost",
      CONSOLE_DB_ACME: "postgresql://x",
    });
    expect(out.map((i) => i.name)).toEqual(["acme"]);
  });

  it("de-duplicates a repeated name", () => {
    expect(
      parseInstances({ CONSOLE_INSTANCES: "a a", CONSOLE_DB_A: "postgresql://a" }),
    ).toHaveLength(1);
  });

  it("has nothing to show when nothing is configured", () => {
    expect(parseInstances({})).toEqual([]);
  });

  it("derives env suffixes the way deploy.sh writes them", () => {
    // Must agree with `env_suffix` in deploy.sh — a mismatch means the console
    // silently sees no portals at all.
    expect(envSuffix("acme")).toBe("ACME");
    expect(envSuffix("ini-tech")).toBe("INI_TECH");
    expect(envSuffix("Client 2")).toBe("CLIENT_2");
  });
});
