/**
 * The accounting rules for a usage row and for the dashboard's headline
 * numbers — pure, so the two places money is summarised (the usage summary
 * endpoint and the weekly report) cannot drift from each other or from the
 * tests. Owner decisions, 2026-08-24:
 *
 *  - a subscription-billed call costs $0.00 (it's the operator's plan) but
 *    its API-rate value is kept as `notional` and shown as "saved";
 *  - subscription rows must never drag the average cost-per-request down —
 *    the average is over BILLABLE calls only;
 *  - tokens are always real and always counted.
 */

export type BillingSource = "api" | "subscription";

/** What to write on a usage row given who paid and the API-rate estimate. */
export function usageRowCosts(
  billingSource: BillingSource,
  estimateUsd: number,
): { costEstimate: number; notionalCost: number | null } {
  const est = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
  return billingSource === "subscription"
    ? { costEstimate: 0, notionalCost: est }
    : { costEstimate: est, notionalCost: null };
}

/** Average cost per BILLABLE request; null when there were none. */
export function avgCostPerBillableRequest(costUsd: number, billableRequests: number): number | null {
  if (!Number.isFinite(costUsd) || billableRequests <= 0) return null;
  return costUsd / billableRequests;
}

export interface SubscriptionTotals {
  requests: number;
  in: number;
  out: number;
  cacheRead: number;
  /** What these calls would have cost at API rates — the "saved" figure. */
  notionalCost: number;
}

export const EMPTY_SUBSCRIPTION: SubscriptionTotals = {
  requests: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  notionalCost: 0,
};

/** Fold one subscription-billed row into the running totals. */
export function addSubscriptionRow(
  t: SubscriptionTotals,
  row: { inputTokens: number; outputTokens: number; cacheReadTokens: number; notionalCost: number | null },
): SubscriptionTotals {
  return {
    requests: t.requests + 1,
    in: t.in + row.inputTokens,
    out: t.out + row.outputTokens,
    cacheRead: t.cacheRead + row.cacheReadTokens,
    notionalCost: t.notionalCost + (row.notionalCost ?? 0),
  };
}
