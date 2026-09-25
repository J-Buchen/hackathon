/**
 * Forward simulation from real history: "if the next year looks like a
 * reshuffled version of the past, what does each way of running the book do?"
 *
 *  - Normal days are drawn with a stationary block bootstrap over the joint
 *    rows of (primary, hedges, risk-free), so volatility clustering and the
 *    Luckin/China-beta co-movement survive the reshuffle.
 *  - Earnings days are drawn separately from the REAL historical earnings
 *    reactions and placed on the scheduled forward dates, so catalyst timing
 *    has something real to act on.
 *  - Drift is a choice, not an accident. Luckin went up ~20× from its OTC lows;
 *    resampling that history as-is bakes the hindsight into every path.
 *      "historical"  keep it (optimistic; shown for reference only)
 *      "zero"        every series earns the risk-free rate on average: pure risk, no edge
 *      { annual }    the primary compounds to this 1-year SIMPLE return on average
 *                    (e.g. the valuation scenarios' probability-weighted return);
 *                    hedges earn the risk-free rate
 *
 * The strategy runs on each synthetic path through the same `runTiger`, after
 * a warm-up of real history so indicators start primed.
 */

import { mulberry32 } from "@allowance/swarm";
import { performance, TRADING_DAYS, stationaryBootstrapIndices } from "./metrics";
import type { Panel, PanelEvent } from "./series";
import { runTiger, type TigerParams } from "./strategy";

export type Drift = "historical" | "zero" | { annual: number };

export interface ForwardConfig {
  horizon: number;
  paths: number;
  meanBlock: number;
  drift: Drift;
  /** Forward print positions as trading-day offsets from today (1 = tomorrow). */
  forwardEvents: number[];
  seed: number;
  /** Days of real history prepended so indicators are primed. */
  warmup: number;
}

export interface Distribution {
  mean: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface ForwardSummary {
  totalReturn: Distribution;
  maxDrawdown: Distribution;
  sharpe: Distribution;
  /** P(total return < 0). */
  pLoss: number;
  /** P(max drawdown > 30%). */
  pDrawdown30: number;
  /** Share of paths where the book was stopped out at least once. */
  pStopOut: number;
}

function dist(xs: number[]): Distribution {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
}

export function forwardMonteCarlo(
  panel: Panel,
  events: readonly PanelEvent[],
  strategies: Record<string, TigerParams>,
  cfg: ForwardConfig,
): Record<string, ForwardSummary> {
  const syms = panel.symbols;
  const N = panel.dates.length;
  const eventDays = new Set(events.map((e) => e.t));
  const normalRows: number[] = [];
  const eventRows: number[] = [];
  for (let t = 1; t < N; t++) (eventDays.has(t) ? eventRows : normalRows).push(t);
  if (normalRows.length < 100) throw new Error("forward MC: not enough history");

  // Drift adjustment per symbol, applied to every sampled row.
  //  - "zero": risky assets earn the RISK-FREE rate on average (no premium),
  //    so stepping into cash is neither rewarded nor punished by construction.
  //  - { annual }: the primary's daily mean is set so it COMPOUNDS to the
  //    scenario tree's 1-year simple return over the non-event days (event
  //    rows are de-meaned to rf); hedges earn rf.
  const meanOf = (rows: number[], xs: readonly number[]) => (rows.length ? rows.reduce((a, t) => a + xs[t]!, 0) / rows.length : 0);
  const rfNormal = meanOf(normalRows, panel.rf);
  const rfEvent = meanOf(eventRows, panel.rf);
  const eventDaysAhead = cfg.forwardEvents.filter((d) => d >= 1 && d <= cfg.horizon).length;
  const shift: Record<string, number> = {};
  const evShift: Record<string, number> = {};
  for (const s of syms) {
    const r = panel.ret[s]!;
    if (cfg.drift === "historical") {
      shift[s] = 0;
      evShift[s] = 0;
      continue;
    }
    let target = rfNormal;
    if (typeof cfg.drift === "object" && s === panel.primary) {
      const normalDays = Math.max(1, cfg.horizon - eventDaysAhead);
      // Excess over rf is what the thesis adds; compound the total to the target.
      target = (1 + cfg.drift.annual) ** (1 / normalDays) - 1;
    }
    shift[s] = target - meanOf(normalRows, r);
    evShift[s] = eventRows.length ? rfEvent - meanOf(eventRows, r) : 0;
  }

  const W = Math.min(cfg.warmup, N - 1);
  const start = N - W;
  const rand = mulberry32(cfg.seed);
  const fwdEventSet = new Set(cfg.forwardEvents.filter((d) => d >= 1 && d <= cfg.horizon));
  const results: Record<string, { tr: number[]; dd: number[]; sh: number[]; stops: number }> = {};
  for (const k of Object.keys(strategies)) results[k] = { tr: [], dd: [], sh: [], stops: 0 };

  for (let path = 0; path < cfg.paths; path++) {
    const idx = stationaryBootstrapIndices(normalRows.length, cfg.horizon, cfg.meanBlock, rand);
    const dates: string[] = [];
    const px: Record<string, number[]> = {};
    const ret: Record<string, number[]> = {};
    const rf: number[] = [];
    for (const s of syms) {
      px[s] = panel.px[s]!.slice(start);
      ret[s] = panel.ret[s]!.slice(start);
    }
    for (let i = start; i < N; i++) {
      dates.push(panel.dates[i]!);
      rf.push(panel.rf[i]!);
    }
    ret[panel.primary]![0] = 0;
    for (let d = 1; d <= cfg.horizon; d++) {
      const isEvent = fwdEventSet.has(d) && eventRows.length > 0;
      const row = isEvent ? eventRows[Math.floor(rand() * eventRows.length)]! : normalRows[idx[d - 1]!]!;
      dates.push(`F+${String(d).padStart(3, "0")}`);
      rf.push(panel.rf[row]!);
      for (const s of syms) {
        const r = Math.max(-0.95, panel.ret[s]![row]! + (isEvent ? evShift[s]! : shift[s]!));
        ret[s]!.push(r);
        px[s]!.push(px[s]![px[s]!.length - 1]! * (1 + r));
      }
    }
    // Historical prints inside the warm-up keep their positions; forward prints are new.
    const pathEvents: PanelEvent[] = [
      ...events.filter((e) => e.t >= start).map((e) => ({ ...e, t: e.t - start })),
      ...[...fwdEventSet].map((d) => ({ t: W - 1 + d, date: `F+${d}`, label: "scheduled print" })),
    ];
    const synthetic: Panel = { primary: panel.primary, symbols: syms, dates, px, ret, rf };
    const range = { from: W, to: W + cfg.horizon - 1 };
    for (const [k, p] of Object.entries(strategies)) {
      const run = runTiger(synthetic, pathEvents, p, range);
      const perf = performance(run.ret, run.rf);
      const r = results[k]!;
      r.tr.push(perf.totalReturn);
      r.dd.push(perf.maxDrawdown);
      r.sh.push(perf.sharpe);
      if (run.events.some((e) => e.kind === "STOP_OUT")) r.stops++;
    }
  }

  const out: Record<string, ForwardSummary> = {};
  for (const [k, r] of Object.entries(results)) {
    out[k] = {
      totalReturn: dist(r.tr),
      maxDrawdown: dist(r.dd),
      sharpe: dist(r.sh),
      pLoss: r.tr.filter((x) => x < 0).length / r.tr.length,
      pDrawdown30: r.dd.filter((x) => x > 0.3).length / r.dd.length,
      pStopOut: r.stops / cfg.paths,
    };
  }
  return out;
}
