import { describe, expect, it } from "vitest";
import { STOPPED_TURN_NOTE, annotateAssistantContent, stoppedTurnNote } from "./provenance";

/**
 * A turn the user stopped before any prose must survive replay as a note,
 * not vanish. Without it the model sees the request with no reply and quietly
 * resumes the job on the next message — seen live with a 120-second Sandbox
 * job restarting on "reply with just the word: ready".
 */
describe("stoppedTurnNote", () => {
  it("returns the note only for a row flagged stopped", () => {
    expect(stoppedTurnNote({ stopped: true })).toBe(STOPPED_TURN_NOTE);
    expect(stoppedTurnNote({ stopped: false })).toBeNull();
    expect(stoppedTurnNote({ toolRuns: [] })).toBeNull();
    expect(stoppedTurnNote(null)).toBeNull();
    expect(stoppedTurnNote("stopped")).toBeNull();
  });

  it("the note tells the model the job was NOT completed and not to resume it unasked", () => {
    expect(STOPPED_TURN_NOTE).toMatch(/stopped by the user/i);
    expect(STOPPED_TURN_NOTE).toMatch(/NOT completed/);
    expect(STOPPED_TURN_NOTE).toMatch(/do not resume/i);
  });

  it("composes with the provenance annotation (a stopped turn can still carry sources)", () => {
    const out = annotateAssistantContent(STOPPED_TURN_NOTE, { stopped: true, sources: [{ url: "https://example.com" }] });
    expect(out.startsWith(STOPPED_TURN_NOTE)).toBe(true);
  });
});
