import { describe, expect, it } from "vitest";
import { toolStatusLabel } from "@/lib/tools/tool-status";
import { NARRATION, activityBucket, tallyActivity } from "./labels";

/**
 * These assertions go through `toolStatusLabel` rather than hard-coding the
 * strings, so the classifier is tested against the labels the app ACTUALLY
 * writes. If a template changes there, this fails here instead of the console
 * quietly filing that tool under "unknown" for ever.
 */
describe("activity label buckets", () => {
  it("groups a web search with and without its query", () => {
    expect(activityBucket(toolStatusLabel("web_search", '{"query":"hay fever"}'))).toBe(
      "Searched the web",
    );
    expect(activityBucket(toolStatusLabel("web_search", "{}"))).toBe("Searched the web");
  });

  it("groups every date/time shape together", () => {
    const labels = [
      toolStatusLabel("date_time_now", '{"timezone":"Asia/Tokyo"}'),
      toolStatusLabel("date_time_now", "{}"),
      toolStatusLabel("date_time_diff", '{"to":"2027-01-01"}'),
      toolStatusLabel("date_time_diff", '{"from":"a","to":"b"}'),
    ];
    expect(new Set(labels.map(activityBucket))).toEqual(new Set(["Checked the date & time"]));
  });

  it("keeps a file read and a single-page scrape in ONE honest bucket", () => {
    // "Reading report.csv" and "Reading api.github.com" are indistinguishable.
    // Splitting them would be a guess presented as a fact.
    const file = activityBucket(toolStatusLabel("read_file", '{"name":"report.csv"}'));
    const page = activityBucket(toolStatusLabel("web_scrape", '{"urls":["https://api.github.com/x"]}'));
    expect(file).toBe("Read a file or web page");
    expect(page).toBe("Read a file or web page");
  });

  it("still recognises a MULTI-page scrape as the web", () => {
    // Here the tail settles it, so the shared prefix doesn't have to.
    expect(
      activityBucket(toolStatusLabel("web_scrape", '{"urls":["https://a/1","https://b/2"]}')),
    ).toBe("Read a web page");
  });

  it("groups memory writes and erasures as one kind of work", () => {
    expect(activityBucket(toolStatusLabel("memory_update", '{"text":"x"}'))).toBe(
      "Updated its memory",
    );
    expect(activityBucket(toolStatusLabel("memory_update", "{}"))).toBe("Updated its memory");
  });

  it("keeps an unrecognised capability tool under its own name", () => {
    // `invoice_search` renders as "Invoice search" — worth seeing, not
    // worth burying in an "other" bucket.
    expect(activityBucket(toolStatusLabel("invoice_search", "{}"))).toBe("Invoice search");
  });

  it("clips an unknown label rather than dropping it", () => {
    // Label-shaped (one token, under the narration threshold) but too long to
    // sit in a table column.
    const long = "x".repeat(55);
    const out = activityBucket(long);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith("…")).toBe(true);
  });

  it("counts buckets commonest first", () => {
    expect(
      tallyActivity([
        "Searching the web: “a”",
        "Searching the web: “b”",
        "Generating an image",
      ]),
    ).toEqual([
      { key: "Searched the web", count: 2 },
      { key: "Generated an image", count: 1 },
    ]);
  });

  it("treats an empty label as something, not nothing", () => {
    expect(activityBucket("   ")).toBe("Something else");
  });

  /**
   * The Sandbox agent's own commentary goes into the SAME activity log as
   * tool labels, with no structural difference — and on a real portal it
   * swamped the table with one-off sentences while the actual tools fell off
   * the bottom (seen on the first screenshot of this page). These strings are
   * verbatim from a real design run.
   */
  it("files the agent's narration under one bucket, not one row each", () => {
    const narration = [
      "All colors updated. Now re-rendering all four to check the contrast.",
      "All four Facebook ad graphics are done for the campaign — take a look.",
      "All four render cleanly — no clipped text, nothing overlapping.",
      "Both fixes look good — the square ad now has balanced spacing.",
      "Let me check each one for clipping before I hand them over.",
      // Short, and only a trailing full stop separates it from a tool label —
      // this one leaked through the first version of the rule.
      "Now let's render all four to PNG.",
      "Done!",
    ];
    for (const n of narration) expect(activityBucket(n)).toBe(NARRATION);
    expect(tallyActivity(narration)).toEqual([{ key: NARRATION, count: 7 }]);
  });

  it("does NOT mistake a real tool label for narration", () => {
    // Every label this app generates is short and imperative; the longest
    // fixed one is well under the threshold. If one ever grows past it, this
    // fails here rather than silently hiding that tool from the table.
    const labels = [
      toolStatusLabel("list_files", "{}"),
      toolStatusLabel("memory_view", "{}"),
      toolStatusLabel("web_search_and_read", "{}"),
      toolStatusLabel("date_time_diff", "{}"),
      toolStatusLabel("image_blend", "{}"),
      toolStatusLabel("invoice_search", "{}"),
    ];
    for (const l of labels) expect(activityBucket(l)).not.toBe(NARRATION);
  });

  it("keeps a long tool label with an ARGUMENT out of the narration bucket", () => {
    // A search query or a long filename makes the label long, but the PREFIX
    // still identifies it — the prefix match must win over the shape test.
    const long = toolStatusLabel("web_search", `{"query":"${"a".repeat(90)}"}`);
    expect(long.length).toBeGreaterThan(60);
    expect(activityBucket(long)).toBe("Searched the web");
  });
});
