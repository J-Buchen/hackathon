import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, evaluateHoldout, expandGrid, makeSplit, paramKey, study, walkForward } from "./research";
import { BUY_AND_HOLD, DEFAULT_PARAMS } from "./strategy";
import { forwardMonteCarlo } from "./montecarlo";
import { defaultScenarios, kellySize, valueScenarios } from "./valuation";
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
  const k = kellySize(0.3, 0.6, 0.04, 1);
  assert.ok(Math.abs(k.fullKelly - 0.26 / 0.36) < 1e-12);
  assert.equal(k.recommended, k.halfKelly);
});
