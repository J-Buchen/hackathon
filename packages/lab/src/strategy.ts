/**
 * The Luckin Tiger book as a point-in-time daily backtest.
 *
 * The long is the thesis (Luckin, from the pitch). What the backtest can test
 * is the Tiger MANAGEMENT MODEL around it — the parts that do not require
 * knowing in advance that Luckin would go up:
 *
 *   size   conviction weight × volatility targeting
 *   cut    a trend filter (don't fight the tape) and a drawdown ladder:
 *          cut at `ddCut`, flat at `ddStop` (the mandate is revoked), and only
 *          re-underwritten after `reentryDays` AND the trend is back
 *   time   lean in (or out) ahead of scheduled earnings, and after them
 *   hedge  short China-ADR beta (KWEB/FXI/MCHI) with a trailing-beta hedge
 *
 * TIMING CONVENTION (the no-look-ahead contract):
 *   weights for day t+1 are decided at the close of day t, using prices and
 *   returns with index ≤ t only, plus events whose date was announced by t
 *   (`announceLead` trading days before the print). The portfolio earns
 *   w[t]·r[t+1]. Tests perturb the future and assert past weights don't move.
 */

import type { Panel, PanelEvent } from "./series";

export interface TigerParams {
  /** Conviction size: long weight (fraction of capital) when every gate is open. */
  baseWeight: number;
  /** Hard cap on |long| + |hedge|. */
  maxGross: number;
  /** Annualized volatility target for the long; null = no vol scaling. */
  volTarget: number | null;
  volLookback: number;
  /** Simple-moving-average length for the trend gate; null = no trend gate. */
  trendLookback: number | null;
  /** Long multiplier while price < SMA. 0 = step aside entirely. */
  trendFloor: number;
  /** Trading days before a print during which `preEventMult` applies (holds THROUGH the print). */
  preEventDays: number;
  preEventMult: number;
  /** Trading days from the print during which `postEventMult` applies. */
  postEventDays: number;
  postEventMult: number;
  /** Drawdown of the book from its high-water mark that triggers a cut; null = none. */
  ddCut: number | null;
  cutFactor: number;
  /** Drawdown that stops the book out (weights → 0; the mandate is revoked). */
  ddStop: number | null;
  /** Minimum trading days flat before re-underwriting (also requires trend OK when a trend gate is set). */
  reentryDays: number;
  /** Hedge instrument (must be in the panel); null = unhedged. */
  hedgeSymbol: string | null;
  /** Fraction of the long's trailing beta to hedge (0–1). */
  hedgeRatio: number;
  betaLookback: number;
  /** Costs: one-way cost per unit turnover on the long (OTC spread + impact), in bps. */
  costBps: number;
  hedgeCostBps: number;
  /** Annual borrow cost on the short hedge notional. */
  borrowRate: number;
  /** Annual financing cost on long exposure above 100%. */
  financingRate: number;
  /** How many trading days before a print its date is assumed public. */
  announceLead: number;
}

export const DEFAULT_PARAMS: TigerParams = {
  baseWeight: 1,
  maxGross: 1.5,
  volTarget: null,
  volLookback: 40,
  trendLookback: null,
  trendFloor: 1,
  preEventDays: 0,
  preEventMult: 1,
  postEventDays: 0,
  postEventMult: 1,
  ddCut: null,
  cutFactor: 0.5,
  ddStop: null,
  reentryDays: 20,
  hedgeSymbol: null,
  hedgeRatio: 0,
  betaLookback: 120,
  costBps: 20,
  hedgeCostBps: 5,
  borrowRate: 0.02,
  financingRate: 0.06,
  announceLead: 10,
};

/** Buy-and-hold with the same cost model: the benchmark every variant must beat. */
export const BUY_AND_HOLD: TigerParams = { ...DEFAULT_PARAMS };

/**
 * The overlay's recommended settings — what the arena's tiger track scores and
 * the improvement loops tune. `hedgeSymbol` is a placeholder: callers point it
 * at their own hedge instrument (the arena uses its virtual index "VIDX").
 */
export const RECOMMENDED_TIGER: TigerParams = {
  ...BUY_AND_HOLD,
  volTarget: 0.35,
  volLookback: 40,
  ddCut: 0.15,
  ddStop: 0.3,
  reentryDays: 20,
  hedgeSymbol: "VIDX",
  hedgeRatio: 0.5,
};

export type BookEventKind = "STOP_OUT" | "REUNDERWRITE" | "CUT" | "UNCUT";

export interface BookEvent {
  t: number;
  date: string;
  kind: BookEventKind;
  detail: string;
}

/**
 * The book's running state. Pass the final state of one run as the initial
 * state of the next to trade one CONTINUOUS book across windows (the ladder,
 * a stop-out's cooldown and the current position all carry over).
 */
export interface BookState {
  nav: number;
  hwm: number;
  stopped: boolean;
  /** Close index of the last stop-out (−1 if none). */
  stopT: number;
  cut: boolean;
  /** Weights held after the last day's price move (pre-trade). */
  prevL: number;
  prevH: number;
}

export const FRESH_BOOK: BookState = { nav: 1, hwm: 1, stopped: false, stopT: -1, cut: false, prevL: 0, prevH: 0 };

export interface StrategyRun {
  /** Return-day dates: dates[from..to]. */
  dates: string[];
  /** Net daily returns on those days (cash earns the risk-free rate). */
  ret: number[];
  /** Risk-free rate on those days, for excess-return statistics. */
  rf: number[];
  /** Weights held INTO each return day (decided the prior close). */
  wLong: number[];
  wHedge: number[];
  events: BookEvent[];
  /** Mean |long weight| held. */
  exposure: number;
  /** Annualized one-way turnover of the long. */
  turnover: number;
  /** Total costs paid (sum of daily cost drag). */
  costs: number;
  /** Sum of |Δ long weight| actually traded (incl. the first entry). */
  traded: number;
  /** State at the end of the run — feed it to the next window to continue the book. */
  state: BookState;
}

export interface RunRange {
  /** First return day (index into panel.dates), ≥ 1. */
  from: number;
  /** Last return day, inclusive. */
  to: number;
}

/* ------------------------------------------------------------------ */
/* Indicators — computed once per panel and cached (all point-in-time: */
/* the value at t uses indices ≤ t only)                               */
/* ------------------------------------------------------------------ */

const CACHE = new WeakMap<object, Map<string, number[]>>();

function cached(owner: object, key: string, build: () => number[]): number[] {
  let m = CACHE.get(owner);
  if (!m) CACHE.set(owner, (m = new Map()));
  let v = m.get(key);
  if (!v) m.set(key, (v = build()));
  return v;
}

/** Trailing sample stdev of r[t-L+1..t] (r[0] excluded); NaN below 10 observations. */
export function trailingVolSeries(r: readonly number[], L: number): number[] {
  return r.map((_, t) => {
    const a = Math.max(1, t - L + 1);
    const n = t - a + 1;
    if (n < 10) return NaN;
    let s = 0;
    for (let i = a; i <= t; i++) s += r[i]!;
    const m = s / n;
    let q = 0;
    for (let i = a; i <= t; i++) q += (r[i]! - m) ** 2;
    return Math.sqrt(q / (n - 1));
  });
}

/** Trailing simple moving average of px[t-L+1..t]; NaN until L prices exist. */
export function smaSeries(px: readonly number[], L: number): number[] {
  const out: number[] = [];
  let s = 0;
  for (let t = 0; t < px.length; t++) {
    s += px[t]!;
    if (t >= L) s -= px[t - L]!;
    out.push(t >= L - 1 ? s / L : NaN);
  }
  return out;
}

/** Trailing OLS beta of y on x over r[t-L+1..t]; NaN below 20 observations. */
export function betaSeries(y: readonly number[], x: readonly number[], L: number): number[] {
  return y.map((_, t) => {
    const a = Math.max(1, t - L + 1);
    const n = t - a + 1;
    if (n < 20) return NaN;
    let sx = 0;
    let sy = 0;
    for (let i = a; i <= t; i++) {
      sx += x[i]!;
      sy += y[i]!;
    }
    const mx = sx / n;
    const my = sy / n;
    let cov = 0;
    let vx = 0;
    for (let i = a; i <= t; i++) {
      cov += (x[i]! - mx) * (y[i]! - my);
      vx += (x[i]! - mx) ** 2;
    }
    return vx === 0 ? NaN : cov / vx;
  });
}

/**
 * For each close t: trading days until the next print that is public by t
 * (announced ≥ `lead` days ahead), and days since the most recent print ≤ t.
 * Infinity when there is none.
 */
export function eventDistances(
  n: number,
  events: readonly PanelEvent[],
  lead: number,
): { untilNext: number[]; sinceLast: number[] } {
  const ts = [...new Set(events.map((e) => e.t))].sort((a, b) => a - b);
  const untilNext: number[] = [];
  const sinceLast: number[] = [];
  let j = 0;
  for (let t = 0; t < n; t++) {
    while (j < ts.length && ts[j]! <= t) j++;
    const next = ts[j];
    untilNext.push(next !== undefined && next - lead <= t ? next - t : Infinity);
    sinceLast.push(j > 0 ? t - ts[j - 1]! : Infinity);
  }
  return { untilNext, sinceLast };
}

/**
 * Run the book over return days [from, to]. State (high-water mark, stop) is
 * fresh at `from`; indicators may use any history before it.
 */
export function runTiger(
  panel: Panel,
  events: readonly PanelEvent[],
  p: TigerParams,
  range: RunRange,
  initial: BookState = FRESH_BOOK,
): StrategyRun {
  const { from, to } = range;
  if (from < 1 || to >= panel.dates.length || from > to) {
    throw new Error(`runTiger: bad range ${from}..${to} for ${panel.dates.length} days`);
  }
  const L = panel.primary;
  const px = panel.px[L]!;
  const rL = panel.ret[L]!;
  const H = p.hedgeSymbol;
  if (H && !panel.px[H]) throw new Error(`runTiger: hedge ${H} not in panel`);
  const rH = H ? panel.ret[H]! : null;
  const n = panel.dates.length;
  const vol = p.volTarget !== null ? cached(panel, `vol:${L}:${p.volLookback}`, () => trailingVolSeries(rL, p.volLookback)) : null;
  const sma = p.trendLookback !== null ? cached(panel, `sma:${L}:${p.trendLookback}`, () => smaSeries(px, p.trendLookback!)) : null;
  const beta =
    H && p.hedgeRatio > 0 ? cached(panel, `beta:${L}:${H}:${p.betaLookback}`, () => betaSeries(rL, rH!, p.betaLookback)) : null;
  const evKey = `ev:${p.announceLead}:${events.map((e) => e.t).join(",")}`;
  const until = cached(panel, `${evKey}:next`, () => eventDistances(n, events, p.announceLead).untilNext);
  const since = cached(panel, `${evKey}:last`, () => eventDistances(n, events, p.announceLead).sinceLast);

  const out: StrategyRun = {
    dates: [],
    ret: [],
    rf: [],
    wLong: [],
    wHedge: [],
    events: [],
    exposure: 0,
    turnover: 0,
    costs: 0,
    traded: 0,
    state: initial,
  };
  let { nav, hwm, stopped, stopT, cut, prevL, prevH } = initial;
  let turnover = 0;

  // Decide at close of t = from-1 … to-1; earn on t+1.
  for (let t = from - 1; t < to; t++) {
    /* ---- gates, using data ≤ t only ---- */
    let w = p.baseWeight;

    if (vol) {
      const v = vol[t]!;
      if (Number.isFinite(v) && v > 0) w *= p.volTarget! / (v * Math.sqrt(252));
    }

    let trendOk = true;
    if (sma) {
      const m = sma[t]!;
      if (Number.isFinite(m)) trendOk = px[t]! >= m;
      if (!trendOk) w *= p.trendFloor;
    }

    // Ahead of a public, scheduled print (holding at close t means holding INTO t+1).
    if (p.preEventDays > 0 && until[t]! <= p.preEventDays) w *= p.preEventMult;
    // In the days after a print (a print at e is "post" for closes t ∈ [e, e+post)).
    if (p.postEventDays > 0 && since[t]! < p.postEventDays) w *= p.postEventMult;

    /* ---- drawdown ladder on the book's own NAV (through t) ---- */
    const dd = 1 - nav / hwm;
    if (stopped) {
      if (t - stopT >= p.reentryDays && trendOk) {
        stopped = false;
        hwm = nav; // re-underwrite: the ladder restarts from here
        out.events.push({ t, date: panel.dates[t]!, kind: "REUNDERWRITE", detail: `re-entered after ${t - stopT} days flat` });
      }
    } else if (p.ddStop !== null && dd >= p.ddStop) {
      stopped = true;
      stopT = t;
      out.events.push({ t, date: panel.dates[t]!, kind: "STOP_OUT", detail: `drawdown ${(dd * 100).toFixed(1)}% ≥ ${(p.ddStop * 100).toFixed(0)}% → flat, mandate revoked` });
    }
    if (stopped) {
      cut = false; // a stop supersedes the cut rung; no "recovered" event
    } else {
      const nowCut = p.ddCut !== null && 1 - nav / hwm >= p.ddCut;
      if (nowCut !== cut) {
        out.events.push({
          t,
          date: panel.dates[t]!,
          kind: nowCut ? "CUT" : "UNCUT",
          detail: nowCut ? `drawdown ≥ ${(p.ddCut! * 100).toFixed(0)}% → ×${p.cutFactor}` : "recovered above the cut level",
        });
        cut = nowCut;
      }
    }
    if (stopped) w = 0;
    else if (cut) w *= p.cutFactor;

    let wL = Math.max(0, w);
    let wH = 0;
    if (beta && wL > 0) {
      const b = beta[t]!;
      if (Number.isFinite(b)) wH = -p.hedgeRatio * Math.min(3, Math.max(0, b)) * wL;
    }
    const gross = wL + Math.abs(wH);
    if (gross > p.maxGross) {
      const s = p.maxGross / gross;
      wL *= s;
      wH *= s;
    }

    /* ---- earn on t+1, net of costs ---- */
    const d = t + 1;
    const tradeL = Math.abs(wL - prevL);
    const tradeH = Math.abs(wH - prevH);
    const cost =
      (tradeL * p.costBps + tradeH * p.hedgeCostBps) / 1e4 +
      (Math.abs(wH) * p.borrowRate) / 252 +
      (Math.max(0, wL - 1) * p.financingRate) / 252;
    // Uninvested capital earns the risk-free rate, and so do the proceeds of
    // the short hedge (borrowRate is the fee charged over that rebate).
    const rfd = panel.rf[d] ?? 0;
    const cash = Math.max(0, 1 - wL) * rfd + Math.abs(wH) * rfd;
    const r = wL * rL[d]! + (rH ? wH * rH[d]! : 0) + cash - cost;
    nav *= 1 + r;
    if (nav > hwm) hwm = nav;
    turnover += tradeL;
    out.costs += cost;
    out.dates.push(panel.dates[d]!);
    out.ret.push(r);
    out.rf.push(panel.rf[d] ?? 0);
    out.wLong.push(wL);
    out.wHedge.push(wH);
    // Weights drift with prices: tomorrow's trade is measured from here, so
    // holding a constant target weight pays its real rebalancing cost.
    const g = 1 + r;
    prevL = g > 0 ? (wL * (1 + rL[d]!)) / g : 0;
    prevH = g > 0 && rH ? (wH * (1 + rH[d]!)) / g : 0;
  }

  const days = out.ret.length;
  out.exposure = out.wLong.reduce((a, b) => a + b, 0) / days;
  out.turnover = (turnover / days) * 252;
  out.traded = turnover;
  out.state = { nav, hwm, stopped, stopT, cut, prevL, prevH };
  return out;
}
