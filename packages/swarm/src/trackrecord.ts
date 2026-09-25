/**
 * Per-agent attributable track records — the dataset a real-capital agent
 * allocator produces and a paper leaderboard can't: risk-adjusted returns per
 * unit of capital, drawdowns, how much of each agent is really someone else's
 * bet, and what it actually earned with the capital it was given.
 */

import type { BookResult } from "./book";
import { annualVol, correlation, maxDrawdown, mean, sharpe } from "./stats";

export interface TrackRecord {
  agent: string;
  pod: string;
  style: string;
  status: "active" | "cut" | "stopped";
  /** Ticks with capital > 0. */
  liveTicks: number;
  sharpe: number;
  annualVol: number;
  maxDrawdown: number;
  /** Correlation of the agent's unit returns to the book's returns. */
  corrToBook: number;
  /** Highest return correlation to any other agent, and who. */
  closestTwin: { agent: string; corr: number } | null;
  /** Realized PnL with real allocated capital (USDC). */
  pnl: number;
  /** Average capital run (USDC). */
  avgCapital: number;
  gateViolations: number;
}

export function trackRecords(book: BookResult): TrackRecord[] {
  return book.agents.map((a) => {
    let twin: TrackRecord["closestTwin"] = null;
    for (const b of book.agents) {
      if (b === a) continue;
      const c = correlation(a.unitReturns, b.unitReturns);
      if (twin === null || c > twin.corr) twin = { agent: b.label, corr: c };
    }
    return {
      agent: a.label,
      pod: a.pod,
      style: a.style,
      status: a.ladder,
      liveTicks: a.capital.filter((c) => c > 0).length,
      sharpe: sharpe(a.unitReturns),
      annualVol: annualVol(a.unitReturns),
      maxDrawdown: maxDrawdown(a.unitReturns),
      corrToBook: correlation(a.unitReturns, book.returns),
      closestTwin: twin,
      pnl: a.pnl.reduce((s, x) => s + x, 0),
      avgCapital: mean(a.capital),
      gateViolations: a.gateViolations,
    };
  });
}
