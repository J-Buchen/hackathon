/**
 * The agents. Each agent is an autonomous PM: every tick it looks at what it is
 * allowed to see and proposes target weights. It knows nothing about the other
 * agents, the book, or its own capital — exactly like a third-party agent plugged
 * into the fund. Capital, limits and survival are the center book's job.
 *
 * `Strategy.decide` may be async, so an LLM-backed agent (or a remote agent
 * behind an API) implements the same interface as these deterministic ones.
 * The swarm runs every agent's `decide` concurrently each tick.
 */

import { mulberry32 } from "./rng";
import type { MarketTick } from "./market";

/** Target weights per instrument, as a fraction of the agent's capital (+long / -short). */
export type Weights = Record<string, number>;

/** What an agent can see when it decides. No look-ahead: history ends at t-1. */
export interface Observation {
  t: number;
  /** Instruments this agent's mandate allows (from its node's allowlist). */
  universe: readonly string[];
  /** Realized returns for ticks 0..t-1, oldest first. */
  history: readonly MarketTick["returns"][];
  /** Published carry for tick t. */
  carry: MarketTick["carry"];
  /** The viral signal published for tick t (null when there is none). */
  viralSignal: string | null;
}

export interface Strategy {
  /** Short style tag, e.g. "trend" — used for reporting, never for allocation. */
  readonly style: string;
  decide(obs: Observation): Weights | Promise<Weights>;
}

/** Scale a raw signal vector so its gross exposure is 1 (or leave it flat). */
function normalize(raw: Weights): Weights {
  let g = 0;
  for (const v of Object.values(raw)) g += Math.abs(v);
  if (g === 0) return {};
  const out: Weights = {};
  for (const [k, v] of Object.entries(raw)) if (v !== 0) out[k] = v / g;
  return out;
}

function trailingSum(history: Observation["history"], name: string, lookback: number): number {
  let s = 0;
  for (let i = Math.max(0, history.length - lookback); i < history.length; i++) {
    s += history[i]![name] ?? 0;
  }
  return s;
}

/** Time-series momentum: long what went up over the lookback, short what went down. */
export class TrendStrategy implements Strategy {
  readonly style = "trend";
  constructor(private readonly lookback: number) {}
  decide(obs: Observation): Weights {
    if (obs.history.length < this.lookback) return {};
    const raw: Weights = {};
    for (const name of obs.universe) raw[name] = Math.sign(trailingSum(obs.history, name, this.lookback));
    return normalize(raw);
  }
}

/** Short-horizon mean reversion: fade the last few ticks' move. */
export class MeanReversionStrategy implements Strategy {
  readonly style = "meanrev";
  constructor(private readonly lookback: number) {}
  decide(obs: Observation): Weights {
    if (obs.history.length < this.lookback) return {};
    const raw: Weights = {};
    for (const name of obs.universe) raw[name] = -trailingSum(obs.history, name, this.lookback);
    return normalize(raw);
  }
}

/** Carry: long the highest-yielding instruments, short the lowest. */
export class CarryStrategy implements Strategy {
  readonly style = "carry";
  decide(obs: Observation): Weights {
    const ranked = [...obs.universe].sort((a, b) => (obs.carry[b] ?? 0) - (obs.carry[a] ?? 0));
    const k = Math.max(1, Math.floor(ranked.length / 3));
    const raw: Weights = {};
    for (const name of ranked.slice(0, k)) raw[name] = 1;
    for (const name of ranked.slice(-k)) raw[name] = -1;
    return normalize(raw);
  }
}

/**
 * The herd. Follows the viral signal all-in when there is one, and otherwise
 * runs a modest trend book so it doesn't look like a clone the rest of the time.
 * Several of these, in different pods, with different names, is how a fund ends
 * up with one giant position that no single agent's limits ever flagged.
 */
export class HerdStrategy implements Strategy {
  readonly style = "herd";
  private readonly fallback: TrendStrategy;
  constructor(lookback: number) {
    this.fallback = new TrendStrategy(lookback);
  }
  decide(obs: Observation): Weights {
    if (obs.viralSignal !== null && obs.universe.includes(obs.viralSignal)) {
      return { [obs.viralSignal]: 1 };
    }
    return this.fallback.decide(obs);
  }
}

/** Zero-skill agent: random weights every tick. The allocator should starve it. */
export class NoiseStrategy implements Strategy {
  readonly style = "noise";
  private readonly rand: () => number;
  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }
  decide(obs: Observation): Weights {
    const raw: Weights = {};
    for (const name of obs.universe) raw[name] = this.rand() - 0.5;
    return normalize(raw);
  }
}

/**
 * A misbehaving agent: always asks for more than its mandate allows — an
 * off-mandate instrument and 3x gross. The pre-trade gate must clip it.
 */
export class RogueStrategy implements Strategy {
  readonly style = "rogue";
  constructor(private readonly forbidden: string) {}
  decide(obs: Observation): Weights {
    const first = obs.universe[0];
    const w: Weights = { [this.forbidden]: 2 };
    if (first !== undefined) w[first] = 3;
    return w;
  }
}
