import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseChangelog,
  releasesSince,
  shouldShowWhatsNew,
  type Release,
} from "./changelog";

const SAMPLE = `# Changelog

Preamble prose that is not part of any release.

## Unreleased

- Something still being built.

## 0.3.2 — 2026-07-30

- **Assistant instructions** — standing instructions per instance,
  applied from the next message.
- Weekly report email.

## 0.3.1 - 2026-07-29

- Long replies are no longer cut short.

## 0.2.0

- Attach any file.
`;

describe("compareVersions", () => {
  it("orders by numeric segment", () => {
    expect(compareVersions("0.3.2", "0.3.1")).toBeGreaterThan(0);
    expect(compareVersions("0.3.1", "0.3.2")).toBeLessThan(0);
    expect(compareVersions("0.3.2", "0.3.2")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("tolerates a v prefix and a missing segment", () => {
    expect(compareVersions("v0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.4", "0.4.0")).toBe(0);
    expect(compareVersions("0.4", "0.4.1")).toBeLessThan(0);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareVersions("0.4.0-rc1", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.4.0", "0.4.0-rc1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0-rc1", "0.4.0-rc2")).toBeLessThan(0);
  });

  it("does not throw on nonsense", () => {
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("banana", "0.1.0")).toBeLessThan(0);
  });
});

describe("parseChangelog", () => {
  const releases = parseChangelog(SAMPLE);

  it("returns releases newest first", () => {
    expect(releases.map((r) => r.version)).toEqual(["0.3.2", "0.3.1", "0.2.0"]);
  });

  it("ignores headings with no parsable version", () => {
    expect(releases.some((r) => /unreleased/i.test(r.version))).toBe(false);
  });

  it("keeps the date from the heading, and copes without one", () => {
    expect(releases[0].date).toBe("2026-07-30");
    expect(releases[1].date).toBe("2026-07-29"); // hyphen separator
    expect(releases[2].date).toBeUndefined();
  });

  it("collects bullets and folds continuation lines into them", () => {
    expect(releases[0].items).toHaveLength(2);
    expect(releases[0].items[0]).toBe(
      "**Assistant instructions** — standing instructions per instance, applied from the next message.",
    );
    expect(releases[0].items[1]).toBe("Weekly report email.");
  });

  it("drops preamble prose", () => {
    const text = JSON.stringify(releases);
    expect(text).not.toContain("Preamble prose");
  });

  it("returns nothing for an empty or headingless file", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nNothing here yet.\n")).toEqual([]);
  });

  it("parses the real CHANGELOG.md that ships with the app", () => {
    const md = readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
    const real = parseChangelog(md);
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((r) => r.items.length > 0)).toBe(true);
    // Sorted newest first, with no duplicate versions.
    const versions = real.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("releasesSince / shouldShowWhatsNew", () => {
  const releases: Release[] = parseChangelog(SAMPLE);

  it("gives a first-time viewer only the latest release", () => {
    const shown = releasesSince(releases, null, "0.3.2");
    expect(shown.map((r) => r.version)).toEqual(["0.3.2"]);
    expect(shouldShowWhatsNew(releases, null, "0.3.2")).toBe(true);
  });

  it("gives a returning viewer everything since they last looked", () => {
    expect(releasesSince(releases, "0.2.0", "0.3.2").map((r) => r.version)).toEqual([
      "0.3.2",
      "0.3.1",
    ]);
  });

  it("shows nothing when the user is up to date", () => {
    expect(releasesSince(releases, "0.3.2", "0.3.2")).toEqual([]);
    expect(shouldShowWhatsNew(releases, "0.3.2", "0.3.2")).toBe(false);
  });

  it("never announces a release the instance has not shipped yet", () => {
    // Notes are written before the deploy that carries them.
    expect(releasesSince(releases, "0.3.1", "0.3.1")).toEqual([]);
    expect(shouldShowWhatsNew(releases, "0.3.1", "0.3.1")).toBe(false);
    expect(releasesSince(releases, "0.2.0", "0.3.1").map((r) => r.version)).toEqual([
      "0.3.1",
    ]);
  });

  it("shows nothing to a user ahead of the instance (rollback, restored backup)", () => {
    expect(shouldShowWhatsNew(releases, "0.9.0", "0.3.2")).toBe(false);
  });

  it("shows nothing when there are no notes at all", () => {
    expect(shouldShowWhatsNew([], null, "0.3.2")).toBe(false);
    expect(releasesSince([], "0.1.0", "0.3.2")).toEqual([]);
  });
});

describe("deployment", () => {
  /**
   * The Next standalone build ships only what the Dockerfile COPYs. Miss this
   * line and `readFile` throws in production, the action catches it as "no
   * notes yet", and the panel is permanently empty on every live instance
   * while working perfectly in dev — a failure with no error to find.
   */
  it("Dockerfile copies CHANGELOG.md into the runtime image", () => {
    const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).not.toBe("");
    // Deliberately loose about flags (--chown and friends move around as the
    // build is tuned) and strict about the part that matters: the runner stage
    // copies CHANGELOG.md in from the build, to a destination.
    expect(runner).toMatch(/^COPY\s+--from=builder\b.*\s\S*CHANGELOG\.md\s+\S+$/m);
  });
});
