import { test } from "node:test";
import assert from "node:assert/strict";
import { gaussian, mulberry32 } from "@allowance/swarm";
import {
  deflatedSharpe,
  expectedMaxSharpe,
  moments,
  normCdf,
  normInv,
  performance,
  probabilisticSharpe,
  probabilityOfOverfitting,
  sharpeDifferenceCI,
} from "./metrics";

const noise = (seed: number, n: number, mu = 0, sd = 0.01) => {
  const z = gaussian(mulberry32(seed));
  return Array.from({ length: n }, () => mu + sd * z());
};

test("normal CDF and its inverse agree", () => {
  for (const p of [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
});

test("moments: normal-ish sample has skew≈0, kurtosis≈3", () => {
  const m = moments(noise(1, 200000));
  assert.ok(Math.abs(m.skew) < 0.05 && Math.abs(m.kurt - 3) < 0.1);
});

test("performance: drawdown, CAGR and excess-return Sharpe", () => {
  const p = performance([0.1, -0.5, 0.2]);
  assert.ok(Math.abs(p.maxDrawdown - 0.5) < 1e-12);
  const rf = Array(500).fill(0.0002);
  const r = noise(2, 500, 0.0002, 0.01);
  const ex = performance(r.map((x, i) => x - rf[i]));
  assert.ok(Math.abs(performance(r, rf).sharpe - ex.sharpe) < 1e-12, "Sharpe is on excess returns");
  assert.equal(performance(r, rf).totalReturn, performance(r).totalReturn, "returns are not reduced by rf");
});

test("expected max Sharpe of N unskilled trials matches the closed form", () => {
  // Bailey & López de Prado: for V = 1, N = 1000 the expected maximum is ≈ 3.26.
  assert.ok(Math.abs(expectedMaxSharpe(1000, 1) - 3.26) < 0.02);
  assert.equal(expectedMaxSharpe(1, 1), 0);
});

test("PSR rises with a real edge; DSR falls as more variants are tried", () => {
  const edge = noise(3, 1000, 0.001, 0.01);
  assert.ok(probabilisticSharpe(edge) > 0.95);
  assert.ok(probabilisticSharpe(noise(4, 1000)) < 0.95);
  const trialsFew = Array.from({ length: 10 }, (_, k) => 0.02 * (k / 10));
  const trialsMany = Array.from({ length: 5000 }, (_, k) => 0.06 * Math.sin(k));
  assert.ok(deflatedSharpe(edge, trialsMany).dsr < deflatedSharpe(edge, trialsFew).dsr);
});

test("PBO: pure noise overfits about half the time; a real edge does not", () => {
  const trials = Array.from({ length: 40 }, (_, k) => noise(100 + k, 1600));
  const pNoise = probabilityOfOverfitting(trials, 12).pbo;
  assert.ok(pNoise > 0.3 && pNoise < 0.8, `noise PBO ${pNoise}`);
  const withEdge = [...trials.slice(1), noise(999, 1600, 0.002, 0.01)];
  assert.ok(probabilityOfOverfitting(withEdge, 12).pbo < 0.1);
});

test("paired bootstrap CI brackets the Sharpe difference and sees a real improvement", () => {
  const bench = noise(5, 1500, 0.0003, 0.02);
  const better = bench.map((x) => x * 0.5 + 0.0004);
  const ci = sharpeDifferenceCI(better, bench, { samples: 400 });
  assert.ok(ci.lo <= ci.diff && ci.diff <= ci.hi);
  assert.ok(ci.pPositive > 0.9);
});

test("REVIEW FIX: days in cash are not counted as winning days", () => {
  const rf = Array(10).fill(0.0002);
  const ret = [0.0002, 0.0002, 0.0002, 0.01, -0.01, 0.0002, 0.0002, 0.0002, 0.0002, 0.0002];
  assert.equal(performance(ret, rf).hitRate, 0.5);
});

test("REVIEW FIX: studentized CI covers a zero true difference about as often as it claims", () => {
  let covered = 0;
  const trials = 60;
  for (let k = 0; k < trials; k++) {
    const a = noise(500 + k, 252, 0.0004, 0.02);
    const b = noise(900 + k, 252, 0.0004, 0.02);
    const ci = sharpeDifferenceCI(a, b, { samples: 300, seed: k });
    if (ci.lo <= 0 && 0 <= ci.hi) covered++;
  }
  assert.ok(covered / trials >= 0.8, `coverage ${covered}/${trials} for a nominal 90% interval`);
});
