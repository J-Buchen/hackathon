import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, evaluateHoldout, expandGrid, makeSplit, paramKey, study, walkForward } from "./research";
import { BUY_AND_HOLD, DEFAULT_PARAMS, runTiger, type TigerParams } from "./strategy";
import { forwardMonteCarlo } from "./montecarlo";
import { defaultScenarios, kellySize, scenarioKelly, valueScenarios } from "./valuation";
import { quarterlyEvents, syntheticPanel } from "./testkit";

const SMALL = {
  volTarget: [null, 0.4],
  trendLookback: [null, 100],
  trendFloor: [0, 0.5],
  preEventDays: [0, 5],
  preEventMult: [0, 1.5],
  hedgeSymbol: [null, "HG"],
  hedgeRatio: [0, 1],
};

test("the grid collapses settings that cannot matter, so every trial is distinct", () => {
  const grid = expandGrid(DEFAULT_PARAMS, SMALL);
  // vol 2 × trend (1 + 2) × event (1 + 2) × hedge (1 + 1) = 36
  assert.equal(grid.length, 36);
  assert.equal(new Set(grid.map(paramKey)).size, grid.length);
  assert.equal(canonical({ ...DEFAULT_PARAMS, trendLookback: null, trendFloor: 0 }).trendFloor, 1);
});

test("walk-forward never trains on its test window, and tests tile the development period", () => {
  const p = syntheticPanel({ days: 1200, seed: 21 });
  const dev = { from: 150, to: 1100 };
  const wf = walkForward(p, quarterlyEvents(1200), expandGrid(DEFAULT_PARAMS, SMALL), dev, { minTrain: 300, testLen: 100 });
  let expectFrom = dev.from + 300;
  for (const s of wf.steps) {
    assert.ok(s.train.to < s.test.from);
    assert.equal(s.train.from, dev.from);
    assert.equal(s.test.from, expectFrom);
    assert.ok(s.test.to <= dev.to);
    expectFrom = s.test.to + 1;
  }
  assert.equal(expectFrom, dev.to + 1);
  assert.equal(wf.oos.ret.length, dev.to - dev.from - 300 + 1);
});

test("on a market with no edge, the study does not certify the winner", () => {
  const p = syntheticPanel({ days: 1300, seed: 22 });
  const split = makeSplit(p, { holdoutDays: 252, warmupDays: 150 });
  assert.ok(split.holdout && split.holdout.from === 1300 - 252);
  const s = study(p, quarterlyEvents(1300), expandGrid(DEFAULT_PARAMS, SMALL), split.dev, { minTrain: 300, testLen: 126, pboBlocks: 12 });
  assert.equal(s.trials, 36);
  assert.ok(s.deflated.dsr < 0.95, `DSR ${s.deflated.dsr} on noise`);
  const h = evaluateHoldout(p, quarterlyEvents(1300), s.best.params, split.holdout!);
  assert.equal(h.perf.days, 252);
});

test("forward Monte Carlo: zero drift removes the historical trend; drift is explicit", () => {
  const p = syntheticPanel({ days: 900, seed: 23, drift: 0.003 });
  const cfg = { horizon: 126, paths: 300, meanBlock: 10, forwardEvents: [30, 93], seed: 1, warmup: 200 };
  const hist = forwardMonteCarlo(p, [], { bh: BUY_AND_HOLD }, { ...cfg, drift: "historical" }).bh!;
  const zero = forwardMonteCarlo(p, [], { bh: BUY_AND_HOLD }, { ...cfg, drift: "zero" }).bh!;
  const up = forwardMonteCarlo(p, [], { bh: BUY_AND_HOLD }, { ...cfg, drift: { annual: 0.3 } }).bh!;
  assert.ok(hist.totalReturn.p50 > 0.2, "historical drift is kept");
  assert.ok(Math.abs(zero.totalReturn.p50) < 0.12, `zero drift median ${zero.totalReturn.p50}`);
  assert.ok(up.totalReturn.mean > zero.totalReturn.mean);
});

test("valuation: scenario math, loss probability and half-Kelly", () => {
  const v = valueScenarios({ marketCapUsdMm: 10000, usdCny: 7.1, scenarios: defaultScenarios() });
  const street = v.scenarios.find((s) => s.name === "street")!;
  assert.ok(Math.abs(street.impliedCapUsdMm - (6046 * 15) / 7.1) < 1e-6);
  assert.ok(Math.abs(v.expectedReturn - v.scenarios.reduce((a, s) => a + s.prob * s.return, 0)) < 1e-12);
  assert.throws(() => valueScenarios({ marketCapUsdMm: 1, usdCny: 7, scenarios: [{ ...defaultScenarios()[0]!, prob: 0.5 }] }));
  // Continuous Kelly from a 1-year SIMPLE return: (ln 1.3 − ln 1.04) / 0.36.
  const k = kellySize(0.3, 0.6, 0.04, 1);
  assert.ok(Math.abs(k.fullKelly - (Math.log(1.3) - Math.log(1.04)) / 0.36) < 1e-12);
  assert.equal(k.recommended, k.halfKelly);
  // Discrete scenario-tree Kelly: a sure +10% vs rf 4% → go to the cap; a coin flip ±50% at rf → 0.
  const sure = scenarioKelly({ scenarios: [{ name: "x", prob: 1, netProfitRmbMm: 0, multiple: 0, note: "", impliedCapUsdMm: 0, return: 0.1 }], expectedReturn: 0.1, downside: 0, probLoss: 0 }, 0.04, 1);
  assert.equal(sure.full, 1);
  const flip = scenarioKelly({ scenarios: [
    { name: "u", prob: 0.5, netProfitRmbMm: 0, multiple: 0, note: "", impliedCapUsdMm: 0, return: 0.5 },
    { name: "d", prob: 0.5, netProfitRmbMm: 0, multiple: 0, note: "", impliedCapUsdMm: 0, return: -0.5 },
  ], expectedReturn: 0, downside: -0.25, probLoss: 0.5 }, 0, 1);
  assert.equal(flip.full, 0);
});

test("REVIEW FIX: walk-forward is one continuous book — a stop-out is not undone at a window boundary", () => {
  // Crash just before the day-526 boundary; the book must stay flat until it re-underwrites.
  const shocks: Record<number, number> = {};
  for (let t = 518; t <= 522; t++) shocks[t] = -0.07;
  for (let t = 526; t <= 545; t++) shocks[t] = -0.02;
  const p = syntheticPanel({ days: 1000, seed: 3, drift: 0.001, vol: 0.02, shocks });
  const params: TigerParams = { ...BUY_AND_HOLD, ddStop: 0.2, reentryDays: 40, trendLookback: 50, trendFloor: 1 };
  const wf = walkForward(p, [], [params], { from: 100, to: 999 }, { minTrain: 300, testLen: 126 });
  const continuous = runTiger(p, [], params, { from: 400, to: 999 });
  assert.deepEqual(wf.oos.wLong, continuous.wLong, "stitched weights equal one continuous run");
  assert.deepEqual(wf.oos.ret, continuous.ret);
  assert.equal(wf.oos.events.filter((e) => e.kind === "STOP_OUT").length, continuous.events.filter((e) => e.kind === "STOP_OUT").length);
  // Benchmark pays ONE entry cost, not one per window, and turnover counts it.
  const benchCont = runTiger(p, [], BUY_AND_HOLD, { from: 400, to: 999 });
  assert.ok(Math.abs(wf.bench.costs - benchCont.costs) < 1e-12);
  assert.ok(wf.bench.turnover > 0);
});

test("REVIEW FIX: no earnings calendar → catalyst variants are not counted as trials", () => {
  const withEvents = expandGrid(DEFAULT_PARAMS, SMALL, { hasEvents: true });
  const without = expandGrid(DEFAULT_PARAMS, SMALL, { hasEvents: false });
  assert.equal(without.length * 3, withEvents.length);
});

test("REVIEW FIX: forward MC 'zero' drift earns rf; thesis drift compounds to the 1-year simple target", () => {
  const p = syntheticPanel({ days: 900, seed: 24, drift: 0.003, rfAnnual: 0.05 });
  const cfg = { horizon: 252, paths: 600, meanBlock: 10, forwardEvents: [], seed: 2, warmup: 200 };
  const zero = forwardMonteCarlo(p, [], { bh: BUY_AND_HOLD }, { ...cfg, drift: "zero" }).bh!;
  const thesis = forwardMonteCarlo(p, [], { bh: BUY_AND_HOLD }, { ...cfg, drift: { annual: 0.3 } }).bh!;
  assert.ok(Math.abs(zero.totalReturn.mean - 0.05) < 0.05, `zero-drift mean ${zero.totalReturn.mean} ≈ rf`);
  assert.ok(Math.abs(thesis.totalReturn.mean - 0.3) < 0.08, `thesis mean ${thesis.totalReturn.mean} ≈ 0.30, not e^0.3−1`);
});
