import { expectTypeOf, test } from "vitest";
import type { AIBudget } from "./index";

type SettlementArgs = Parameters<AIBudget["settle"]>[1];

test("N1: revision requires cost and excludes completion fields", () => {
  expectTypeOf<{
    requestId: string;
    revise: true;
    costNanos: number;
  }>().toExtend<SettlementArgs>();
  expectTypeOf<{
    requestId: string;
    usage: unknown;
  }>().toExtend<SettlementArgs>();
  expectTypeOf<{
    requestId: string;
    revise: true;
  }>().not.toExtend<SettlementArgs>();
  expectTypeOf<{
    requestId: string;
    revise: true;
    costNanos: number;
    usage: unknown;
  }>().not.toExtend<SettlementArgs>();
  expectTypeOf<{
    requestId: string;
    revise: true;
    costNanos: number;
    responseText: string;
  }>().not.toExtend<SettlementArgs>();
});
