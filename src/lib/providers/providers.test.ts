import { describe, it, expect, vi, afterEach } from "vitest";
import { isChatModel } from "./openai";
import { toProviderId, toDbProvider } from "./mapping";
import {
  getCachedModels,
  setCachedModels,
  invalidateModels,
} from "./model-cache";
import { isAbortError, isRetryableError } from "./errors";
import type { ProviderId } from "./types";

describe("isAbortError", () => {
  it("catches a raw DOMException-style AbortError", () => {
    const e = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    expect(isAbortError(e)).toBe(true);
  });

  it("catches the Stainless SDK APIUserAbortError (name is 'Error', not 'AbortError')", () => {
    // Reproduces @anthropic-ai/sdk + openai APIUserAbortError: extends APIError
    // → Error, never sets .name (inherits "Error"), .status is undefined. The
    // old `err.name === "AbortError"` guard missed this and it failed over.
    class APIUserAbortError extends Error {
      status: undefined;
      constructor() {
        super("Request was aborted.");
        this.status = undefined;
      }
    }
    const e = new APIUserAbortError();
    expect(e.name).toBe("Error"); // the trap: not "AbortError"
    expect(isAbortError(e)).toBe(true); // caught by constructor name
    // Since the 2026-09-05 audit a status-less error is retryable only when
    // it LOOKS like the network; an abort message is not, so even without
    // the abort check this would no longer fail over (it used to — which is
    // why the name-only guard was such a costly miss).
    expect(isRetryableError(e)).toBe(false);
  });

  it("treats an aborted signal as definitive regardless of the error", () => {
    const ac = new AbortController();
    ac.abort();
    // A totally unrelated error object still counts as an abort if the signal fired.
    expect(isAbortError(new Error("Request was aborted."), ac.signal)).toBe(true);
    expect(isAbortError({}, ac.signal)).toBe(true);
  });

  it("does NOT treat a genuine transient failure as an abort", () => {
    const ac = new AbortController(); // not aborted
    const e = Object.assign(new Error("503 upstream"), { status: 503 });
    expect(isAbortError(e, ac.signal)).toBe(false);
    expect(isRetryableError(e)).toBe(true); // still fails over — correctly
  });

  it("does NOT treat a 4xx config error as an abort", () => {
    const e = Object.assign(new Error("400 bad model"), { status: 400 });
    expect(isAbortError(e)).toBe(false);
    expect(isRetryableError(e)).toBe(false);
  });
});

describe("isChatModel", () => {
  it("keeps GPT and o-series chat models", () => {
    for (const id of ["gpt-4o", "gpt-5.1", "gpt-4.1-mini", "o3", "o4-mini", "chatgpt-4o-latest"]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it("drops non-chat model families", () => {
    for (const id of [
      "text-embedding-3-small",
      "whisper-1",
      "dall-e-3",
      "tts-1",
      "gpt-4o-audio-preview",
      "omni-moderation-latest",
      "gpt-3.5-turbo-instruct",
      "gpt-4o-realtime-preview",
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });
});

describe("provider enum <-> id mapping", () => {
  const ids: ProviderId[] = ["openai", "anthropic-api", "google"];

  it("round-trips every provider id", () => {
    for (const id of ids) {
      expect(toProviderId(toDbProvider(id))).toBe(id);
    }
  });

  it("maps hyphenated ids to underscored db enum values", () => {
    expect(toDbProvider("anthropic-api")).toBe("anthropic_api");
    expect(toDbProvider("openai")).toBe("openai");
  });
});

describe("model cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    invalidateModels("cred-1");
  });

  const models = [{ id: "gpt-4o", displayName: "GPT-4o" }];

  it("stores and returns models within the TTL", () => {
    setCachedModels("cred-1", models);
    expect(getCachedModels("cred-1")).toEqual(models);
  });

  it("expires entries after 1 hour", () => {
    vi.useFakeTimers();
    setCachedModels("cred-1", models);
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(getCachedModels("cred-1")).toBeNull();
  });

  it("invalidate clears immediately", () => {
    setCachedModels("cred-1", models);
    invalidateModels("cred-1");
    expect(getCachedModels("cred-1")).toBeNull();
  });
});

describe("isRetryableError without an HTTP status (audit 2026-09-05)", () => {
  it("fails over for network-looking failures", () => {
    for (const e of [
      Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }),
      Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
      new Error("socket hang up"),
    ]) {
      expect(isRetryableError(e), e.message).toBe(true);
    }
  });
  it("does NOT fail over for our own bugs, so they surface as errors", () => {
    for (const e of [new Error("Unsupported state or unable to authenticate data"), new TypeError("Cannot read properties of undefined"), new Error("Role credential not found.")]) {
      expect(isRetryableError(e), e.message).toBe(false);
    }
  });
});
