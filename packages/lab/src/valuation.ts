/**
 * From thesis to position size: a scenario tree over the pitch's own numbers,
 * then Kelly sizing against the stock's REAL realized volatility.
 *
 * Each scenario values Luckin one year out at (next-year non-GAAP net profit)
 * × (a P/E multiple). The probabilities are JUDGEMENT and are inputs; the
 * report shows how the answer moves with them rather than hiding them.
 *
 * Kelly for a continuous return with mean μ and variance σ²: f* = (μ − r_f)/σ².
 * Full Kelly is famously too aggressive with estimated inputs; the Tiger habit
 * of concentrated-but-survivable sizing maps better to half Kelly, capped.
 */

import { LUCKIN_MODEL } from "./thesis";

export interface Scenario {
  name: string;
  prob: number;
  /** Non-GAAP net profit one year out, RMB millions. */
  netProfitRmbMm: number;
  multiple: number;
  note: string;
}

export interface ValuationInputs {
  /** Current market value, USD millions. */
  marketCapUsdMm: number;
  usdCny: number;
  scenarios: Scenario[];
}

export interface ScenarioValue extends Scenario {
  impliedCapUsdMm: number;
  return: number;
}

export interface Valuation {
  scenarios: ScenarioValue[];
  expectedReturn: number;
  /** Probability-weighted return in the scenarios that lose money. */
  downside: number;
  probLoss: number;
}

export function valueScenarios(v: ValuationInputs): Valuation {
  const total = v.scenarios.reduce((a, s) => a + s.prob, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error(`scenario probabilities sum to ${total}, not 1`);
  const scenarios = v.scenarios.map((s) => {
    const impliedCapUsdMm = (s.netProfitRmbMm * s.multiple) / v.usdCny;
    return { ...s, impliedCapUsdMm, return: impliedCapUsdMm / v.marketCapUsdMm - 1 };
  });
  const expectedReturn = scenarios.reduce((a, s) => a + s.prob * s.return, 0);
  const losers = scenarios.filter((s) => s.return < 0);
  return {
    scenarios,
    expectedReturn,
    downside: losers.reduce((a, s) => a + s.prob * s.return, 0),
    probLoss: losers.reduce((a, s) => a + s.prob, 0),
  };
}

/**
 * Default scenario tree, valued on 2027E (the next-twelve-months earnings a
 * year from now). Bear and Street use the Street column; the two pitch cases
 * use the pitch's column. Probabilities are a deliberately skeptical starting
 * point: the pitch case needs its proprietary data to be right.
 */
export function defaultScenarios(): Scenario[] {
  const street27 = LUCKIN_MODEL.nonGaapNetProfit.street[4];
  const pitch27 = LUCKIN_MODEL.nonGaapNetProfit.pitch[4];
  return [
    { name: "bear", prob: 0.25, netProfitRmbMm: street27 * 0.8, multiple: 10, note: "Street 2027E cut 20% (subsidy war resumes), de-rated to 10x" },
    { name: "street", prob: 0.4, netProfitRmbMm: street27, multiple: 15, note: "Street 2027E at today's ~15x" },
    { name: "pitch", prob: 0.25, netProfitRmbMm: pitch27, multiple: 12, note: "Pitch 2027E, but the market pays only 12x (China/OTC discount persists)" },
    { name: "pitch + rerate", prob: 0.1, netProfitRmbMm: pitch27, multiple: 20, note: "Pitch 2027E at the pitch's 20x 'maturity' multiple" },
  ];
}

export interface KellySizing {
  /** 1-year SIMPLE expected return used. */
  expectedReturn: number;
  /** Annualized volatility of daily LOG returns. */
  annualVol: number;
  /** 1-year simple risk-free rate. */
  riskFree: number;
  /** Continuous Kelly: (ln(1+E[R]) − ln(1+r_f)) / σ². */
  fullKelly: number;
  halfKelly: number;
  /** Half Kelly clipped to [0, cap]. */
  recommended: number;
}

/**
 * Continuous-time Kelly for a lognormal asset. The 1-year SIMPLE expected
 * return E[R] implies an arithmetic drift α = ln(1 + E[R]) (for GBM,
 * E[S_T/S_0] = e^{αT}); the risk-free leg likewise uses ln(1 + r_f).
 */
export function kellySize(expectedReturn: number, annualLogVol: number, riskFree: number, cap = 1): KellySizing {
  const alpha = Math.log(1 + expectedReturn);
  const r = Math.log(1 + riskFree);
  const v = annualLogVol * annualLogVol;
  const fullKelly = v > 0 ? (alpha - r) / v : 0;
  const halfKelly = fullKelly / 2;
  return { expectedReturn, annualVol: annualLogVol, riskFree, fullKelly, halfKelly, recommended: Math.max(0, Math.min(cap, halfKelly)) };
}

/**
 * Discrete Kelly on the scenario tree itself: the fraction f in [0, cap] that
 * maximizes Σ p·ln(1 + r_f + f·(R − r_f)). No lognormal assumption.
 */
export function scenarioKelly(v: Valuation, riskFree: number, cap = 1): { full: number; half: number; recommended: number } {
  let best = 0;
  let bestG = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    const f = (cap * i) / 1000;
    let g = 0;
    let ok = true;
    for (const s of v.scenarios) {
      const w = 1 + riskFree + f * (s.return - riskFree);
      if (w <= 0) {
        ok = false;
        break;
      }
      g += s.prob * Math.log(w);
    }
    if (ok && g > bestG) {
      bestG = g;
      best = f;
    }
  }
  return { full: best, half: best / 2, recommended: best / 2 };
}

/** Expected return as the pitch-case probability moves (the rest keeps its proportions). */
export function sensitivityToPitchProbability(v: ValuationInputs, pitchNames = ["pitch", "pitch + rerate"]): { pPitch: number; expectedReturn: number }[] {
  const pitch = v.scenarios.filter((s) => pitchNames.includes(s.name));
  const rest = v.scenarios.filter((s) => !pitchNames.includes(s.name));
  const pitchTotal = pitch.reduce((a, s) => a + s.prob, 0);
  const restTotal = rest.reduce((a, s) => a + s.prob, 0);
  return [0, 0.1, 0.2, 0.35, 0.5, 0.7].map((pPitch) => {
    const scenarios = [
      ...pitch.map((s) => ({ ...s, prob: pitchTotal ? (s.prob / pitchTotal) * pPitch : pPitch / pitch.length })),
      ...rest.map((s) => ({ ...s, prob: restTotal ? (s.prob / restTotal) * (1 - pPitch) : (1 - pPitch) / rest.length })),
    ];
    return { pPitch, expectedReturn: valueScenarios({ ...v, scenarios }).expectedReturn };
  });
}
