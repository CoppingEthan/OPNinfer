import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The app-log fan-out is what the error alerts and the live Logs page hang
 * off. Next instantiates modules per route bundle, so the subscriber set MUST
 * live on globalThis or a subscriber registered at server start never hears
 * an event logged from a route (2026-09-04: twenty error rows, alerts on,
 * SMTP working, zero emails). Pinned against the source because no unit
 * test can reproduce the bundling.
 */
describe("applog listeners survive per-bundle module instances", () => {
  const src = readFileSync(new URL("./applog.ts", import.meta.url), "utf8");

  it("anchors the listener set on globalThis", () => {
    expect(src).toMatch(/globalThis as \{ __opninferLogListeners/);
    expect(src).toMatch(/g\.__opninferLogListeners \?\?= new Set/);
  });

  it("does not keep a module-local set", () => {
    expect(src).not.toMatch(/^const listeners = new Set/m);
  });
});
