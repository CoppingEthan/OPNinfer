import { describe, expect, it } from "vitest";
import {
  EMPTY_SUBSCRIPTION,
  addSubscriptionRow,
  avgCostPerBillableRequest,
  usageRowCosts,
} from "./usage-math";

describe("usageRowCosts", () => {
  it("an API-billed call costs the estimate and has no notional value", () => {
    expect(usageRowCosts("api", 0.0123)).toEqual({ costEstimate: 0.0123, notionalCost: null });
  });

  it("a subscription-billed call costs $0.00 and keeps the estimate as notional", () => {
    expect(usageRowCosts("subscription", 0.0123)).toEqual({ costEstimate: 0, notionalCost: 0.0123 });
  });

  it("a nonsense estimate never becomes negative or NaN money", () => {
    expect(usageRowCosts("api", NaN)).toEqual({ costEstimate: 0, notionalCost: null });
    expect(usageRowCosts("api", -4)).toEqual({ costEstimate: 0, notionalCost: null });
    expect(usageRowCosts("subscription", NaN)).toEqual({ costEstimate: 0, notionalCost: 0 });
  });
});

describe("avgCostPerBillableRequest", () => {
  it("averages over billable requests only — subscription rows must not drag it down", () => {
    // 10 API calls at $0.05 plus 90 subscription calls at $0.00: the honest
    // average is $0.05, not $0.005.
    expect(avgCostPerBillableRequest(0.5, 10)).toBeCloseTo(0.05);
  });

  it("is null when nothing was billable", () => {
    expect(avgCostPerBillableRequest(0, 0)).toBeNull();
    expect(avgCostPerBillableRequest(NaN, 3)).toBeNull();
  });
});

describe("addSubscriptionRow", () => {
  it("accumulates tokens and the notional value", () => {
    let t = EMPTY_SUBSCRIPTION;
    t = addSubscriptionRow(t, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, notionalCost: 0.01 });
    t = addSubscriptionRow(t, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, notionalCost: null });
    expect(t).toEqual({ requests: 2, in: 11, out: 22, cacheRead: 303, notionalCost: 0.01 });
  });

  it("does not mutate the input", () => {
    const before = { ...EMPTY_SUBSCRIPTION };
    addSubscriptionRow(EMPTY_SUBSCRIPTION, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, notionalCost: 1 });
    expect(EMPTY_SUBSCRIPTION).toEqual(before);
  });
});
