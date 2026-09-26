/**
 * The worked example's result, stated from the snapshot's multi-seed sweep
 * (swarm-snapshot.json `sweep`: means over simulated market seeds, center book
 * vs per-agent guardrails). Pure, so it is unit tested (../worked-example.test.ts)
 * and the words can never drift from the numbers.
 */

import type { BookSummary, SweepView } from "./types";

export type Tone = "good" | "bad" | "even";

export interface VerdictItem {
  key: "maxDrawdown" | "crashWindowReturn" | "sharpe" | "totalReturn";
  label: string;
  /** "Lower", "Smaller loss", "About equal", … relative to per-agent guardrails. */
  word: string;
  tone: Tone;
  center: string;
  guardrails: string;
}

export interface WorkedVerdict {
  seeds: number;
  items: VerdictItem[];
}

const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
const signedPct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)}%`;

/**
 * Differences smaller than these read "about equal": 0.1 pp for the return and
 * drawdown measures, 0.05 for Sharpe (a 20-seed mean moves more than that on
 * noise alone).
 */
export const TOLERANCE = { maxDrawdown: 0.001, crashWindowReturn: 0.001, sharpe: 0.05, totalReturn: 0.001 } as const;

function compare(center: number, guardrails: number, tol: number, higherIsBetter: boolean): Tone {
  if (Math.abs(center - guardrails) < tol) return "even";
  return center > guardrails === higherIsBetter ? "good" : "bad";
}

export function workedExampleVerdict(sweep: SweepView): WorkedVerdict {
  const c: BookSummary = sweep.centerMean;
  const g: BookSummary = sweep.naiveMean;

  const dd = compare(c.maxDrawdown, g.maxDrawdown, TOLERANCE.maxDrawdown, false);
  const unwind = compare(c.crashWindowReturn, g.crashWindowReturn, TOLERANCE.crashWindowReturn, true);
  const sharpe = compare(c.sharpe, g.sharpe, TOLERANCE.sharpe, true);
  const ret = compare(c.totalReturn, g.totalReturn, TOLERANCE.totalReturn, true);
  const losses = c.crashWindowReturn < 0 && g.crashWindowReturn < 0;

  return {
    seeds: sweep.seeds,
    items: [
      {
        key: "maxDrawdown",
        label: "Max drawdown",
        word: dd === "even" ? "About equal" : dd === "good" ? "Lower" : "Higher",
        tone: dd,
        center: pct(c.maxDrawdown),
        guardrails: pct(g.maxDrawdown),
      },
      {
        key: "crashWindowReturn",
        label: "Loss in the unwind",
        word:
          unwind === "even" ? "About equal" : unwind === "good" ? (losses ? "Smaller loss" : "Better") : losses ? "Bigger loss" : "Worse",
        tone: unwind,
        center: signedPct(c.crashWindowReturn),
        guardrails: signedPct(g.crashWindowReturn),
      },
      {
        key: "sharpe",
        label: "Sharpe",
        word: sharpe === "even" ? "About equal" : sharpe === "good" ? "Higher" : "Lower",
        tone: sharpe,
        center: c.sharpe.toFixed(2),
        guardrails: g.sharpe.toFixed(2),
      },
      {
        key: "totalReturn",
        label: "Total return",
        word: ret === "even" ? "About equal" : ret === "good" ? "Higher" : "Lower",
        tone: ret,
        center: signedPct(c.totalReturn),
        guardrails: signedPct(g.totalReturn),
      },
    ],
  };
}
