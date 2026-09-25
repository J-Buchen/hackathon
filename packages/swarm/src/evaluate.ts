/**
 * Head-to-head: the center book vs. per-agent guardrails only, on identical
 * markets. Everything the two books share — agents, gate, leverage, initial
 * capital, stop-loss — is held fixed; the only difference is whether anything
 * looks ACROSS the agents.
 */

import {
  defaultCenterBookPolicy,
  defaultNaivePolicy,
  type CenterBookPolicy,
  type NaivePolicy,
} from "./allocator";
import { runBook, type BookResult, type SwarmSpec } from "./book";
import { generateMarket, type Market, type MarketConfig } from "./market";
import { maxDrawdown, sharpe } from "./stats";
import { defaultMarketConfig, defaultSwarm, type ExampleOptions } from "./swarm";

export interface BookSummary {
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
  /** Book return from the tick before the crash through the aftershock. */
  crashWindowReturn: number;
  /** Peak exposure to the crowded instrument, share of NAV. */
  peakCrowdExposure: number;
  stopOuts: number;
}

export function summarize(book: BookResult, market: Market): BookSummary {
  const { crashTick } = market.config.crowd;
  const first = book.nav[crashTick - 1] ?? book.startNav;
  const last = book.nav[Math.min(crashTick + 3, book.nav.length - 1)]!;
  return {
    totalReturn: book.nav.at(-1)! / book.startNav - 1,
    sharpe: sharpe(book.returns),
    maxDrawdown: maxDrawdown(book.returns),
    crashWindowReturn: last / first - 1,
    peakCrowdExposure: Math.max(...book.crowdExposure.map(Math.abs)),
    stopOuts: book.decisions.filter((d) => d.kind === "STOP_OUT").length,
  };
}

export function meanSummary(xs: readonly BookSummary[]): BookSummary {
  const avg = (f: (b: BookSummary) => number) => xs.reduce((a, b) => a + f(b), 0) / Math.max(1, xs.length);
  return {
    totalReturn: avg((b) => b.totalReturn),
    sharpe: avg((b) => b.sharpe),
    maxDrawdown: avg((b) => b.maxDrawdown),
    crashWindowReturn: avg((b) => b.crashWindowReturn),
    peakCrowdExposure: avg((b) => b.peakCrowdExposure),
    stopOuts: avg((b) => b.stopOuts),
  };
}

export interface HeadToHead {
  market: Market;
  naive: BookResult;
  center: BookResult;
  naiveSummary: BookSummary;
  centerSummary: BookSummary;
}

export async function headToHead(
  marketConfig: MarketConfig = defaultMarketConfig(),
  swarm: (seed: number) => SwarmSpec = defaultSwarm,
  policies: { naive?: NaivePolicy; center?: CenterBookPolicy } = {},
): Promise<HeadToHead> {
  const market = generateMarket(marketConfig);
  // Fresh agent instances per book: strategies may hold state (e.g. an RNG).
  const naive = await runBook(market, swarm(marketConfig.seed), policies.naive ?? defaultNaivePolicy());
  const center = await runBook(market, swarm(marketConfig.seed), policies.center ?? defaultCenterBookPolicy());
  return {
    market,
    naive,
    center,
    naiveSummary: summarize(naive, market),
    centerSummary: summarize(center, market),
  };
}

export interface SeedSweep {
  seeds: number[];
  naive: BookSummary[];
  center: BookSummary[];
  /** Mean of each summary field across seeds. */
  naiveMean: BookSummary;
  centerMean: BookSummary;
  /** Seeds on which the center book had the smaller max drawdown. */
  centerWinsDrawdown: number;
  /** Seeds on which the center book had the higher Sharpe. */
  centerWinsSharpe: number;
}

/**
 * Run the head-to-head across many seeds so one lucky path can't carry the
 * claim. `example` switches the example's assumptions, e.g. `{ assumeEdge: false }`
 * to check the result doesn't depend on the thesis being right.
 */
export async function sweepSeeds(seeds: number[], example: ExampleOptions = {}): Promise<SeedSweep> {
  const naive: BookSummary[] = [];
  const center: BookSummary[] = [];
  for (const seed of seeds) {
    const h = await headToHead(defaultMarketConfig(seed, example), (s) => defaultSwarm(s, example));
    naive.push(h.naiveSummary);
    center.push(h.centerSummary);
  }
  return {
    seeds,
    naive,
    center,
    naiveMean: meanSummary(naive),
    centerMean: meanSummary(center),
    centerWinsDrawdown: seeds.filter((_, i) => center[i]!.maxDrawdown < naive[i]!.maxDrawdown).length,
    centerWinsSharpe: seeds.filter((_, i) => center[i]!.sharpe > naive[i]!.sharpe).length,
  };
}

export interface AblationRow {
  variant: string;
  description: string;
  meanMaxDrawdown: number;
  meanSharpe: number;
  meanCrashWindowReturn: number;
  meanTotalReturn: number;
}

/**
 * Which part of the center book earns its keep? Switch components off one at a
 * time across the same seeds. Reported as-is — including when a component
 * doesn't help on this market.
 */
export async function ablation(seeds: number[]): Promise<AblationRow[]> {
  const off = 1e9;
  const variants: { variant: string; description: string; naive?: true; patch?: Partial<CenterBookPolicy> }[] = [
    { variant: "per-agent guardrails", description: "equal capital, gate + stop-loss only", naive: true },
    { variant: "center book", description: "everything on" },
    { variant: "− crowding", description: "score-based allocation + ladder, no crowding limits", patch: { crowdMaxShare: off, bookMaxShare: off } },
    { variant: "− drawdown cut", description: "no cut rung (stop-out kept)", patch: { ddCut: off } },
    { variant: "− risk-scaled ladder", description: "drawdown rungs at fixed percentages, whatever vol the agent runs", patch: { ddStopVol: 0 } },
    { variant: "crowding only", description: "equal weight + crowding limits, no scoring, no cut", patch: { warmup: off, ddCut: off } },
  ];
  const rows: AblationRow[] = [];
  for (const v of variants) {
    const s: BookSummary[] = [];
    for (const seed of seeds) {
      const h = await headToHead(defaultMarketConfig(seed), defaultSwarm, {
        center: { ...defaultCenterBookPolicy(), ...v.patch },
      });
      s.push(v.naive ? h.naiveSummary : h.centerSummary);
    }
    const avg = (f: (b: BookSummary) => number) => s.reduce((a, b) => a + f(b), 0) / s.length;
    rows.push({
      variant: v.variant,
      description: v.description,
      meanMaxDrawdown: avg((b) => b.maxDrawdown),
      meanSharpe: avg((b) => b.sharpe),
      meanCrashWindowReturn: avg((b) => b.crashWindowReturn),
      meanTotalReturn: avg((b) => b.totalReturn),
    });
  }
  return rows;
}
