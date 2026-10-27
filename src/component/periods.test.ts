import rateLimiterTest from "@convex-dev/rate-limiter/test";
import shardedCounterTest from "@convex-dev/sharded-counter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob([
  "./**/*.ts",
  "!./**/*.test.ts",
  "!./**/convex.config.ts",
]);
const now = Date.UTC(2026, 0, 20);
let t: ReturnType<typeof convexTest>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  shardedCounterTest.register(t);
});
afterEach(async () => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
});
const initTest = () => t;
async function start(_t: any, args: any) {
  return t.mutation(api.lib.startRequest, {
    model: "external/job",
    messages: [],
    ...args,
  });
}
const setUserLimits = (_t: any, userId: string, limits: any) =>
  t.mutation(api.lib.setBucketLimits, {
    dimension: "user",
    value: userId,
    ...limits,
  });
const userOf = async (_t: any, userId: string) =>
  (await t.query(api.lib.listBuckets, { dimension: "user" })).find(
    (b: any) => b.value === userId,
  );
async function settleWith(_t: any, requestId: any, fields: any) {
  await t.mutation(api.lib.finishRequest, { requestId, ...fields });
  await t.mutation(internal.lib.foldTotals, { requestId });
  await t.mutation(internal.lib.rollupPhase, {});
}

describe("subscription periods", () => {
  const first = { start: Date.UTC(2026, 0, 15), end: Date.UTC(2026, 1, 15) };
  const second = { start: first.end, end: Date.UTC(2026, 2, 15) };
  const history = (t: any, period = "period") =>
    t.query(api.lib.usageHistory, { dimension: "user", value: "u", period });
  const configure = async (t: any, period = first, limit = 300) => {
    await setUserLimits(t, "u", { period, periodSpendLimitNanos: limit });
    if (period.start > Date.now()) vi.setSystemTime(period.start);
  };
  const admit = (t: any, cost = 100, extra = {}) =>
    start(t, {
      userId: "u",
      estimatedCostNanos: cost,
      estimatedTokens: 10,
      ...extra,
    });

  test("renewal has no rollover; a same-period upgrade preserves spend", async () => {
    const t = initTest();
    await configure(t);
    const r = await admit(t, 200);
    await settleWith(t, r.requestId, {
      costNanos: 200,
      occurredAt: first.start,
    });
    await configure(t, first, 700);
    expect((await admit(t, 501)).allowed).toBe(false);
    const remaining = await admit(t, 500);
    expect(remaining.allowed).toBe(true);
    await configure(t, second, 300);
    expect((await admit(t, 301)).allowed).toBe(false);
    expect((await admit(t, 300)).allowed).toBe(true);
    expect((await history(t))[1].spendNanos).toBe(200);
  });

  test("late charges and both revision directions stay in the closed period", async () => {
    const t = initTest();
    await configure(t);
    const old = await admit(t);
    await configure(t, second);
    const current = await admit(t, 50);
    await settleWith(t, current.requestId, {
      costNanos: 50,
      occurredAt: second.start,
    });
    await settleWith(t, old.requestId, {
      costNanos: 200,
      occurredAt: first.end - 1,
    });
    for (const costNanos of [80, 250]) {
      await settleWith(t, old.requestId, { costNanos, revise: true });
      const rows = await history(t);
      expect(rows.map((r: any) => r.spendNanos)).toEqual([50, costNanos]);
      expect((await userOf(t, "u")).totalSpendNanos).toBe(50 + costNanos);
      expect(
        (await t.query(api.lib.getBillingEvent, { requestId: old.requestId }))
          .costNanos,
      ).toBe(costNanos);
      expect((await admit(t, 251)).allowed).toBe(false);
    }
    const days = await history(t, "day");
    expect(days.find((r: any) => r.stamp === "2026-02-14").spendNanos).toBe(
      250,
    );
    expect(days.find((r: any) => r.stamp === "2026-02-15").spendNanos).toBe(50);
  });

  test("simultaneous admissions share the period reservation cap", async () => {
    const t = initTest();
    await configure(t);
    const results = await Promise.all([admit(t, 200), admit(t, 200)]);
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.find((r) => !r.allowed).code).toBe(
      "user_period_spend_limit",
    );
  });

  test("a hold across renewal cannot release a new-period reservation", async () => {
    const t = initTest();
    await configure(t);
    const old = await admit(t, 300);
    await configure(t, second);
    expect((await admit(t, 300)).allowed).toBe(true);
    await settleWith(t, old.requestId, {
      costNanos: 50,
      occurredAt: first.start,
    });
    expect((await admit(t, 1)).allowed).toBe(false);
    expect((await history(t)).map((r: any) => r.spendNanos)).toEqual([0, 50]);
  });

  test("a crossing request defaults to its settlement period", async () => {
    vi.setSystemTime(first.start);
    const t = initTest();
    await configure(t);
    const old = await admit(t, 300);
    await configure(t, second);
    vi.setSystemTime(second.start);
    await t.mutation(api.lib.finishRequest, {
      requestId: old.requestId,
      costNanos: 100,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: old.requestId });
    expect((await history(t)).map((r: any) => r.spendNanos)).toEqual([100, 0]);
  });

  test("period token caps and half-open occurrence boundaries", async () => {
    const t = initTest();
    await configure(t);
    await setUserLimits(t, "u", { periodTokenLimit: 10 });
    const r = await admit(t);
    expect((await admit(t)).code).toBe("user_period_token_limit");
    await configure(t, second);
    await settleWith(t, r.requestId, {
      costNanos: 100,
      promptTokens: 10,
      occurredAt: first.end,
    });
    expect((await history(t)).map((r: any) => r.tokens)).toEqual([10, 0]);
    expect((await admit(t)).code).toBe("user_period_token_limit");
  });

  test("reject invalid or overlapping periods atomically", async () => {
    const t = initTest();
    await expect(configure(t, { start: 10, end: 10 })).rejects.toThrow();
    await configure(t);
    await expect(
      configure(t, { start: first.start + 1, end: second.end }),
    ).rejects.toThrow(/overlap/);
    expect(await history(t)).toHaveLength(1);
  });

  test("period adjustments grant expiring headroom without changing revisions into credits", async () => {
    const t = initTest();
    await configure(t);
    const r = await admit(t, 300);
    await settleWith(t, r.requestId, {
      costNanos: 300,
      occurredAt: first.start,
    });
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: -100,
    });
    expect((await admit(t, 100)).allowed).toBe(true);
    expect((await admit(t, 1)).allowed).toBe(false);
    await configure(t, second);
    expect((await admit(t, 301)).allowed).toBe(false);
  });

  test("S1: period reservations expire once and late finalization remains revisable", async () => {
    const t = initTest();
    await configure(t);
    const r = await admit(t, 300);
    const pending = await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    });
    expect(pending.expiresAt).toBeGreaterThan(0);
    vi.setSystemTime(pending.expiresAt + 1);
    expect((await t.mutation(internal.lib.expirePhase, {})).expired).toBe(1);
    expect((await history(t))[0]).toMatchObject({
      reservedNanos: 0,
      reservedTokens: 0,
    });
    expect(
      await t.query(api.lib.getRequest, { requestId: r.requestId }),
    ).toMatchObject({
      reservationReleased: true,
      reservationExpired: true,
      status: "error",
      settled: true,
    });
    expect((await t.mutation(internal.lib.expirePhase, {})).expired).toBe(0);
    expect((await history(t))[0].reservedNanos).toBe(0);
    await configure(t, second);
    const current = await admit(t, 300);
    expect(current.allowed).toBe(true);
    await settleWith(t, r.requestId, {
      costNanos: 100,
      occurredAt: first.start,
    });
    await settleWith(t, r.requestId, { costNanos: 40, revise: true });
    expect((await admit(t, 1)).allowed).toBe(false);
    expect((await history(t))[1]).toMatchObject({
      spendNanos: 40,
      reservedNanos: 0,
    });
  });

  test("custom tagged periods use their own anchors and soft limits", async () => {
    const t = initTest();
    await configure(t);
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "team",
      value: "a",
      period: second,
      periodSpendLimitNanos: 50,
      enforcement: "soft",
    });
    const r = await admit(t, 100, {
      tags: [{ dimension: "team", value: "a" }],
    });
    expect(r.allowed).toBe(true);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    vi.setSystemTime(second.start);
    await settleWith(t, r.requestId, {
      costNanos: 100,
      occurredAt: second.start,
    });
    expect((await history(t))[0].spendNanos).toBe(0);
    const rows = await t.query(api.lib.usageHistory, {
      dimension: "team",
      value: "a",
      period: "period",
    });
    expect(rows[0].spendNanos).toBe(100);
  });

  test("enabling a period cap adopts existing uncapped reservations", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { period: first });
    const r = await admit(t, 300);
    await configure(t);
    expect((await admit(t, 1)).code).toBe("bucket_reconciling");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await admit(t, 1)).code).toBe("user_period_spend_limit");
    await settleWith(t, r.requestId, { costNanos: 0, occurredAt: first.start });
    expect((await history(t))[0].reservedNanos).toBe(0);
    expect((await admit(t, 300)).allowed).toBe(true);
  });

  test("revisions survive request retention without touching a renewed allowance", async () => {
    const t = initTest();
    await configure(t);
    const r = await admit(t);
    await settleWith(t, r.requestId, {
      costNanos: 100,
      promptTokens: 8,
      occurredAt: first.start,
    });
    await configure(t, second);
    expect((await admit(t, 300)).allowed).toBe(true);
    await t.mutation(api.lib.setRetention, { retentionMs: 1 });
    expect((await t.mutation(internal.lib.retentionPhase, {})).purged).toBe(1);
    expect(
      await t.query(api.lib.getRequest, { requestId: r.requestId }),
    ).toBeNull();
    for (const costNanos of [40, 180, 180]) {
      await settleWith(t, r.requestId, { costNanos, revise: true });
      expect((await history(t)).map((r: any) => r.spendNanos)).toEqual([
        0,
        costNanos,
      ]);
      expect((await history(t))[1]).toMatchObject({ tokens: 8, requests: 1 });
      expect((await admit(t, 1)).allowed).toBe(false);
      expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(
        costNanos,
      );
    }
  });
  test.each([{ dailySpendLimitNanos: 10_000 }, { maxConcurrent: 5 }])(
    "B1: first period adopts an already-reserving bucket without double holds: %j",
    async (limits) => {
      await setUserLimits(t, "u", limits);
      const old = await admit(t, 300);
      await configure(t);
      expect((await admit(t, 1)).code).toBe("bucket_reconciling");
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await history(t))[0]).toMatchObject({
        reservedNanos: 300,
        reservedTokens: 10,
      });
      expect(await userOf(t, "u")).toMatchObject({
        reservedTotalNanos: 300,
        reservedTotalTokens: 10,
        pendingCount: 1,
      });
      expect((await admit(t, 1)).allowed).toBe(false);
      // Reapplying the same range must not reserve either hold a second time.
      await configure(t);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await history(t))[0].reservedNanos).toBe(300);
      await settleWith(t, old.requestId, { costNanos: 300 });
      expect((await history(t))[0]).toMatchObject({
        reservedNanos: 0,
        spendNanos: 300,
      });
      expect(await userOf(t, "u")).toMatchObject({
        reservedTotalNanos: 0,
        pendingCount: 0,
      });
      expect((await admit(t, 1)).allowed).toBe(false);
    },
  );

  test.each(["before", "end", "after"])(
    "B2: hard period caps fail closed %s the selected range",
    async (position) => {
      await configure(t);
      const admitted = await admit(t, 100);
      if (position === "before") {
        // Select a future range without moving the monotonic transaction clock backward.
        await setUserLimits(t, "u", { period: second });
      } else {
        vi.setSystemTime(first.end + (position === "after" ? 1 : 0));
      }
      for (let i = 0; i < 2; i++) {
        const blocked = await admit(t, 100, { occurredAt: first.start - 1 });
        expect(blocked).toMatchObject({
          allowed: false,
          code: "user_period_inactive",
        });
      }
      // A stale range blocks new work, but still accepts an existing provider charge.
      await settleWith(t, admitted.requestId, {
        costNanos: 100,
        occurredAt: first.start - 1,
      });
      expect((await history(t))[0].reservedNanos).toBe(0);
      await configure(t, second);
      expect((await admit(t, 300)).allowed).toBe(true);
    },
  );

  test("B2: token-only hard caps fail closed, soft caps warn outside the range", async () => {
    await setUserLimits(t, "u", { period: first, periodTokenLimit: 100 });
    vi.setSystemTime(first.end);
    expect((await admit(t)).code).toBe("user_period_inactive");
    await setUserLimits(t, "u", { enforcement: "soft" });
    const r = await admit(t);
    expect(r.allowed).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/selected period/);
    await settleWith(t, r.requestId, { costNanos: 100 });
    expect((await history(t))[0].spendNanos).toBe(0);
  });
});
