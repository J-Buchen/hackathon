/**
 * Small numeric toolkit for the center book: moments, risk-adjusted returns,
 * drawdowns, correlation and position similarity. Plain `number[]` in, plain
 * numbers out — no allocation-heavy matrix library.
 */

/** Trading periods per year used to annualize (daily bars). */
export const PERIODS_PER_YEAR = 252;

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). 0 for fewer than two observations. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** Annualized Sharpe ratio (zero risk-free rate). 0 when volatility is 0. */
export function sharpe(returns: readonly number[]): number {
  const sd = stdev(returns);
  return sd === 0 ? 0 : (mean(returns) / sd) * Math.sqrt(PERIODS_PER_YEAR);
}

/** Annualized volatility. */
export function annualVol(returns: readonly number[]): number {
  return stdev(returns) * Math.sqrt(PERIODS_PER_YEAR);
}

/** Compound a return series into an equity curve starting at 1. */
export function equityCurve(returns: readonly number[]): number[] {
  const out: number[] = [];
  let e = 1;
  for (const r of returns) {
    e *= 1 + r;
    out.push(e);
  }
  return out;
}

/** Maximum peak-to-trough drawdown of a return series, as a positive fraction. */
export function maxDrawdown(returns: readonly number[]): number {
  let e = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    e *= 1 + r;
    if (e > peak) peak = e;
    const dd = 1 - e / peak;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** Drawdown from the high-water mark at the END of the series. */
export function currentDrawdown(returns: readonly number[]): number {
  let e = 1;
  let peak = 1;
  for (const r of returns) {
    e *= 1 + r;
    if (e > peak) peak = e;
  }
  return 1 - e / peak;
}

/**
 * True when the LAST return lifts the equity curve strictly above every
 * earlier point, the starting value of 1 included: the series is at a new
 * high-water mark it has just earned. A flat tick at an old peak is not one.
 */
export function isNewHigh(returns: readonly number[]): boolean {
  if (returns.length === 0) return false;
  let e = 1;
  let peak = 1;
  for (let i = 0; i < returns.length - 1; i++) {
    e *= 1 + returns[i]!;
    if (e > peak) peak = e;
  }
  return e * (1 + returns[returns.length - 1]!) > peak;
}

/**
 * Annualized volatility of the last `window` returns up to and including the
 * series' most recent high-water mark: the risk it was running when its record
 * was last at its best. Losses since that peak are excluded, so a drawdown can
 * never inflate the yardstick it is measured against. 0 when the series has
 * never been above its starting value (no record, no measured risk).
 */
export function volAtHighWater(returns: readonly number[], window: number): number {
  let e = 1;
  let peak = 1;
  let upTo = 0;
  returns.forEach((r, i) => {
    e *= 1 + r;
    if (e >= peak) {
      peak = e;
      upTo = i + 1;
    }
  });
  return annualVol(returns.slice(Math.max(0, upTo - window), upTo));
}

/** Pearson correlation of two equal-length series. 0 if either is flat. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}

/** Full correlation matrix of a list of series (symmetric, unit diagonal). */
export function correlationMatrix(series: readonly (readonly number[])[]): number[][] {
  const n = series.length;
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = correlation(series[i]!, series[j]!);
      m[i]![j] = c;
      m[j]![i] = c;
    }
  }
  return m;
}

/**
 * Cosine similarity of two position vectors keyed by instrument. Two agents
 * holding the same trade in the same direction score ~1 regardless of size;
 * opposite trades score ~-1; disjoint books score 0.
 */
export function cosineSimilarity(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of Object.entries(a)) {
    na += v * v;
    const w = b[k];
    if (w !== undefined) dot += v * w;
  }
  for (const v of Object.values(b)) nb += v * v;
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Gross exposure: sum of absolute weights/notionals. */
export function gross(w: Readonly<Record<string, number>>): number {
  let s = 0;
  for (const v of Object.values(w)) s += Math.abs(v);
  return s;
}
