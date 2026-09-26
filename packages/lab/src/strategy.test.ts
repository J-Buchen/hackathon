import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUY_AND_HOLD,
  DEFAULT_PARAMS,
  RECOMMENDED_TIGER,
  betaSeries,
  crowdingSeries,
  runTiger,
  shrunkBetaSeries,
  type TigerParams,
} from "./strategy";
import { quarterlyEvents, syntheticPanel } from "./testkit";
import type { Panel } from "./series";

const EVERYTHING: TigerParams = {
  ...DEFAULT_PARAMS,
  volTarget: 0.4,
  volLookback: 20,
  trendLookback: 50,
  trendFloor: 0.5,
  preEventDays: 5,
  preEventMult: 0.5,
  postEventDays: 3,
  postEventMult: 1.2,
  ddCut: 0.1,
  ddStop: 0.2,
  reentryDays: 10,
  hedgeSymbol: "HG",
  hedgeRatio: 1,
  betaLookback: 60,
  crowdLookback: 30,
  crowdZ: 1,
  crowdFactor: 0.5,
};

/** Same history up to day k, a different world after it. */
function forkAt(p: Panel, k: number, seed: number): Panel {
  const alt = syntheticPanel({ days: p.dates.length, seed });
  const ret: Record<string, number[]> = {};
  const px: Record<string, number[]> = {};
  for (const s of p.symbols) {
    ret[s] = p.ret[s]!.map((r, i) => (i <= k ? r : alt.ret[s === "LK" ? "LK" : "HG"]![i]!));
    px[s] = [p.px[s]![0]!];
    for (let i = 1; i < ret[s]!.length; i++) px[s]!.push(px[s]![i - 1]! * (1 + ret[s]![i]!));
  }
  return { ...p, ret, px };
}

test("NO LOOK-AHEAD: changing the future never changes a past decision", () => {
  const base = syntheticPanel({ days: 900, seed: 11 });
  const events = quarterlyEvents(900);
  for (const k of [300, 450, 610]) {
    const fork = forkAt(base, k, 77 + k);
    const a = runTiger(base, events, EVERYTHING, { from: 100, to: 899 });
    const b = runTiger(fork, events, EVERYTHING, { from: 100, to: 899 });
    // Decisions made at closes ≤ k are the weights held into return days ≤ k+1.
    const lastSame = k + 1 - 100;
    for (let i = 0; i <= lastSame; i++) {
      assert.equal(a.wLong[i], b.wLong[i], `long weight moved at return day ${i + 100} after forking at ${k}`);
      assert.equal(a.wHedge[i], b.wHedge[i], `hedge weight moved at return day ${i + 100}`);
    }
    assert.notDeepEqual(a.ret.slice(lastSame + 1), b.ret.slice(lastSame + 1), "the fork does change the future");
    assert.ok(a.events.some((e) => e.kind === "CROWDED" && e.t <= k), "the crowding gate is exercised before the fork");
  }
});

test("buy-and-hold earns the asset's return, net of one entry cost (plus tiny drift rebalancing)", () => {
  const p = syntheticPanel({ days: 300, seed: 3 });
  const r = runTiger(p, [], BUY_AND_HOLD, { from: 1, to: 299 });
  assert.ok(Math.abs(r.ret[0]! - (p.ret.LK![1]! - 20 / 1e4)) < 1e-12);
  // After the entry fee the weight drifts a hair above 1; holding 1 costs a few µ-bps.
  for (let i = 1; i < r.ret.length; i++) assert.ok(Math.abs(r.ret[i]! - p.ret.LK![i + 1]!) < 1e-5);
  assert.equal(r.exposure, 1);
});

test("REVIEW FIX: short-hedge proceeds earn the risk-free rate (borrow is the fee over it)", () => {
  const p = syntheticPanel({ days: 300, seed: 12, rfAnnual: 0.05 });
  const params = { ...BUY_AND_HOLD, hedgeSymbol: "HG", hedgeRatio: 1, betaLookback: 60, costBps: 0, hedgeCostBps: 0, borrowRate: 0 };
  const r = runTiger(p, [], params, { from: 100, to: 299 });
  const i = 150 - 100;
  const wL = r.wLong[i]!;
  const wH = r.wHedge[i]!;
  const rf = 0.05 / 252;
  const expected = wL * p.ret.LK![150]! + wH * p.ret.HG![150]! + Math.max(0, 1 - wL) * rf + Math.abs(wH) * rf; // result i ↔ return day from + i
  assert.ok(wH < 0);
  assert.ok(Math.abs(r.ret[i]! - expected) < 1e-9);
});

test("REVIEW FIX: a fractional book pays for rebalancing its drifted weight", () => {
  const p = syntheticPanel({ days: 300, seed: 13 });
  const half = runTiger(p, [], { ...BUY_AND_HOLD, baseWeight: 0.5 }, { from: 1, to: 299 });
  assert.ok(half.costs > (0.5 * 20) / 1e4 + 1e-6, "more than the single entry trade");
  assert.ok(half.traded > 0.5);
});

test("REVIEW FIX: state threads between runs — two halves equal one run", () => {
  const p = syntheticPanel({ days: 600, seed: 14 });
  const params = { ...EVERYTHING };
  const whole = runTiger(p, quarterlyEvents(600), params, { from: 100, to: 599 });
  const first = runTiger(p, quarterlyEvents(600), params, { from: 100, to: 349 });
  const second = runTiger(p, quarterlyEvents(600), params, { from: 350, to: 599 }, first.state);
  assert.deepEqual([...first.wLong, ...second.wLong], whole.wLong);
  assert.deepEqual([...first.ret, ...second.ret], whole.ret);
});

test("cash earns the risk-free rate", () => {
  const p = syntheticPanel({ days: 300, seed: 4, rfAnnual: 0.05 });
  const r = runTiger(p, [], { ...BUY_AND_HOLD, baseWeight: 0.5, costBps: 0 }, { from: 1, to: 299 });
  assert.ok(Math.abs(r.ret[10]! - (0.5 * p.ret.LK![11]! + 0.5 * (0.05 / 252))) < 1e-12);
});

test("the drawdown ladder stops out after a crash and re-underwrites only after the cooldown and trend", () => {
  const shocks: Record<number, number> = {};
  for (let t = 200; t < 206; t++) shocks[t] = -0.08;
  const p = syntheticPanel({ days: 500, seed: 5, drift: 0.002, shocks });
  const params: TigerParams = { ...BUY_AND_HOLD, ddStop: 0.25, reentryDays: 15, trendLookback: 20, trendFloor: 1 };
  const r = runTiger(p, [], params, { from: 50, to: 499 });
  const stop = r.events.find((e) => e.kind === "STOP_OUT");
  const back = r.events.find((e) => e.kind === "REUNDERWRITE");
  assert.ok(stop, "stopped out");
  assert.ok(back && back.t - stop!.t >= 15, "re-entered only after the cooldown");
  for (let t = stop!.t + 1; t <= back!.t; t++) assert.equal(r.wLong[t - 50], 0, `flat while stopped (day ${t})`);
});

test("catalyst timing: preEventMult 0 steps aside into every print", () => {
  const p = syntheticPanel({ days: 400, seed: 6 });
  const events = quarterlyEvents(400);
  const r = runTiger(p, events, { ...BUY_AND_HOLD, preEventDays: 3, preEventMult: 0, announceLead: 10 }, { from: 1, to: 399 });
  for (const e of events) {
    if (e.t - 1 < 1) continue;
    assert.equal(r.wLong[e.t - 1], 0, `held into the print on day ${e.t}`);
  }
});

test("prints are only acted on once announced", () => {
  const p = syntheticPanel({ days: 200, seed: 7 });
  const events = [{ t: 150, date: "x", label: "print" }];
  const r = runTiger(p, events, { ...BUY_AND_HOLD, preEventDays: 30, preEventMult: 0, announceLead: 10 }, { from: 1, to: 199 });
  assert.equal(r.wLong[150 - 11 - 1], 1, "11 days out: not yet public");
  assert.equal(r.wLong[150 - 10 - 1 + 1], 0, "10 days out: public, step aside");
});

test("the hedge's trailing beta recovers the true beta", () => {
  const p = syntheticPanel({ days: 2000, seed: 8, beta: 1.5, vol: 0.01 });
  const b = betaSeries(p.ret.LK!, p.ret.HG!, 500);
  assert.ok(Math.abs(b[1999]! - 1.5) < 0.1, `beta ${b[1999]}`);
});

test("gross is capped and costs scale with turnover", () => {
  const p = syntheticPanel({ days: 400, seed: 9 });
  const r = runTiger(p, quarterlyEvents(400), { ...EVERYTHING, volTarget: 5, maxGross: 1.2 }, { from: 100, to: 399 });
  r.wLong.forEach((w, i) => assert.ok(w + Math.abs(r.wHedge[i]!) <= 1.2 + 1e-12));
  const cheap = runTiger(p, quarterlyEvents(400), { ...EVERYTHING, costBps: 0, hedgeCostBps: 0, borrowRate: 0, financingRate: 0 }, { from: 100, to: 399 });
  const dear = runTiger(p, quarterlyEvents(400), EVERYTHING, { from: 100, to: 399 });
  assert.ok(dear.costs > cheap.costs && cheap.costs === 0);
});

/* ------------------------------------------------------------------ */
/* Shrunk-beta hedge (loop 4)                                         */
/* ------------------------------------------------------------------ */

/** OLS beta of a run's excess returns on the hedge's returns over the same days. */
function bookBeta(r: ReturnType<typeof runTiger>, p: Panel, from: number): number {
  const y = r.ret.map((x, i) => x - r.rf[i]!);
  const x = p.ret.HG!.slice(from, from + y.length);
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  let c = 0;
  let v = 0;
  for (let i = 0; i < y.length; i++) {
    c += (x[i]! - mx) * (y[i]! - my);
    v += (x[i]! - mx) ** 2;
  }
  return c / v;
}

test("shrunk beta is OLS pulled toward the prior by its own standard error (Vasicek)", () => {
  const p = syntheticPanel({ days: 400, seed: 31, beta: 1.3, vol: 0.03 });
  const y = p.ret.LK!;
  const x = p.ret.HG!;
  const L = 120;
  const ols = betaSeries(y, x, L);
  // A diffuse prior is OLS; a dogmatic one is the prior.
  const diffuse = shrunkBetaSeries(y, x, L, 0.5, 1e6);
  const dogmatic = shrunkBetaSeries(y, x, L, 0.5, 1e-9);
  for (const t of [20, 60, 200, 399]) {
    assert.ok(Math.abs(diffuse[t]! - ols[t]!) < 1e-9, `diffuse prior at ${t}`);
    assert.ok(Math.abs(dogmatic[t]! - 0.5) < 1e-9, `dogmatic prior at ${t}`);
  }
  assert.ok(Number.isNaN(shrunkBetaSeries(y, x, L, 0.5, 0.5)[18]!), "no estimate below 20 observations");
  // The formula, recomputed independently at one close.
  const t = 250;
  const a = t - L + 1;
  const xs = x.slice(a, t + 1);
  const ys = y.slice(a, t + 1);
  const mx = xs.reduce((u, v) => u + v, 0) / L;
  const my = ys.reduce((u, v) => u + v, 0) / L;
  const sxx = xs.reduce((u, v) => u + (v - mx) ** 2, 0);
  const b = xs.reduce((u, v, i) => u + (v - mx) * (ys[i]! - my), 0) / sxx;
  const se2 = ys.reduce((u, v, i) => u + (v - my - b * (xs[i]! - mx)) ** 2, 0) / (L - 2) / sxx;
  const k = 0.25 / (0.25 + se2);
  assert.ok(Math.abs(shrunkBetaSeries(y, x, L, 0.5, 0.5)[t]! - (k * b + (1 - k) * 0.5)) < 1e-12);
  assert.ok(k > 0 && k < 1);
});

test("shrunk beta trusts a long, precise record more than a short, noisy one", () => {
  const p = syntheticPanel({ days: 1200, seed: 32, beta: 1.4, vol: 0.04 });
  const s = shrunkBetaSeries(p.ret.LK!, p.ret.HG!, 1000, 0.5, 0.5);
  const b = betaSeries(p.ret.LK!, p.ret.HG!, 1000);
  const weight = (t: number) => (s[t]! - 0.5) / (b[t]! - 0.5);
  assert.ok(weight(25) < weight(1100), `k(25 obs) ${weight(25)} < k(1100 obs) ${weight(1100)}`);
  assert.ok(weight(1100) > 0.97, "a long record is nearly OLS");
  assert.ok(Math.abs(s[1199]! - 1.4) < 0.1, `recovers the true beta: ${s[1199]}`);
});

test("NO LOOK-AHEAD: the shrunk-beta hedge never moves on future returns", () => {
  const base = syntheticPanel({ days: 900, seed: 33 });
  const events = quarterlyEvents(900);
  const params: TigerParams = { ...EVERYTHING, hedgeBeta: { prior: 0.5, priorSd: 0.5, max: 1.5 } };
  for (const k of [300, 610]) {
    const fork = forkAt(base, k, 91 + k);
    const a = runTiger(base, events, params, { from: 100, to: 899 });
    const b = runTiger(fork, events, params, { from: 100, to: 899 });
    const lastSame = k + 1 - 100;
    for (let i = 0; i <= lastSame; i++) {
      assert.equal(a.wHedge[i], b.wHedge[i], `hedge weight moved at return day ${i + 100} after forking at ${k}`);
      assert.equal(a.wLong[i], b.wLong[i]);
    }
    const sa = shrunkBetaSeries(base.ret.LK!, base.ret.HG!, 60, 0.5, 0.5);
    const sb = shrunkBetaSeries(fork.ret.LK!, fork.ret.HG!, 60, 0.5, 0.5);
    for (let t = 0; t <= k; t++) assert.ok(Object.is(sa[t], sb[t]), `shrunk beta at close ${t}`);
  }
});

test("the shrunk-beta hedge is sized at −clip(β, 0, max) × long", () => {
  const hb = { prior: 0.5, priorSd: 0.5, max: 1.5 };
  const params: TigerParams = { ...BUY_AND_HOLD, maxGross: 10, hedgeSymbol: "HG", hedgeRatio: 1, betaLookback: 60, hedgeBeta: hb };
  const cases = [
    { beta: 1.0, seed: 34 },
    { beta: 3.0, seed: 35 }, // above the ceiling
    { beta: -1.0, seed: 36 }, // negative: the hedge never goes long
  ];
  let clippedHigh = 0;
  let clippedLow = 0;
  for (const c of cases) {
    const p = syntheticPanel({ days: 300, seed: c.seed, beta: c.beta, vol: 0.02 });
    const s = shrunkBetaSeries(p.ret.LK!, p.ret.HG!, 60, hb.prior, hb.priorSd);
    const r = runTiger(p, [], params, { from: 100, to: 299 });
    r.wHedge.forEach((wH, i) => {
      const t = 100 + i - 1; // decided at the close before the return day
      const expect = -Math.min(1.5, Math.max(0, s[t]!)) * r.wLong[i]!;
      assert.ok(Math.abs(wH - expect) < 1e-12, `beta ${c.beta}, day ${t + 1}: ${wH} vs ${expect}`);
      if (s[t]! > 1.5) clippedHigh++;
      if (s[t]! < 0) clippedLow++;
      assert.ok(wH <= 0 && wH >= -1.5 * r.wLong[i]! - 1e-12);
    });
  }
  assert.ok(clippedHigh > 100 && clippedLow > 100, "both clips were exercised");
});

test("RECOMMENDED_TIGER's hedge cancels the book's market beta; the old half hedge left half of it on", () => {
  const p = syntheticPanel({ days: 1000, seed: 37, beta: 1.2, vol: 0.03 });
  const rec: TigerParams = { ...RECOMMENDED_TIGER, hedgeSymbol: "HG" };
  const half: TigerParams = { ...rec, hedgeRatio: 0.5, hedgeBeta: null };
  const none: TigerParams = { ...rec, hedgeRatio: 0 };
  const range = { from: 200, to: 999 };
  const bRec = bookBeta(runTiger(p, [], rec, range), p, 200);
  const bHalf = bookBeta(runTiger(p, [], half, range), p, 200);
  const bNone = bookBeta(runTiger(p, [], none, range), p, 200);
  assert.ok(bNone > 0.5, `unhedged book beta ${bNone}`);
  assert.ok(bHalf > 0.35 * bNone, `half hedge leaves ~half the beta on: ${bHalf} vs ${bNone}`);
  assert.ok(Math.abs(bRec) < 0.15 * bNone, `recommended hedge leaves ~none: ${bRec} vs ${bNone}`);
});


/* ------------------------------------------------------------------ */
/* Crowding gate                                                      */
/* ------------------------------------------------------------------ */

/** Add a constant daily drift to the hedge index, carried into the primary at `beta`: a MARKET rally. */
function withMarketDrift(p: Panel, drift: number, beta: number): Panel {
  const ret = {
    LK: p.ret.LK!.map((r, i) => (i === 0 ? r : r + beta * drift)),
    HG: p.ret.HG!.map((r, i) => (i === 0 ? r : r + drift)),
  };
  const px = (r: number[]) => {
    const out = [100];
    for (let i = 1; i < r.length; i++) out.push(out[i - 1]! * (1 + r[i]!));
    return out;
  };
  return { ...p, ret, px: { LK: px(ret.LK), HG: px(ret.HG) } };
}

test("crowdingSeries is the t-statistic of the window's mean idiosyncratic return", () => {
  const y = [0, 0.01, 0.03, -0.01, 0.02, 0.05];
  const x = [0, 0.01, 0.01, 0.0, -0.01, 0.02];
  const beta = [NaN, NaN, 1, 2, 0.5, 1];
  const z = crowdingSeries(y, x, beta, 3);
  // e = y − beta·x, the raw return where beta is undefined
  const e = [0, 0.01, 0.02, -0.01, 0.025, 0.03];
  const tstat = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    return (m / sd) * Math.sqrt(xs.length);
  };
  assert.ok(Number.isNaN(z[0]!) && Number.isNaN(z[1]!) && Number.isNaN(z[2]!), "NaN until L returns (r[0] excluded) exist");
  for (const t of [3, 4, 5]) assert.ok(Math.abs(z[t]! - tstat(e.slice(t - 2, t + 1))) < 1e-12, `t=${t}`);
  // Without an index the raw return is used.
  const raw = crowdingSeries(y, null, null, 3);
  assert.ok(Math.abs(raw[5]! - tstat(y.slice(3, 6))) < 1e-12);
});

test("crowdingSeries is point-in-time: changing the future never moves a past value", () => {
  const base = syntheticPanel({ days: 400, seed: 21, drift: 0.002 });
  const k = 250;
  const fork = forkAt(base, k, 99);
  const zb = crowdingSeries(base.ret.LK!, base.ret.HG!, betaSeries(base.ret.LK!, base.ret.HG!, 120), 60);
  const zf = crowdingSeries(fork.ret.LK!, fork.ret.HG!, betaSeries(fork.ret.LK!, fork.ret.HG!, 120), 60);
  for (let t = 0; t <= k; t++) assert.ok(Object.is(zb[t], zf[t]), `moved at ${t}`);
  assert.notDeepEqual(zb.slice(k + 1), zf.slice(k + 1));
});

test("crowding gate: an idiosyncratic rally trims the long to crowdFactor exactly on crowded days, with CROWDED/UNCROWDED events", () => {
  const p = syntheticPanel({ days: 500, seed: 22, drift: 0.004, vol: 0.015 }); // the name outruns its index
  const params: TigerParams = { ...BUY_AND_HOLD, hedgeSymbol: "HG", hedgeRatio: 0, crowdZ: 2, crowdLookback: 60, crowdFactor: 0.5 };
  const r = runTiger(p, [], params, { from: 100, to: 499 });
  const z = crowdingSeries(p.ret.LK!, p.ret.HG!, betaSeries(p.ret.LK!, p.ret.HG!, params.betaLookback), 60);
  let crowdedDays = 0;
  for (let i = 0; i < r.wLong.length; i++) {
    const t = 100 - 1 + i; // the weight held into day t+1 was decided at close t
    const crowded = z[t]! > 2;
    if (crowded) crowdedDays++;
    assert.equal(r.wLong[i], crowded ? 0.5 : 1, `close ${t}: z=${z[t]}`);
  }
  assert.ok(crowdedDays > 20 && crowdedDays < r.wLong.length, `the gate fires on some days, not all (${crowdedDays})`);
  const ev = r.events.filter((e) => e.kind === "CROWDED" || e.kind === "UNCROWDED");
  assert.ok(ev.length >= 2, `the name moves in and out of the crowded state (${ev.length} events)`);
  ev.forEach((e, i) => {
    if (i > 0) assert.notEqual(e.kind, ev[i - 1]!.kind, "events alternate");
    assert.equal(e.kind === "CROWDED", z[e.t]! > 2);
    assert.equal(z[e.t - 1]! > 2, e.kind !== "CROWDED", "an event marks a change of state");
  });
  // Off by default: buy-and-hold is untouched.
  assert.equal(DEFAULT_PARAMS.crowdZ, null);
  assert.ok(runTiger(p, [], BUY_AND_HOLD, { from: 100, to: 499 }).wLong.every((w) => w === 1));
});

test("crowding gate looks through the market: a rally the index explains is not crowding", () => {
  const p = withMarketDrift(syntheticPanel({ days: 500, seed: 23, beta: 1.2, vol: 0.01 }), 0.006, 1.2);
  const hedged: TigerParams = { ...BUY_AND_HOLD, hedgeSymbol: "HG", hedgeRatio: 0, crowdZ: 2, crowdLookback: 60 };
  const unhedged: TigerParams = { ...hedged, hedgeSymbol: null };
  const net = runTiger(p, [], hedged, { from: 150, to: 499 });
  const raw = runTiger(p, [], unhedged, { from: 150, to: 499 });
  const trimmed = (r: { wLong: number[] }) => r.wLong.filter((w) => w < 1).length;
  // Measured on raw returns, the same rally looks crowded much of the time …
  assert.ok(trimmed(raw) > 100, `raw gate trimmed ${trimmed(raw)} days`);
  // … net of beta to the index it is (almost) never abnormal.
  assert.ok(trimmed(net) < 0.1 * trimmed(raw), `market-adjusted gate trimmed ${trimmed(net)} days`);
});

test("crowding gate: a crowded long that gaps down takes crowdFactor of the gap", () => {
  // A steady idiosyncratic run (flows), then the crowd leaves in one day.
  const p = syntheticPanel({ days: 320, seed: 24, drift: 0.006, vol: 0.012, shocks: { 300: -0.3 } });
  const base: TigerParams = { ...BUY_AND_HOLD, hedgeSymbol: "HG", hedgeRatio: 0, costBps: 0 };
  const gated: TigerParams = { ...base, crowdZ: 2, crowdLookback: 60, crowdFactor: 0.5 };
  const a = runTiger(p, [], base, { from: 100, to: 319 });
  const b = runTiger(p, [], gated, { from: 100, to: 319 });
  const i = 300 - 100; // result i is return day from + i
  assert.equal(a.wLong[i], 1);
  assert.equal(b.wLong[i], 0.5, "half size into the gap");
  assert.ok(Math.abs(a.ret[i]! - -0.3) < 1e-12, "the ungated book takes the full gap");
  assert.ok(Math.abs(b.ret[i]! - (0.5 * -0.3 + 0.5 * p.rf[300]!)) < 1e-12);
});

test("RECOMMENDED_TIGER runs the crowding gate: 2 standard errors over ~a quarter → half size", () => {
  assert.equal(RECOMMENDED_TIGER.crowdZ, 2);
  assert.equal(RECOMMENDED_TIGER.crowdLookback, 60);
  assert.equal(RECOMMENDED_TIGER.crowdFactor, 0.5);
});
