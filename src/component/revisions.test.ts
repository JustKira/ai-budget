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
const now = Date.UTC(2026, 0, 31, 23, 59, 59);
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
const admit = (extra = {}) =>
  t.mutation(api.lib.startRequest, {
    userId: "u",
    model: "external/job",
    messages: [],
    estimatedCostNanos: 100,
    estimatedTokens: 0,
    ...extra,
  });
async function settleWith(_t: any, requestId: any, extra = {}) {
  await t.mutation(api.lib.finishRequest, { requestId, ...extra });
  await t.mutation(internal.lib.foldTotals, { requestId });
  await t.mutation(internal.lib.rollupPhase, {});
}
const history = (_t: any, period = "day") =>
  t.query(api.lib.usageHistory, {
    dimension: "user",
    value: "u",
    period: period as "day" | "month",
  });
const userOf = async (_t: any, userId: string) =>
  (await t.query(api.lib.listBuckets, { dimension: "user" })).find(
    (b: any) => b.value === userId,
  );
const initTest = () => t;
const first = { start: Date.UTC(2026, 0, 15) };
const second = { start: Date.UTC(2026, 1, 15) };

test("identical concurrent revisions are idempotent, including before folding", async () => {
  const t = initTest();
  const r = await admit();
  await t.mutation(api.lib.finishRequest, {
    requestId: r.requestId,
    costNanos: 100,
  });
  await Promise.all(
    [60, 60].map((costNanos) =>
      t.mutation(api.lib.finishRequest, {
        requestId: r.requestId,
        costNanos,
        revise: true,
      } as any),
    ),
  );
  await settleWith(t, r.requestId, { costNanos: 60, revise: true });
  const u = await userOf(t, "u");
  expect(u.totalSpendNanos).toBe(60);
  expect(u.totalRequests).toBe(1);
  expect((await history(t, "day"))[0].requests).toBe(1);
  const events = await t.run((ctx: any) =>
    ctx.db.query("billingEvents").collect(),
  );
  expect(events).toHaveLength(1);
});

test("revision preserves tokens, content and the original occurrence time", async () => {
  const t = initTest();
  const r = await admit();
  await settleWith(t, r.requestId, {
    costNanos: 100,
    promptTokens: 7,
    responseText: "answer",
    occurredAt: first.start,
  });
  await settleWith(t, r.requestId, { costNanos: 60, revise: true });
  const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
  expect(req.promptTokens).toBe(7);
  expect(req.responseText).toBe("answer");
  expect(req.occurredAt).toBe(first.start);
  expect((await history(t))[0]).toMatchObject({
    spendNanos: 60,
    tokens: 7,
    requests: 1,
  });
  await expect(
    settleWith(t, r.requestId, {
      costNanos: 50,
      revise: true,
      occurredAt: second.start,
    }),
  ).rejects.toThrow(/attribution/);
});

test("occurrence time also controls uncapped calendar rollups and global totals", async () => {
  const t = initTest();
  const r = await admit({ occurredAt: first.start });
  await settleWith(t, r.requestId, { costNanos: 100 });
  await settleWith(t, r.requestId, { costNanos: 40, revise: true });
  expect((await history(t, "month"))[0]).toMatchObject({
    stamp: "2026-01",
    spendNanos: 40,
    requests: 1,
  });
  expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(40);
  expect((await userOf(t, "u")).totalSpendNanos).toBe(40);
});

test("revisions remain correct while uncapped rollup deltas are queued", async () => {
  const t = initTest();
  const r = await admit();
  for (const [index, costNanos] of [100, 40, 180, 0].entries()) {
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos,
      revise: index > 0,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: r.requestId });
  }
  await t.mutation(internal.lib.rollupPhase, {});
  expect(await userOf(t, "u")).toMatchObject({
    totalSpendNanos: 0,
    totalRequests: 1,
    totalTokens: 0,
  });
  expect((await history(t, "day"))[0]).toMatchObject({
    spendNanos: 0,
    requests: 1,
  });
});

test("an unkeyed duplicate cannot revise and invalid revisions fail explicitly", async () => {
  const t = initTest();
  const r = await admit();
  await expect(
    settleWith(t, r.requestId, { costNanos: 50, revise: true }),
  ).rejects.toThrow(/settled/);
  await settleWith(t, r.requestId, { costNanos: 100 });
  await settleWith(t, r.requestId, { costNanos: 20 });
  expect((await userOf(t, "u")).totalSpendNanos).toBe(100);
  for (const costNanos of [-1, NaN, Infinity, 0.5])
    await expect(
      settleWith(t, r.requestId, { costNanos, revise: true }),
    ).rejects.toThrow(/costNanos/);
  await expect(settleWith(t, r.requestId, { revise: true })).rejects.toThrow(
    /costNanos/,
  );
  await t.run(async (ctx: any) => ctx.db.delete("requests", r.requestId));
  await settleWith(t, r.requestId, { costNanos: 50, revise: true });
  expect((await userOf(t, "u")).totalSpendNanos).toBe(50);
});

describe.each([false, true])(
  "real retention with calendar caps=%s",
  (capped) => {
    test("signed revisions survive retention across user action and tags", async () => {
      const buckets = [
        ["user", "u"],
        ["action", "job"],
        ["team", "a"],
      ];
      if (capped)
        for (const [dimension, value] of buckets)
          await t.mutation(api.lib.setBucketLimits, {
            dimension,
            value,
            dailySpendLimitNanos: 1000,
          });
      const r = await admit({
        actionName: "job",
        tags: [{ dimension: "team", value: "a" }],
      });
      await settleWith(t, r.requestId, { costNanos: 300, promptTokens: 8 });
      await t.mutation(api.lib.setRetention, { retentionMs: 1 });
      vi.setSystemTime(now + 100);
      await t.mutation(api.lib.finishRequest, {
        requestId: r.requestId,
        revise: true,
        costNanos: 40,
      });
      expect((await t.mutation(internal.lib.retentionPhase, {})).purged).toBe(
        0,
      );
      await t.mutation(internal.lib.foldTotals, { requestId: r.requestId });
      expect((await t.mutation(internal.lib.retentionPhase, {})).purged).toBe(
        1,
      );
      expect(
        await t.query(api.lib.getRequest, { requestId: r.requestId }),
      ).toBeNull();
      for (const costNanos of [80, 20, 20]) {
        await Promise.all(
          [0, 1].map(() =>
            t.mutation(api.lib.finishRequest, {
              requestId: r.requestId,
              revise: true,
              costNanos,
            }),
          ),
        );
        await t.mutation(internal.lib.rollupPhase, {});
        for (const [dimension, value] of buckets)
          for (const period of ["day", "month"] as const) {
            expect(
              (
                await t.query(api.lib.usageHistory, {
                  dimension,
                  value,
                  period,
                })
              )[0],
            ).toMatchObject({ spendNanos: costNanos, tokens: 8, requests: 1 });
          }
        expect(await t.query(api.lib.getGlobalStatus, {})).toMatchObject({
          spentTotalNanos: costNanos,
          spentTodayNanos: costNanos,
        });
      }
    });
  },
);
