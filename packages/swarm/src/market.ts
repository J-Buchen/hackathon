/**
 * A deterministic synthetic market for the agent swarm to trade.
 *
 * It is deliberately small but has the structure a multi-manager book has to
 * survive, so every piece of the center book has something real to react to:
 *
 *  - FACTORS. Instruments load on a shared risk-on factor and a rates factor, so
 *    agents that look independent can still be the same bet underneath.
 *  - EXPLOITABLE STRUCTURE. Some instruments trend (autocorrelated drift), some
 *    mean-revert, and each has a carry. Skilled strategies have a small, noisy
 *    edge; noise strategies have none. The allocator has to tell them apart.
 *  - A CROWDED TRADE. From `crowd.startTick` a viral signal ("everyone go long
 *    X") is published. Inflow from the wider agent population pushes X up — so
 *    the agents that follow the signal post great numbers — until
 *    `crowd.crashTick`, when the crowd unwinds all at once: a gap down in X plus
 *    a smaller market-wide liquidation hit. This is the February incident in
 *    miniature: thousands of agents moving in sync, each within its own limits.
 *
 * The market is exogenous (our book is a price-taker). All of it is generated
 * up front from the seed, so two books run on the same seed see identical prices.
 */

import { gaussian, mulberry32 } from "./rng";

export interface CrowdConfig {
  /** The instrument the crowd piles into. */
  instrument: string;
  /** First tick the viral signal is published. */
  startTick: number;
  /** Tick the crowd unwinds. */
  crashTick: number;
  /** Extra per-tick drift in the crowded instrument while the crowd builds. */
  inflowDrift: number;
  /** Size of the gap down on the crash tick (positive fraction, e.g. 0.18). */
  crashSize: number;
  /** Share of the crash transmitted to every other instrument (liquidation contagion). */
  contagion: number;
}

/**
 * A scheduled event on one instrument (earnings, investor day, spin-off…):
 * a jump of `mean ± vol·N(0,1)` on that tick. `mean` is where a thesis edge
 * enters the simulation; leave it 0 for "catalysts add variance, not drift".
 */
export interface CatalystEvent {
  instrument: string;
  tick: number;
  label: string;
  mean: number;
  vol: number;
}

export interface MarketConfig {
  seed: number;
  ticks: number;
  instruments: string[];
  /** Per-tick volatility of the shared risk-on factor. */
  factorVol: number;
  /** Per-tick idiosyncratic volatility. */
  idioVol: number;
  crowd: CrowdConfig;
  /** Scheduled catalyst jumps. */
  events?: CatalystEvent[];
  /** Per-instrument structural overrides (default: derived from the seed). */
  overrides?: Record<string, Partial<{ beta: number; carry: number; trends: boolean }>>;
}

export interface MarketTick {
  t: number;
  /** Realized simple return of each instrument over this tick. */
  returns: Record<string, number>;
  /** Published carry (expected per-tick yield) of each instrument. */
  carry: Record<string, number>;
  /**
   * The viral signal visible BEFORE this tick's return: the instrument the crowd
   * is piling into, or null when there is no crowd.
   */
  viralSignal: string | null;
}

export interface Market {
  config: MarketConfig;
  ticks: MarketTick[];
  instruments: string[];
}

/**
 * Calendar date of tick 0. Ticks are trading days, so dated catalysts from the
 * research map onto the simulated timeline (see tigercub.ts `dateToTick`).
 */
export const SIM_START = new Date(Date.UTC(2026, 8, 25));

/** Instruments of the generic (thesis-free) market, used by tests and sweeps. */
export const GENERIC_INSTRUMENTS = ["ETH", "BTC", "SOL", "GOLD", "UST10Y", "EURUSD", "MEME"];

/**
 * A thesis-free market: crypto + macro, with a crowd piling into MEME. The
 * example Tiger-Cub fund uses `defaultMarketConfig` in swarm.ts instead.
 */
export function genericMarketConfig(seed = 7): MarketConfig {
  return {
    seed,
    ticks: 260,
    instruments: [...GENERIC_INSTRUMENTS],
    factorVol: 0.008,
    idioVol: 0.012,
    crowd: {
      instrument: "MEME",
      startTick: 120,
      crashTick: 185,
      inflowDrift: 0.006,
      crashSize: 0.3,
      contagion: 0.08,
    },
  };
}

/** Per-instrument structural parameters, derived deterministically from the seed. */
interface InstrumentModel {
  beta: number; // risk-on factor loading
  rates: number; // rates factor loading
  trendPersistence: number; // AR(1) coefficient on the latent drift (trend strength)
  reversion: number; // negative autocorrelation of the idiosyncratic shock
  carry: number; // per-tick carry
}

export function generateMarket(config: MarketConfig): Market {
  const u = mulberry32(config.seed);
  const z = gaussian(u);
  const ins = config.instruments;

  const models = new Map<string, InstrumentModel>();
  ins.forEach((name, i) => {
    // Alternate structure across the universe so every strategy style has a
    // home: even-indexed instruments trend, odd-indexed ones mean-revert.
    const o = config.overrides?.[name] ?? {};
    const beta = 0.4 + u() * 0.9;
    const rates = (u() - 0.5) * 1.2;
    const carry = (u() - 0.45) * 0.0006;
    const trends = o.trends ?? i % 2 === 0;
    models.set(name, {
      beta: o.beta ?? beta,
      rates,
      trendPersistence: trends ? 0.95 : 0.5,
      reversion: trends ? 0 : 0.2,
      carry: o.carry ?? carry,
    });
  });

  const drift = new Map<string, number>(ins.map((n) => [n, 0]));
  const lastShock = new Map<string, number>(ins.map((n) => [n, 0]));
  const { crowd } = config;
  const ticks: MarketTick[] = [];
  const eventsAt = new Map<number, CatalystEvent[]>();
  for (const e of config.events ?? []) {
    const list = eventsAt.get(e.tick);
    if (list) list.push(e);
    else eventsAt.set(e.tick, [e]);
  }

  for (let t = 0; t < config.ticks; t++) {
    const riskOn = z() * config.factorVol;
    const rates = z() * config.factorVol * 0.6;
    // The crowd is still all-in on the crash tick itself: it is the unwind that
    // crashes the price, so nobody following the signal gets out first.
    const crowdBuilding = t >= crowd.startTick && t < crowd.crashTick;
    const crowdIn = t >= crowd.startTick && t <= crowd.crashTick;
    const returns: Record<string, number> = {};
    const carry: Record<string, number> = {};

    for (const name of ins) {
      const m = models.get(name)!;
      // Latent drift: an AR(1) process — the trend a trend-follower can catch.
      const d = m.trendPersistence * drift.get(name)! + z() * config.idioVol * 0.04;
      drift.set(name, d);
      // Idiosyncratic shock with optional mean reversion of the previous one.
      const shock = z() * config.idioVol - m.reversion * lastShock.get(name)!;
      lastShock.set(name, shock);

      let r = m.carry + d + m.beta * riskOn + m.rates * rates + shock;
      if (name === crowd.instrument && crowdBuilding) r += crowd.inflowDrift;
      if (t === crowd.crashTick) {
        r += name === crowd.instrument ? -crowd.crashSize : -crowd.crashSize * crowd.contagion;
      }
      // Aftershock: forced sellers keep hitting the crowded name for a few ticks.
      if (name === crowd.instrument && t > crowd.crashTick && t <= crowd.crashTick + 3) {
        r -= crowd.crashSize * 0.1;
      }
      for (const e of eventsAt.get(t) ?? []) {
        if (e.instrument === name) r += e.mean + e.vol * z();
      }
      returns[name] = Math.max(r, -0.95);
      carry[name] = m.carry;
    }

    ticks.push({ t, returns, carry, viralSignal: crowdIn ? crowd.instrument : null });
  }

  return { config, ticks, instruments: [...ins] };
}
