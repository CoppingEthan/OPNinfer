import { describe, expect, it } from "vitest";
import { toolStatusLabel } from "./tool-status";

describe("toolStatusLabel", () => {
  it("labels web search with the query", () => {
    expect(toolStatusLabel("web_search", '{"query":"news today"}')).toBe(
      "Searching the web: “news today”",
    );
  });

  it("truncates long queries", () => {
    const label = toolStatusLabel("web_search", JSON.stringify({ query: "x".repeat(200) }));
    expect(label.length).toBeLessThan(90);
    expect(label.endsWith("”")).toBe(true);
  });

  it("labels file reads with the filename", () => {
    expect(toolStatusLabel("read_file", '{"name":"report.pdf"}')).toBe("Reading report.pdf");
    expect(toolStatusLabel("view_image", '{"name":"photo.png"}')).toBe("Looking at photo.png");
  });

  it("gives date/time calls DISTINCT labels (four identical lines read as dithering)", () => {
    expect(toolStatusLabel("date_time_now", '{"timezone":"Asia/Tokyo"}')).toBe(
      "Checking the time in Asia/Tokyo",
    );
    expect(toolStatusLabel("date_time_now", "{}")).toBe("Checking the date & time");
    expect(toolStatusLabel("date_time_diff", '{"from":"now","to":"2027-01-01"}')).toBe(
      "Counting the time until 2027-01-01",
    );
    expect(toolStatusLabel("date_time_diff", '{"to":"2027-01-01"}')).toBe(
      "Counting the time until 2027-01-01",
    );
    expect(
      toolStatusLabel("date_time_diff", '{"from":"3 April 2019","to":"2027-01-01"}'),
    ).toBe("Comparing 3 April 2019 → 2027-01-01");
  });

  it("labels scrape by host for a single url, count for many", () => {
    expect(toolStatusLabel("web_scrape", '{"urls":["https://www.bbc.co.uk/news/x"]}')).toBe(
      "Reading www.bbc.co.uk",
    );
    expect(
      toolStatusLabel("web_scrape", '{"urls":["https://a.test/1","https://b.test/2"]}'),
    ).toBe("Reading 2 web pages");
  });

  it("labels sandbox commands, clipped", () => {
  });

  it("humanizes unknown (capability) tools", () => {
    expect(toolStatusLabel("invoice_search", "{}")).toBe("Invoice search");
  });

  it("never throws on malformed args", () => {
    expect(toolStatusLabel("web_search", "{not json")).toBe("Searching the web");
    expect(toolStatusLabel("read_file", "")).toBe("Reading a file");
  });
});
