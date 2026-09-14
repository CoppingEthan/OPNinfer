import { describe, expect, it } from "vitest";
import { fileCardInfo, fileCategory, humaniseFilename } from "./file-card";

describe("humaniseFilename — Claude.ai-style titles", () => {
  it("turns separators into spaces, lower-cases, capitalises the first letter", () => {
    expect(humaniseFilename("pr-property-email-signature.html")).toBe("Pr property email signature");
    expect(humaniseFilename("README-how-to-install-the-signature.txt")).toBe("Readme how to install the signature");
    expect(humaniseFilename("Pr_Property_Banner.jpg")).toBe("Pr property banner");
    expect(humaniseFilename("salesReport.final.v2.xlsx")).toBe("Sales report final v2");
  });
  it("copes with no extension, paths and dotfiles", () => {
    expect(humaniseFilename("Makefile")).toBe("Makefile");
    expect(humaniseFilename("coffee-ads/fb-cover.png")).toBe("Fb cover");
    expect(humaniseFilename(".env")).toBe(".env");
  });
});

describe("fileCategory / fileCardInfo", () => {
  it("classifies by extension first, then mime", () => {
    expect(fileCategory("index.html")).toBe("web");
    expect(fileCategory("script.py")).toBe("code");
    expect(fileCategory("notes.txt")).toBe("text");
    expect(fileCategory("report.pdf")).toBe("pdf");
    expect(fileCategory("data.xlsx")).toBe("spreadsheet");
    expect(fileCategory("deck.pptx")).toBe("presentation");
    expect(fileCategory("photo.jpg")).toBe("image");
    expect(fileCategory("bundle.zip")).toBe("archive");
    expect(fileCategory("config.json")).toBe("data");
    expect(fileCategory("unknown", "audio/mpeg")).toBe("audio");
    expect(fileCategory("unknown", "application/octet-stream")).toBe("file");
  });
  it("builds the 'Kind · EXT' subtitle", () => {
    expect(fileCardInfo("pr-property-email-signature.html").subtitle).toBe("Code · HTML");
    expect(fileCardInfo("pr-property-banner.jpg").subtitle).toBe("Image · JPG");
    expect(fileCardInfo("README.txt").subtitle).toBe("Text · TXT");
    expect(fileCardInfo("Makefile").subtitle).toBe("File");
  });
});
