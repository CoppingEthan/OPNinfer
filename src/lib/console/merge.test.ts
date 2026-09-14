import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@/lib/usage-summary";
import { mergeSummaries, portalColour, stackCostByPortal } from "./merge";

const WINDOW = { bucketMs: 3_600_000, count: 3 };

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    range: "day",
    bucketMs: WINDOW.bucketMs,
    points: [
      { t: "2026-09-07T10:00:00.000Z", in: 0, out: 0, cached: 0, cost: 0, requests: 0 },
      { t: "2026-09-07T11:00:00.000Z", in: 0, out: 0, cached: 0, cost: 0, requests: 0 },
      { t: "2026-09-07T12:00:00.000Z", in: 0, out: 0, cached: 0, cost: 0, requests: 0 },
    ],
    totals: {
      cost: 0,
      requests: 0,
      billableRequests: 0,
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      users: 0,
      subscription: { requests: 0, in: 0, out: 0, cacheRead: 0, notionalCost: 0 },
    },
    prev: null,
    byRole: [],
    byProvider: [],
    byModel: [],
    byUser: [],
    recent: [],
    ...over,
  };
}

describe("merging portal usage", () => {
  it("sums the series point for point, keeping the shared time base", () => {
    const a = summary({
      points: [
        { t: "2026-09-07T10:00:00.000Z", in: 10, out: 1, cached: 0, cost: 0.5, requests: 2 },
        { t: "2026-09-07T11:00:00.000Z", in: 0, out: 0, cached: 0, cost: 0, requests: 0 },
        { t: "2026-09-07T12:00:00.000Z", in: 5, out: 2, cached: 3, cost: 0.25, requests: 1 },
      ],
    });
    const b = summary({
      points: [
        { t: "2026-09-07T10:00:00.000Z", in: 4, out: 1, cached: 1, cost: 0.1, requests: 1 },
        { t: "2026-09-07T11:00:00.000Z", in: 8, out: 3, cached: 0, cost: 0.4, requests: 3 },
        { t: "2026-09-07T12:00:00.000Z", in: 0, out: 0, cached: 0, cost: 0, requests: 0 },
      ],
    });
    const m = mergeSummaries([a, b], "day", WINDOW, ["A", "B"]);
    expect(m.points.map((p) => p.in)).toEqual([14, 8, 5]);
    expect(m.points.map((p) => p.requests)).toEqual([3, 3, 1]);
    expect(m.points[0].t).toBe("2026-09-07T10:00:00.000Z");
    expect(m.bucketMs).toBe(WINDOW.bucketMs);
  });

  it("adds the totals, including the subscription split", () => {
    const a = summary({
      totals: {
        cost: 1.5,
        requests: 10,
        billableRequests: 8,
        in: 100,
        out: 20,
        cacheRead: 5,
        cacheWrite: 7,
        users: 3,
        subscription: { requests: 2, in: 9, out: 4, cacheRead: 1, notionalCost: 0.6 },
      },
    });
    const b = summary({
      totals: {
        cost: 0.5,
        requests: 4,
        billableRequests: 4,
        in: 40,
        out: 8,
        cacheRead: 2,
        cacheWrite: 1,
        users: 2,
        subscription: { requests: 0, in: 0, out: 0, cacheRead: 0, notionalCost: 0 },
      },
    });
    const t = mergeSummaries([a, b], "day", WINDOW, ["A", "B"]).totals;
    expect(t.cost).toBeCloseTo(2);
    expect(t.requests).toBe(14);
    // Billable stays the honest denominator: a $0 plan call must not drag the
    // average cost-per-request down.
    expect(t.billableRequests).toBe(12);
    expect(t.users).toBe(5);
    expect(t.subscription.notionalCost).toBeCloseTo(0.6);
  });

  it("combines rows that share a key, and sorts by cost", () => {
    const a = summary({
      byModel: [
        { key: "claude-sonnet-5", sub: "anthropic", requests: 2, in: 10, out: 1, cached: 0, cost: 1 },
      ],
    });
    const b = summary({
      byModel: [
        { key: "claude-sonnet-5", sub: "anthropic", requests: 3, in: 5, out: 2, cached: 1, cost: 2 },
        { key: "gpt-5.6-luna", sub: "openai", requests: 1, in: 1, out: 1, cached: 0, cost: 0.1 },
      ],
    });
    const rows = mergeSummaries([a, b], "day", WINDOW, ["A", "B"]).byModel;
    expect(rows[0]).toMatchObject({ key: "claude-sonnet-5", requests: 5, cost: 3 });
    expect(rows[1].key).toBe("gpt-5.6-luna");
  });

  it("keeps one person's two portal accounts APART", () => {
    // The same address on two portals is two accounts on two systems. Merging
    // them by email would understate the row count and overstate one person.
    const a = summary({
      byUser: [{ key: "sam@x.com", requests: 1, in: 1, out: 1, cached: 0, cost: 1 }],
    });
    const b = summary({
      byUser: [{ key: "sam@x.com", requests: 1, in: 1, out: 1, cached: 0, cost: 2 }],
    });
    const rows = mergeSummaries([a, b], "day", WINDOW, ["Portal A", "Portal B"]).byUser;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sub)).toEqual(["Portal B", "Portal A"]);
  });

  it("tags recent calls with the portal they came from", () => {
    const call = {
      t: "2026-09-07T12:00:00.000Z",
      user: "sam@x.com",
      role: "conversation",
      provider: "anthropic",
      model: "claude-sonnet-5",
      in: 1,
      out: 1,
      cached: 0,
      cost: 0.01,
      billing: "api",
    };
    const m = mergeSummaries(
      [summary({ recent: [call] }), summary({ recent: [{ ...call, t: "2026-09-07T12:30:00.000Z" }] })],
      "day",
      WINDOW,
      ["A", "B"],
    );
    expect(m.recent[0].t).toBe("2026-09-07T12:30:00.000Z"); // newest first
    expect(m.recent[0].user).toBe("sam@x.com · B");
  });

  it("carries a previous window only when some portal reported one", () => {
    expect(mergeSummaries([summary()], "day", WINDOW, ["A"]).prev).toBeNull();
    const withPrev = summary({
      prev: { cost: 1, requests: 2, in: 3, out: 4, notionalCost: 0 },
    });
    expect(mergeSummaries([withPrev, summary()], "day", WINDOW, ["A", "B"]).prev?.cost).toBe(1);
  });

  it("survives a portal that returned nothing at all", () => {
    // `fanOut` drops unreachable portals, so the merge can be handed one
    // summary — or none — and must still produce a whole, zeroed shape.
    const m = mergeSummaries([], "day", WINDOW, []);
    expect(m.points).toHaveLength(WINDOW.count);
    expect(m.totals.cost).toBe(0);
    expect(m.byUser).toEqual([]);
  });
});

/**
 * Splitting the cost chart's bars by portal (owner ask, 2026-09-07). The
 * arithmetic is trivial; what is worth pinning is the JOIN — it works only
 * because every portal was asked for the same bucket grid, so index i is the
 * same instant everywhere — and the ORDERING, which must not move about.
 */
describe("stackCostByPortal", () => {
  const withCosts = (costs: number[]) =>
    summary({
      points: summary().points.map((p, i) => ({ ...p, cost: costs[i] ?? 0 })),
    });

  const portals = [
    { portal: "globex", label: "Globex", summary: withCosts([1, 0, 3]) },
    { portal: "acme", label: "ACME", summary: withCosts([10, 20, 0]) },
  ];

  it("attaches each portal's own cost to every bucket", () => {
    const out = stackCostByPortal(withCosts([11, 20, 3]), portals);
    expect(out.points[0].by).toEqual({ acme: 10, globex: 1 });
    expect(out.points[2].by).toEqual({ globex: 3 });
  });

  it("omits a portal that spent nothing in a bucket", () => {
    // Four portals where three are idle should draw one band, not four
    // zero-height ones, and hover one line rather than four.
    const out = stackCostByPortal(withCosts([11, 20, 3]), portals);
    expect(out.points[1].by).toEqual({ acme: 20 });
    expect(out.points[1].by).not.toHaveProperty("globex");
  });

  it("the bands always sum to the bar", () => {
    const out = stackCostByPortal(withCosts([11, 20, 3]), portals);
    for (const p of out.points) {
      const sum = Object.values(p.by ?? {}).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(p.cost, 10);
    }
  });

  it("orders the bands by name, not by spend", () => {
    // Portals arrive sorted by cost. If the legend followed that, two
    // clients would swap colours the day one outspent the other — and a
    // colour that means something different each visit is worse than none.
    const out = stackCostByPortal(withCosts([11, 20, 3]), portals);
    expect(out.stack?.map((b) => b.key)).toEqual(["acme", "globex"]);
    expect(out.stack?.map((b) => b.label)).toEqual(["ACME", "Globex"]);
  });

  it("leaves a single portal alone — there is nothing to split", () => {
    const one = [portals[0]];
    const out = stackCostByPortal(withCosts([1, 0, 3]), one);
    expect(out.stack).toBeUndefined();
    expect(out.points[0].by).toBeUndefined();
  });

  it("gives each portal a stable, distinct colour", () => {
    const a = portalColour("acme", 0);
    const b = portalColour("globex", 1);
    expect(a).not.toBe(b);
    expect(portalColour("acme", 0)).toBe(a);
    // Beyond the palette it still returns a colour rather than undefined.
    expect(portalColour("a-ninth-portal", 99)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
