/**
 * The research protocol: how a parameter search is allowed to touch the data.
 *
 *   ┌──────────── development period ────────────┐┌── sealed holdout ──┐
 *   | walk-forward: train ▸ test, train ▸ test … ||  touched ONCE, at   |
 *   | full grid for PBO / deflated Sharpe         ||  the very end      |
 *   └─────────────────────────────────────────────┘└────────────────────┘
 *
 *  1. Every variant in the grid is a TRIAL. All of them are counted, so the
 *     deflated Sharpe knows how hard we searched.
 *  2. Walk-forward: at each step, pick the best variant on data up to the
 *     step, then trade it on the next window it has never seen. The stitched
 *     out-of-sample record is the honest estimate of "the search process".
 *  3. The holdout is evaluated only by `evaluateHoldout`, which appends to a
 *     ledger; a second look is recorded, not hidden.
 */

import {
  deflatedSharpe,
  performance,
  periodSharpe,
  probabilisticSharpe,
  probabilityOfOverfitting,
  sharpeDifferenceCI,
  type Deflated,
  type DiffCI,
  type Performance,
  type PboResult,
} from "./metrics";
import type { Panel, PanelEvent } from "./series";
import { BUY_AND_HOLD, FRESH_BOOK, runTiger, type BookState, type RunRange, type StrategyRun, type TigerParams } from "./strategy";

/* ------------------------------------------------------------------ */
/* Grid                                                               */
/* ------------------------------------------------------------------ */

export type ParamSpace = { [K in keyof TigerParams]?: TigerParams[K][] };

/**
 * Collapse parameters that cannot matter so equivalent variants count once
 * (e.g. a trend floor without a trend gate). Keeps the trial count honest.
 */
export function canonical(p: TigerParams): TigerParams {
  const q = { ...p };
  if (q.trendLookback === null) q.trendFloor = 1;
  if (q.hedgeSymbol === null || q.hedgeRatio === 0) {
    q.hedgeSymbol = null;
    q.hedgeRatio = 0;
    q.betaLookback = BUY_AND_HOLD.betaLookback;
    q.hedgeBeta = BUY_AND_HOLD.hedgeBeta;
  }
  if (q.preEventDays === 0 || q.preEventMult === 1) {
    q.preEventDays = 0;
    q.preEventMult = 1;
  }
  if (q.postEventDays === 0 || q.postEventMult === 1) {
    q.postEventDays = 0;
    q.postEventMult = 1;
  }
  if (q.ddCut === null) q.cutFactor = BUY_AND_HOLD.cutFactor;
  if (q.ddStop === null) q.reentryDays = BUY_AND_HOLD.reentryDays;
  if (q.volTarget === null) q.volLookback = BUY_AND_HOLD.volLookback;
  if (q.crowdZ === null || q.crowdFactor === 1) {
    q.crowdZ = null;
    q.crowdLookback = BUY_AND_HOLD.crowdLookback;
    q.crowdFactor = BUY_AND_HOLD.crowdFactor;
  }
  return q;
}

export function paramKey(p: TigerParams): string {
  const c = canonical(p);
  return JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k as keyof TigerParams]]));
}

export function expandGrid(base: TigerParams, space: ParamSpace, opts: { hasEvents?: boolean } = {}): TigerParams[] {
  // Without an earnings calendar, catalyst settings cannot change anything;
  // counting them as separate trials would inflate N (and deflate unfairly).
  if (opts.hasEvents === false) {
    space = { ...space };
    delete space.preEventDays;
    delete space.preEventMult;
    delete space.postEventDays;
    delete space.postEventMult;
  }
  let acc: TigerParams[] = [{ ...base }];
  for (const [k, values] of Object.entries(space) as [keyof TigerParams, unknown[]][]) {
    if (!values || values.length === 0) continue;
    const next: TigerParams[] = [];
    for (const p of acc) for (const v of values) next.push({ ...p, [k]: v } as TigerParams);
    acc = next;
  }
  const seen = new Map<string, TigerParams>();
  for (const p of acc) {
    const c = canonical(p);
    const key = paramKey(c);
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

/** The default search space: every lever of the Tiger overlay, coarse steps. */
export function defaultSpace(hedges: readonly string[]): ParamSpace {
  // ~5.6k distinct variants with two hedges (after canonical() collapses
  // settings that cannot matter). Every one of them counts as a trial.
  return {
    baseWeight: [0.5, 1],
    volTarget: [null, 0.35, 0.5],
    volLookback: [20, 60],
    trendLookback: [null, 50, 100, 200],
    trendFloor: [0, 0.5],
    preEventDays: [0, 5],
    preEventMult: [0, 0.5, 1.5],
    ddCut: [null, 0.15],
    ddStop: [null, 0.25],
    hedgeSymbol: [null, ...hedges],
    hedgeRatio: [0, 0.5, 1],
  };
}

/* ------------------------------------------------------------------ */
/* Objective                                                          */
/* ------------------------------------------------------------------ */

export interface ObjectiveOpts {
  /** Variants that sit mostly in cash are not "the Tiger book"; exclude them. */
  minExposure: number;
}

export const DEFAULT_OBJECTIVE: ObjectiveOpts = { minExposure: 0.3 };

function excess(run: StrategyRun): number[] {
  return run.ret.map((r, i) => r - run.rf[i]!);
}

/** Annualized excess-return Sharpe; −∞ for variants below the exposure floor. */
export function objective(run: StrategyRun, o: ObjectiveOpts = DEFAULT_OBJECTIVE): number {
  if (run.exposure < o.minExposure) return -Infinity;
  return periodSharpe(excess(run)) * Math.sqrt(252);
}

/* ------------------------------------------------------------------ */
/* Splits                                                             */
/* ------------------------------------------------------------------ */

export interface Split {
  /** Research period (return-day indices, inclusive). */
  dev: RunRange;
  /** Sealed holdout, or null when the history is too short to spare one. */
  holdout: RunRange | null;
}

/**
 * Carve the panel: the last `holdoutDays` trading days are sealed; the first
 * `warmupDays` are indicator warm-up only (no returns are scored there).
 */
export function makeSplit(panel: Panel, opts: { holdoutDays: number; warmupDays: number }): Split {
  const last = panel.dates.length - 1;
  const from = Math.min(opts.warmupDays, last - 1) || 1;
  const holdFrom = last - opts.holdoutDays + 1;
  if (opts.holdoutDays <= 0 || holdFrom - from < 252) return { dev: { from, to: last }, holdout: null };
  return { dev: { from, to: holdFrom - 1 }, holdout: { from: holdFrom, to: last } };
}

/* ------------------------------------------------------------------ */
/* Search over a range                                                */
/* ------------------------------------------------------------------ */

export interface Trial {
  params: TigerParams;
  run: StrategyRun;
  score: number;
}

export function searchRange(
  panel: Panel,
  events: readonly PanelEvent[],
  grid: readonly TigerParams[],
  range: RunRange,
  o: ObjectiveOpts = DEFAULT_OBJECTIVE,
): { best: Trial; trials: Trial[] } {
  const trials = grid.map((params) => {
    const run = runTiger(panel, events, params, range);
    return { params, run, score: objective(run, o) };
  });
  const eligible = trials.filter((t) => Number.isFinite(t.score));
  if (eligible.length === 0) throw new Error("no variant meets the exposure floor");
  const best = eligible.reduce((a, b) => (b.score > a.score ? b : a));
  return { best, trials };
}

/* ------------------------------------------------------------------ */
/* Walk-forward                                                       */
/* ------------------------------------------------------------------ */

export interface WalkStep {
  train: RunRange;
  test: RunRange;
  chosen: TigerParams;
  trainSharpe: number;
  testSharpe: number;
  benchTestSharpe: number;
}

export interface WalkForward {
  steps: WalkStep[];
  /** Stitched out-of-sample net returns of the search PROCESS. */
  oos: StrategyRun;
  /** Buy-and-hold over the same out-of-sample days. */
  bench: StrategyRun;
}

/** Anchored walk-forward inside `dev`. */
export function walkForward(
  panel: Panel,
  events: readonly PanelEvent[],
  grid: readonly TigerParams[],
  dev: RunRange,
  opts: { minTrain: number; testLen: number } & Partial<ObjectiveOpts> = { minTrain: 504, testLen: 126 },
): WalkForward {
  const o = { ...DEFAULT_OBJECTIVE, ...opts };
  const steps: WalkStep[] = [];
  const concat = (runs: StrategyRun[]): StrategyRun => {
    const days = runs.reduce((a, r) => a + r.ret.length, 0);
    const wLong = runs.flatMap((r) => r.wLong);
    const traded = runs.reduce((a, r) => a + r.traded, 0);
    return {
      dates: runs.flatMap((r) => r.dates),
      ret: runs.flatMap((r) => r.ret),
      rf: runs.flatMap((r) => r.rf),
      wLong,
      wHedge: runs.flatMap((r) => r.wHedge),
      events: runs.flatMap((r) => r.events),
      exposure: wLong.reduce((a, b) => a + b, 0) / Math.max(1, days),
      // Turnover from the trades actually charged, including the first entry.
      turnover: (traded / Math.max(1, days)) * 252,
      costs: runs.reduce((a, r) => a + r.costs, 0),
      traded,
      state: runs.at(-1)?.state ?? FRESH_BOOK,
    };
  };
  const oosRuns: StrategyRun[] = [];
  const benchRuns: StrategyRun[] = [];
  // ONE continuous book across test windows: the ladder, a stop-out's
  // cooldown and the open position carry over even when the chosen
  // parameters change. Same for the benchmark (one entry cost, not one per window).
  let state: BookState = FRESH_BOOK;
  let benchState: BookState = FRESH_BOOK;
  for (let testFrom = dev.from + opts.minTrain; testFrom <= dev.to; testFrom += opts.testLen) {
    const train = { from: dev.from, to: testFrom - 1 };
    const test = { from: testFrom, to: Math.min(dev.to, testFrom + opts.testLen - 1) };
    const { best } = searchRange(panel, events, grid, train, o);
    const run = runTiger(panel, events, best.params, test, state);
    const bench = runTiger(panel, events, BUY_AND_HOLD, test, benchState);
    state = run.state;
    benchState = bench.state;
    oosRuns.push(run);
    benchRuns.push(bench);
    steps.push({
      train,
      test,
      chosen: best.params,
      trainSharpe: best.score,
      testSharpe: periodSharpe(excess(run)) * Math.sqrt(252),
      benchTestSharpe: periodSharpe(excess(bench)) * Math.sqrt(252),
    });
  }
  if (steps.length === 0) throw new Error("walk-forward: development period shorter than minTrain");
  return { steps, oos: concat(oosRuns), bench: concat(benchRuns) };
}

/* ------------------------------------------------------------------ */
/* Full development-period study                                      */
/* ------------------------------------------------------------------ */

export interface Study {
  /** Every variant evaluated — the N the deflated Sharpe is deflated for. */
  trials: number;
  /** Variants that met the exposure floor (eligible to be selected). */
  eligible: number;
  best: { params: TigerParams; perf: Performance; score: number };
  bench: Performance;
  /** Deflated Sharpe of the in-sample winner given every trial tried. */
  deflated: Deflated;
  pbo: PboResult;
  walkForward: {
    steps: WalkStep[];
    perf: Performance;
    bench: Performance;
    /** P(true OOS Sharpe > 0). */
    psr: number;
    /** Paired bootstrap CI: OOS Sharpe − buy-and-hold Sharpe. */
    vsBench: DiffCI;
    /** How often each step chose the same variant as the previous one. */
    stability: number;
  };
}

export function study(
  panel: Panel,
  events: readonly PanelEvent[],
  grid: readonly TigerParams[],
  dev: RunRange,
  opts: { minTrain: number; testLen: number; pboBlocks?: number } & Partial<ObjectiveOpts>,
): Study {
  const o = { ...DEFAULT_OBJECTIVE, ...opts };
  const { best, trials } = searchRange(panel, events, grid, dev, o);
  const bench = runTiger(panel, events, BUY_AND_HOLD, dev);
  const eligible = trials.filter((t) => Number.isFinite(t.score));
  const excessOf = (t: Trial) => excess(t.run);
  // Deflate for EVERY variant looked at, including those the exposure floor
  // later ruled out: they were still part of the search.
  const deflated = deflatedSharpe(excessOf(best), trials.map((t) => periodSharpe(excessOf(t))));
  // CSCV cost grows with trials × C(S, S/2); drop to 12 blocks for big grids.
  const blocks = opts.pboBlocks ?? (eligible.length > 1200 ? 12 : 16);
  const pbo = probabilityOfOverfitting(eligible.map(excessOf), blocks);
  const wf = walkForward(panel, events, grid, dev, { ...o, minTrain: opts.minTrain, testLen: opts.testLen });
  let same = 0;
  for (let i = 1; i < wf.steps.length; i++) if (paramKey(wf.steps[i]!.chosen) === paramKey(wf.steps[i - 1]!.chosen)) same++;
  return {
    trials: trials.length,
    eligible: eligible.length,
    best: { params: best.params, perf: performance(best.run.ret, best.run.rf), score: best.score },
    bench: performance(bench.ret, bench.rf),
    deflated,
    pbo,
    walkForward: {
      steps: wf.steps,
      perf: performance(wf.oos.ret, wf.oos.rf),
      bench: performance(wf.bench.ret, wf.bench.rf),
      psr: probabilisticSharpe(excess(wf.oos)),
      vsBench: sharpeDifferenceCI(excess(wf.oos), excess(wf.bench)),
      stability: wf.steps.length > 1 ? same / (wf.steps.length - 1) : 1,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Holdout                                                            */
/* ------------------------------------------------------------------ */

export interface HoldoutResult {
  range: { from: string; to: string };
  params: TigerParams;
  perf: Performance;
  bench: Performance;
  vsBench: DiffCI;
  psr: number;
  events: StrategyRun["events"];
}

/**
 * The holdout is a NEW deployment: the book starts fresh (full size, new
 * high-water mark) on the first holdout day. That is deliberate — it is the
 * record you would get by switching the strategy on at that date.
 */
export function evaluateHoldout(
  panel: Panel,
  events: readonly PanelEvent[],
  params: TigerParams,
  holdout: RunRange,
): HoldoutResult {
  const run = runTiger(panel, events, params, holdout);
  const bench = runTiger(panel, events, BUY_AND_HOLD, holdout);
  return {
    range: { from: panel.dates[holdout.from]!, to: panel.dates[holdout.to]! },
    params,
    perf: performance(run.ret, run.rf),
    bench: performance(bench.ret, bench.rf),
    vsBench: sharpeDifferenceCI(excess(run), excess(bench)),
    psr: probabilisticSharpe(excess(run)),
    events: run.events,
  };
}
