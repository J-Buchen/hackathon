/**
 * The example portfolio: a Tiger-Cub-style multi-manager fund whose PMs are
 * agents.
 *
 *   fund.eth
 *    ├─ consumer.fund.eth      tiger-quality    (weights "good company?" most)
 *    ├─ growth.fund.eth        tiger-management (weights "good management?" most)
 *    ├─ event.fund.eth         tiger-catalyst   (weights "why now?" most) + rogue
 *    ├─ systematic.fund.eth    trend-slow, trend-fast, meanrev
 *    └─ macro.fund.eth         carry, macro-trend, noise
 *
 * The three Tiger Cubs run the same process on the same research (the trend
 * thesis in theses/), each in its own pod with its own emphasis. That is how
 * real Tiger Cubs end up in the same "hotel" names — and it is exactly the
 * crowding the center book exists to catch. The rest of the book is there to
 * give the allocator something to allocate between: skilled-but-noisy
 * systematic agents, a zero-skill agent, and one that ignores its mandate.
 */

import type { SwarmSpec } from "./book";
import { SIM_START, type CatalystEvent, type MarketConfig } from "./market";
import {
  CarryStrategy,
  MeanReversionStrategy,
  NoiseStrategy,
  RogueStrategy,
  TrendStrategy,
} from "./strategies";
import {
  BALANCED_STYLE,
  TigerCubStrategy,
  parseExpected,
  pickTrade,
  dateToTick,
  type PmStyle,
  type TrendThesis,
} from "./tigercub";
import { COFFEE_THESIS } from "./theses/coffee";

/** The non-equity sleeve the systematic and macro PMs trade. */
export const MACRO_INSTRUMENTS = ["GOLD", "UST10Y", "EURUSD", "BTC"];

export const TIGER_STYLES: Record<"quality" | "management" | "catalyst", PmStyle> = {
  quality: { ...BALANCED_STYLE, weights: { company: 0.5, management: 0.25, whyNow: 0.25 } },
  management: { ...BALANCED_STYLE, weights: { company: 0.25, management: 0.5, whyNow: 0.25 } },
  catalyst: { ...BALANCED_STYLE, weights: { company: 0.25, management: 0.25, whyNow: 0.5 } },
};

export interface ExampleOptions {
  thesis?: TrendThesis;
  /**
   * Whether the simulated market rewards the thesis around its catalysts
   * (long's catalysts jump up on average, short's down). ON by default so you
   * can watch the book size a correct-but-crowded idea; OFF gives catalysts
   * variance only. Either way the prices are synthetic — this never tests
   * whether the research is right.
   */
  assumeEdge?: boolean;
  ticks?: number;
}

/** Catalyst jumps for every dated catalyst in the thesis. */
export function thesisEvents(thesis: TrendThesis, ticks: number, assumeEdge: boolean): CatalystEvent[] {
  const idea = pickTrade(thesis);
  const events: CatalystEvent[] = [];
  for (const c of thesis.candidates) {
    const mean = !assumeEdge ? 0 : c.ticker === idea.long?.ticker ? 0.02 : c.ticker === idea.short?.ticker ? -0.015 : 0;
    for (const cat of c.whyNow_q.catalysts) {
      const d = parseExpected(cat.expected);
      if (!d) continue;
      const tick = dateToTick(d, SIM_START);
      if (tick < 0 || tick >= ticks) continue;
      events.push({ instrument: c.ticker, tick, label: `${c.ticker}: ${cat.event}`, mean, vol: 0.04 });
    }
  }
  return events.sort((a, b) => a.tick - b.tick);
}

/**
 * The example market: the thesis's equities plus a macro sleeve. The Tiger
 * Cubs' long is the "hotel": from `startTick` the rest of the market piles in
 * (a run-up that flatters everyone long it), and at `crashTick` it unwinds.
 */
export function defaultMarketConfig(seed = 7, opts: ExampleOptions = {}): MarketConfig {
  const thesis = opts.thesis ?? COFFEE_THESIS;
  const ticks = opts.ticks ?? 260;
  const idea = pickTrade(thesis);
  const equities = thesis.candidates.map((c) => c.ticker);
  const hotel = idea.long?.ticker ?? equities[0]!;
  return {
    seed,
    ticks,
    instruments: [...equities, ...MACRO_INSTRUMENTS],
    factorVol: 0.008,
    idioVol: 0.012,
    crowd: {
      instrument: hotel,
      startTick: 120,
      crashTick: 185,
      inflowDrift: 0.006,
      crashSize: 0.3,
      contagion: 0.08,
    },
    events: thesisEvents(thesis, ticks, opts.assumeEdge ?? true),
  };
}

export function defaultSwarm(seed = 7, opts: ExampleOptions = {}): SwarmSpec {
  const thesis = opts.thesis ?? COFFEE_THESIS;
  const ticks = opts.ticks ?? 260;
  const equities = thesis.candidates.map((c) => c.ticker);
  const all = [...equities, ...MACRO_INSTRUMENTS];
  const cub = (style: PmStyle) => new TigerCubStrategy(thesis, style, SIM_START, ticks);
  return {
    principal: "alice",
    fund: "fund.eth",
    aum: 10_000_000,
    thesis,
    pods: [
      { label: "consumer", instruments: equities },
      { label: "growth", instruments: equities },
      { label: "event", instruments: equities },
      { label: "systematic", instruments: all },
      { label: "macro", instruments: MACRO_INSTRUMENTS },
    ],
    agents: [
      { label: "tiger-quality", pod: "consumer", instruments: equities, strategy: cub(TIGER_STYLES.quality) },
      { label: "tiger-management", pod: "growth", instruments: equities, strategy: cub(TIGER_STYLES.management) },
      { label: "tiger-catalyst", pod: "event", instruments: equities, strategy: cub(TIGER_STYLES.catalyst) },
      // Asks for GOLD (not in its mandate) at 3x gross every tick.
      { label: "rogue", pod: "event", instruments: equities, strategy: new RogueStrategy("GOLD") },
      { label: "trend-slow", pod: "systematic", instruments: all, strategy: new TrendStrategy(40) },
      { label: "trend-fast", pod: "systematic", instruments: all, strategy: new TrendStrategy(10) },
      { label: "meanrev", pod: "systematic", instruments: all, strategy: new MeanReversionStrategy(3) },
      { label: "carry", pod: "macro", instruments: MACRO_INSTRUMENTS, strategy: new CarryStrategy() },
      { label: "macro-trend", pod: "macro", instruments: MACRO_INSTRUMENTS, strategy: new TrendStrategy(30) },
      { label: "noise", pod: "macro", instruments: MACRO_INSTRUMENTS, strategy: new NoiseStrategy(seed * 31 + 1) },
    ],
  };
}

