import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_CEILING } from "./settings";

/**
 * The admin's upload limit cannot exceed what middleware will pass through.
 *
 * Next clones the body of any request its middleware matches, capped at
 * `experimental.middlewareClientMaxBodySize`, and SILENTLY TRUNCATES beyond it.
 * Our middleware matches every upload route. This project has already lost a
 * day to that once, at the 10 MB default; the ceiling then sat at 2 GB against
 * a 256 MB clone cap, so an admin could set a limit that produced uploads which
 * passed the size gate, arrived truncated, and failed in busboy as "Unexpected
 * end of form" — with nothing recording why.
 *
 * Neither number can be checked at runtime (one is build config), so the
 * relationship is checked here.
 */

function middlewareBodyCap(): number {
  const src = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
  const m = /middlewareClientMaxBodySize:\s*([0-9*\s_]+),/.exec(src);
  expect(m, "middlewareClientMaxBodySize not found in next.config.ts").not.toBeNull();
  // e.g. "256 * 1024 * 1024"
  return m![1]
    .split("*")
    .map((p) => Number(p.trim().replace(/_/g, "")))
    .reduce((a, b) => a * b, 1);
}

describe("upload limits", () => {
  it("reads a real cap out of next.config.ts", () => {
    expect(middlewareBodyCap()).toBeGreaterThan(1024 * 1024);
  });

  it("never lets an admin set a limit the middleware would truncate", () => {
    expect(MAX_UPLOAD_CEILING).toBeLessThanOrEqual(middlewareBodyCap());
  });

  it("still allows a useful limit", () => {
    // Sanity: don't "fix" the above by clamping uploads to something tiny.
    expect(MAX_UPLOAD_CEILING).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });

  it("leaves room above the shipped default", () => {
    const shipped = 52_428_800; // OPNINFER_MAX_UPLOAD_BYTES in .env.example
    expect(MAX_UPLOAD_CEILING).toBeGreaterThanOrEqual(shipped);
  });
});
