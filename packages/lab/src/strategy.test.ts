import { test } from "node:test";
import assert from "node:assert/strict";
import { BUY_AND_HOLD, DEFAULT_PARAMS, betaSeries, runTiger, type TigerParams } from "./strategy";
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
