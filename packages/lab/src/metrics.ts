/**
 * Performance and overfitting statistics.
 *
 * The point of this file is to make "the Sharpe went up" falsifiable:
 *
 *  - PSR   Probabilistic Sharpe Ratio (Bailey & López de Prado, 2012): the
 *          probability that the true Sharpe exceeds a benchmark, given the
 *          sample length and the returns' skew and fat tails.
 *  - DSR   Deflated Sharpe Ratio (Bailey & López de Prado, 2014): PSR against
 *          the Sharpe you would expect from the BEST of N unskilled trials.
 *          Trying 5,000 parameter combinations and reporting the winner is
 *          exactly the situation it corrects for.
 *  - PBO   Probability of Backtest Overfitting via combinatorially symmetric
 *          cross-validation (Bailey, Borwein, López de Prado, Zhu, 2016): how
 *          often the in-sample winner lands in the bottom half out of sample.
 *  - Paired stationary-bootstrap CI for the Sharpe DIFFERENCE between a
 *          strategy and its benchmark on the same days.
 *
 * Per-period (daily) Sharpe is used inside PSR/DSR, as in the papers;
 * annualized figures are for reporting.
 */

import { mulberry32 } from "@allowance/swarm";

export const TRADING_DAYS = 252;
const EULER_GAMMA = 0.5772156649015329;

/* ------------------------------------------------------------------ */
/* Normal distribution                                                */
/* ------------------------------------------------------------------ */

/** Standard normal CDF via the Numerical Recipes erfc approximation (relative error < 1.2e-7). */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

function erfc(x: number): number {
  // Numerical Recipes erfc (Chebyshev), relative error < 1.2e-7 everywhere.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Inverse standard normal CDF (Acklam's algorithm, relative error < 1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/* ------------------------------------------------------------------ */
/* Moments                                                            */
/* ------------------------------------------------------------------ */

export interface Moments {
  n: number;
  mean: number;
  sd: number; // sample (n-1)
  skew: number; // population skewness
  kurt: number; // population kurtosis, NOT excess (normal = 3)
}

export function moments(xs: readonly number[]): Moments {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, sd: 0, skew: 0, kurt: 3 };
  let s = 0;
  for (const x of xs) s += x;
  const mean = s / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const var_p = m2 / n;
  const sd = Math.sqrt(m2 / (n - 1));
  const skew = var_p === 0 ? 0 : m3 / n / var_p ** 1.5;
  const kurt = var_p === 0 ? 3 : m4 / n / (var_p * var_p);
  return { n, mean, sd, skew, kurt };
}

/* ------------------------------------------------------------------ */
/* Performance summary                                                */
/* ------------------------------------------------------------------ */

export interface Performance {
  days: number;
  totalReturn: number;
  cagr: number;
  annVol: number;
  /** Annualized Sharpe (zero risk-free rate; see report caveats). */
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  calmar: number;
  /** Fraction of up days among days with a non-zero return. */
  hitRate: number;
  skew: number;
  kurt: number;
}

/**
 * Summary statistics. Return/drawdown figures use `ret`; Sharpe and Sortino use
 * excess returns `ret − rf` when a risk-free series is given.
 */
export function performance(ret: readonly number[], rf?: readonly number[]): Performance {
  const ex = rf ? ret.map((r, i) => r - (rf[i] ?? 0)) : ret;
  const m = moments(ex);
  let nav = 1;
  let peak = 1;
  let mdd = 0;
  let downSq = 0;
  let up = 0;
  let active = 0;
  for (let i = 0; i < ret.length; i++) {
    const r = ret[i]!;
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    mdd = Math.max(mdd, 1 - nav / peak);
    const x = ex[i]!;
    if (x < 0) downSq += x * x;
    // Hit rate on EXCESS returns: a day in cash earns exactly rf, so it is
    // neither a win nor a loss.
    if (x !== 0) {
      active++;
      if (x > 0) up++;
    }
  }
  const years = ret.length / TRADING_DAYS;
  const cagr = years > 0 && nav > 0 ? nav ** (1 / years) - 1 : 0;
  const downDev = Math.sqrt(downSq / Math.max(1, ret.length));
  return {
    days: ret.length,
    totalReturn: nav - 1,
    cagr,
    annVol: m.sd * Math.sqrt(TRADING_DAYS),
    sharpe: m.sd === 0 ? 0 : (m.mean / m.sd) * Math.sqrt(TRADING_DAYS),
    sortino: downDev === 0 ? 0 : (m.mean / downDev) * Math.sqrt(TRADING_DAYS),
    maxDrawdown: mdd,
    calmar: mdd === 0 ? 0 : cagr / mdd,
    hitRate: active === 0 ? 0 : up / active,
    skew: m.skew,
    kurt: m.kurt,
  };
}

/** Per-period (non-annualized) Sharpe. */
export function periodSharpe(ret: readonly number[]): number {
  const m = moments(ret);
  return m.sd === 0 ? 0 : m.mean / m.sd;
}

/* ------------------------------------------------------------------ */
/* PSR / DSR                                                          */
/* ------------------------------------------------------------------ */

/**
 * Probabilistic Sharpe Ratio: P(true per-period SR > benchmarkSR).
 * PSR = Φ( (SR̂ − SR*)·√(T−1) / √(1 − γ₃·SR̂ + (γ₄−1)/4·SR̂²) )
 */
export function probabilisticSharpe(ret: readonly number[], benchmarkPeriodSR = 0): number {
  const m = moments(ret);
  if (m.sd === 0 || m.n < 3) return 0.5;
  const sr = m.mean / m.sd;
  const denom = 1 - m.skew * sr + ((m.kurt - 1) / 4) * sr * sr;
  if (denom <= 0) return sr > benchmarkPeriodSR ? 1 : 0;
  return normCdf(((sr - benchmarkPeriodSR) * Math.sqrt(m.n - 1)) / Math.sqrt(denom));
}

/**
 * Expected maximum per-period Sharpe among N unskilled trials whose Sharpe
 * estimates have variance `trialSRVariance`:
 * SR₀ = √V · ((1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)))
 */
export function expectedMaxSharpe(trials: number, trialSRVariance: number): number {
  if (trials < 2 || trialSRVariance <= 0) return 0;
  return (
    Math.sqrt(trialSRVariance) *
    ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)))
  );
}

export interface Deflated {
  /** Probability the selected strategy's true Sharpe beats the best-of-N-noise benchmark. */
  dsr: number;
  /** Benchmark per-period Sharpe implied by the number of trials. */
  sr0: number;
  /** Selected strategy's per-period Sharpe. */
  sr: number;
  trials: number;
}

/**
 * Deflated Sharpe Ratio of `selected`, given the per-period Sharpes of ALL
 * trials that were tried (including the selected one).
 */
export function deflatedSharpe(selected: readonly number[], trialPeriodSharpes: readonly number[]): Deflated {
  const n = trialPeriodSharpes.length;
  const vm = moments(trialPeriodSharpes);
  const sr0 = expectedMaxSharpe(n, vm.sd * vm.sd);
  return { dsr: probabilisticSharpe(selected, sr0), sr0, sr: periodSharpe(selected), trials: n };
}

/* ------------------------------------------------------------------ */
/* PBO via CSCV                                                       */
/* ------------------------------------------------------------------ */

export interface PboResult {
  /** Fraction of splits where the IS-best trial ranks at or below the OOS median. */
  pbo: number;
  splits: number;
  /** Mean OOS percentile rank of the IS-best trial (0.5 = coin flip). */
  meanOosRank: number;
}

/**
 * Combinatorially symmetric cross-validation. `trialReturns[k]` is trial k's
 * daily return series over the SAME days. The days are cut into `blocks`
 * contiguous blocks; for every way of choosing half the blocks as in-sample,
 * pick the in-sample best trial and record its out-of-sample rank.
 */
export function probabilityOfOverfitting(trialReturns: readonly (readonly number[])[], blocks = 16): PboResult {
  const N = trialReturns.length;
  if (N < 2) return { pbo: 0, splits: 0, meanOosRank: 1 };
  const T = Math.min(...trialReturns.map((r) => r.length));
  const S = blocks - (blocks % 2);
  const size = Math.floor(T / S);
  if (size < 5) throw new Error(`PBO: ${T} days is too short for ${S} blocks`);
  // Per trial, per block: n, sum, sumsq — so any union of blocks is O(blocks).
  const agg = trialReturns.map((r) =>
    Array.from({ length: S }, (_, b) => {
      let s = 0;
      let q = 0;
      for (let i = b * size; i < (b + 1) * size; i++) {
        s += r[i]!;
        q += r[i]! * r[i]!;
      }
      return { s, q };
    }),
  );
  const sharpeOf = (k: number, set: readonly number[]) => {
    let s = 0;
    let q = 0;
    for (const b of set) {
      s += agg[k]![b]!.s;
      q += agg[k]![b]!.q;
    }
    const n = set.length * size;
    const mean = s / n;
    const v = (q - n * mean * mean) / (n - 1);
    return v <= 0 ? 0 : mean / Math.sqrt(v);
  };
  let below = 0;
  let splits = 0;
  let rankSum = 0;
  const all = Array.from({ length: S }, (_, i) => i);
  const half = S / 2;
  const combo: number[] = [];
  const visit = (start: number) => {
    if (combo.length === half) {
      // Symmetric: only enumerate combos containing block 0 would halve work,
      // but both halves are distinct IS/OOS assignments, so enumerate all.
      const is = [...combo];
      const oos = all.filter((b) => !is.includes(b));
      let best = 0;
      let bestSr = -Infinity;
      for (let k = 0; k < N; k++) {
        const sr = sharpeOf(k, is);
        if (sr > bestSr) {
          bestSr = sr;
          best = k;
        }
      }
      const oosSr = Array.from({ length: N }, (_, k) => sharpeOf(k, oos));
      const target = oosSr[best]!;
      let lower = 0;
      for (const x of oosSr) if (x < target) lower++;
      const omega = (lower + 1) / (N + 1); // relative rank in (0,1)
      rankSum += omega;
      if (omega <= 0.5) below++;
      splits++;
      return;
    }
    for (let b = start; b < S; b++) {
      combo.push(b);
      visit(b + 1);
      combo.pop();
    }
  };
  visit(0);
  return { pbo: below / splits, splits, meanOosRank: rankSum / splits };
}

/* ------------------------------------------------------------------ */
/* Stationary bootstrap                                               */
/* ------------------------------------------------------------------ */

/**
 * Politis–Romano stationary bootstrap: index sequence of length `n` over a
 * source of length `len`, with geometric block lengths of mean `meanBlock`.
 * Preserves short-range autocorrelation and cross-asset co-movement when the
 * same indices are applied to every series.
 */
export function stationaryBootstrapIndices(len: number, n: number, meanBlock: number, rand: () => number): number[] {
  const p = 1 / Math.max(1, meanBlock);
  const out: number[] = [];
  let i = Math.floor(rand() * len);
  for (let k = 0; k < n; k++) {
    if (k > 0) i = rand() < p ? Math.floor(rand() * len) : (i + 1) % len;
    out.push(i);
  }
  return out;
}

export interface DiffCI {
  /** Annualized Sharpe(strategy) − Sharpe(benchmark) on the actual sample. */
  diff: number;
  /** Studentized (bootstrap-t) interval for the annualized difference. */
  lo: number;
  hi: number;
  /** 1 − the one-sided bootstrap-t p-value for "difference ≤ 0". */
  pPositive: number;
  /** Jobson–Korkie/Memmel standard error of the annualized difference. */
  se: number;
  samples: number;
}

/**
 * Jobson–Korkie variance of a per-period Sharpe difference with Memmel's (2003)
 * correction: Var = [2 − 2ρ + ½(SRa² + SRb² − 2·SRa·SRb·ρ²)] / T.
 */
export function sharpeDiffSE(a: readonly number[], b: readonly number[]): { diff: number; se: number } {
  const n = Math.min(a.length, b.length);
  const ma = moments(a.slice(0, n));
  const mb = moments(b.slice(0, n));
  const sa = ma.sd === 0 ? 0 : ma.mean / ma.sd;
  const sb = mb.sd === 0 ? 0 : mb.mean / mb.sd;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[i]! - ma.mean) * (b[i]! - mb.mean);
  cov /= n - 1;
  const rho = ma.sd === 0 || mb.sd === 0 ? 0 : cov / (ma.sd * mb.sd);
  const v = (2 - 2 * rho + 0.5 * (sa * sa + sb * sb - 2 * sa * sb * rho * rho)) / n;
  return { diff: sa - sb, se: Math.sqrt(Math.max(v, 1e-18)) };
}

/**
 * Paired confidence interval for a Sharpe difference: stationary block
 * bootstrap of the paired days, STUDENTIZED with the Memmel standard error
 * (bootstrap-t, in the spirit of Ledoit & Wolf 2008). The plain percentile
 * interval under-covers at holdout-sized samples; this one does not rely on
 * the bootstrap distribution being centred.
 */
export function sharpeDifferenceCI(
  strat: readonly number[],
  bench: readonly number[],
  opts: { samples?: number; meanBlock?: number; seed?: number; level?: number } = {},
): DiffCI {
  const n = Math.min(strat.length, bench.length);
  const samples = opts.samples ?? 2000;
  const rand = mulberry32(opts.seed ?? 12345);
  const ann = Math.sqrt(TRADING_DAYS);
  const hat = sharpeDiffSE(strat.slice(0, n), bench.slice(0, n));
  const ts: number[] = [];
  const a = new Array<number>(n);
  const b = new Array<number>(n);
  for (let s = 0; s < samples; s++) {
    const idx = stationaryBootstrapIndices(n, n, opts.meanBlock ?? 20, rand);
    for (let k = 0; k < n; k++) {
      a[k] = strat[idx[k]!]!;
      b[k] = bench[idx[k]!]!;
    }
    const star = sharpeDiffSE(a, b);
    ts.push((star.diff - hat.diff) / star.se);
  }
  ts.sort((x, y) => x - y);
  const level = opts.level ?? 0.9;
  const q = (p: number) => ts[Math.min(ts.length - 1, Math.max(0, Math.floor(p * ts.length)))]!;
  const tObs = hat.diff / hat.se;
  // One-sided p-value for H0: diff ≤ 0 is P(T* ≥ tObs) under the bootstrap law of T.
  const pValue = ts.filter((t) => t >= tObs).length / ts.length;
  return {
    diff: hat.diff * ann,
    lo: (hat.diff - q(1 - (1 - level) / 2) * hat.se) * ann,
    hi: (hat.diff - q((1 - level) / 2) * hat.se) * ann,
    pPositive: 1 - pValue,
    se: hat.se * ann,
    samples,
  };
}
