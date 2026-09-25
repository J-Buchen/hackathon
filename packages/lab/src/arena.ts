/**
 * The arena: an endless supply of VIRTUAL worlds to improve the agents in,
 * and one fixed yardstick to judge every improvement by.
 *
 * Nothing here is market data. Each world is drawn from a seed: a universe of
 * virtual stocks with their own beta, volatility, trend or mean-reversion,
 * earnings jumps and (usually) a crowd that piles in and unwinds; and a
 * randomized roster of agents — trend, mean-reversion, carry, noise, herders,
 * a rogue, and SKILLED stock pickers who see a noisy, lagged copy of each
 * stock's latent drift. Sometimes one operator runs two agents under
 * different names.
 *
 * Two tracks, one utility:
 *   allocator  the center book running the whole swarm vs per-agent guardrails
 *   tiger      the single-name Tiger overlay on one virtual stock vs buy-and-hold
 *
 * Utility is the CRRA certainty-equivalent annual return (risk aversion γ = 3):
 * what a risk-averse investor would accept for sure instead of the strategy.
 * Unlike Sharpe it punishes fat left tails and rewards compounding.
 *
 * SEAL: seeds ≥ ARENA_EVAL_FLOOR are reserved for judging. `evaluate` refuses
 * them unless the caller passes `{ sealed: true }` (only the loop driver
 * does). Every loop is judged on seeds no one has seen before.
 */

import { gaussian, mulberry32 } from "@allowance/swarm";
import {
  CarryStrategy,
  HerdStrategy,
  MeanReversionStrategy,
  NoiseStrategy,
  RogueStrategy,
  TrendStrategy,
  defaultCenterBookPolicy,
  defaultNaivePolicy,
  generateMarket,
  runBook,
  type AgentSpec,
  type CenterBookPolicy,
  type Market,
  type MarketConfig,
  type Observation,
  type Strategy,
  type SwarmSpec,
  type Weights,
} from "@allowance/swarm";
import { performance, TRADING_DAYS } from "./metrics";
import type { Panel, PanelEvent } from "./series";
import { BUY_AND_HOLD, RECOMMENDED_TIGER, runTiger, type TigerParams } from "./strategy";

export const ARENA_EVAL_FLOOR = 10_000;
export const RISK_AVERSION = 3;

/* ------------------------------------------------------------------ */
/* Utility                                                            */
/* ------------------------------------------------------------------ */

/**
 * CRRA certainty-equivalent annual return of a daily return series:
 * ce = E[(1+r)^(1−γ)]^(1/(1−γ)) − 1 per day, compounded over a year.
 */
export function certaintyEquivalent(ret: readonly number[], gamma = RISK_AVERSION): number {
  if (ret.length === 0) return 0;
  if (ret.some((r) => r <= -1)) return -1;
  let s = 0;
  for (const r of ret) s += gamma === 1 ? Math.log(1 + r) : (1 + r) ** (1 - gamma);
  const m = s / ret.length;
  const daily = gamma === 1 ? Math.exp(m) - 1 : m ** (1 / (1 - gamma)) - 1;
  return (1 + daily) ** TRADING_DAYS - 1;
}

/* ------------------------------------------------------------------ */
/* Skill                                                              */
/* ------------------------------------------------------------------ */

/**
 * A skilled stock picker: at close t it sees each stock's latent drift from
 * tick t−1 (never t or later) plus noise, goes long the best `k` and short the
 * worst `k`. `noise` sets the skill (smaller = better). Deterministic per seed.
 */
export class SkilledPicker implements Strategy {
  readonly style = "skilled";
  private readonly z: () => number;
  constructor(
    private readonly market: Market,
    private readonly noise: number,
    private readonly k: number,
    seed: number,
  ) {
    this.z = gaussian(mulberry32(seed));
  }
  decide(obs: Observation): Weights {
    if (obs.t < 1) return {};
    const lag = this.market.ticks[obs.t - 1]!.drift;
    const scored = obs.universe.map((s) => ({ s, v: (lag[s] ?? 0) + this.noise * this.z() })).sort((a, b) => b.v - a.v);
    const k = Math.max(1, Math.min(this.k, Math.floor(scored.length / 2)));
    const w: Weights = {};
    for (const x of scored.slice(0, k)) w[x.s] = 0.5 / k;
    for (const x of scored.slice(-k)) w[x.s] = -0.5 / k;
    return w;
  }
}

/* ------------------------------------------------------------------ */
/* Worlds                                                             */
/* ------------------------------------------------------------------ */

export interface World {
  seed: number;
  market: Market;
  /** A fresh roster per call: strategies hold state, so each book needs its own. */
  swarm: () => SwarmSpec;
  /** Human-readable facts about the draw, for logs. */
  meta: { stocks: number; crowd: boolean; agents: number; sharedOperators: number; skilled: number };
}

const pick = <T>(u: () => number, xs: readonly T[]): T => xs[Math.floor(u() * xs.length)]!;
const range = (u: () => number, lo: number, hi: number) => lo + (hi - lo) * u();

export function makeWorld(seed: number, ticks = 260): World {
  const u = mulberry32(seed * 7919 + 17);
  const n = 6 + Math.floor(u() * 5);
  const stocks = Array.from({ length: n }, (_, i) => `V${String(seed % 1000).padStart(3, "0")}-${String.fromCharCode(65 + i)}`);
  const overrides: MarketConfig["overrides"] = {};
  for (const s of stocks) overrides[s] = { beta: range(u, 0.3, 1.6), trends: u() < 0.5, volMult: range(u, 0.6, 2) };
  const hasCrowd = u() < 0.75;
  const start = Math.floor(range(u, 60, 150));
  const crowd = {
    instrument: pick(u, stocks),
    startTick: hasCrowd ? start : ticks + 1,
    crashTick: hasCrowd ? Math.min(ticks - 5, start + Math.floor(range(u, 30, 80))) : ticks + 2,
    inflowDrift: range(u, 0.002, 0.008),
    crashSize: range(u, 0.1, 0.4),
    contagion: range(u, 0, 0.15),
  };
  const events = stocks.flatMap((s) => {
    const phase = Math.floor(u() * 63);
    const vol = range(u, 0.03, 0.12);
    const out = [];
    for (let t = phase; t < ticks; t += 63) out.push({ instrument: s, tick: t, label: `${s} print`, mean: 0, vol });
    return out;
  });
  const config: MarketConfig = {
    seed,
    ticks,
    instruments: stocks,
    factorVol: range(u, 0.006, 0.014),
    idioVol: range(u, 0.008, 0.02),
    crowd,
    events,
    overrides,
  };
  const market = generateMarket(config);

  // Roster recipe drawn once; `swarm()` instantiates fresh strategies from it.
  const pods = ["alpha", "beta", "gamma", "delta"].slice(0, 3 + Math.floor(u() * 2));
  type Recipe = { label: string; pod: string; operator: string; make: () => Strategy; universe: string[] };
  const recipes: Recipe[] = [];
  let op = 0;
  const add = (label: string, make: () => Strategy, operator = `op-${op++}`) =>
    recipes.push({ label, pod: pick(u, pods), operator, make, universe: stocks });
  const trends = 1 + Math.floor(u() * 3);
  for (let i = 0; i < trends; i++) {
    const L = pick(u, [10, 20, 40, 60]);
    add(`trend-${i}`, () => new TrendStrategy(L));
  }
  if (u() < 0.8) {
    const L = pick(u, [2, 3, 5]);
    add("meanrev", () => new MeanReversionStrategy(L));
  }
  if (u() < 0.6) add("carry", () => new CarryStrategy());
  const noise = 1 + Math.floor(u() * 2);
  for (let i = 0; i < noise; i++) {
    const s = seed * 31 + i;
    add(`noise-${i}`, () => new NoiseStrategy(s));
  }
  const herders = hasCrowd ? Math.floor(u() * 4) : 0;
  for (let i = 0; i < herders; i++) {
    const L = pick(u, [15, 20, 25]);
    add(`herd-${i}`, () => new HerdStrategy(L));
  }
  if (u() < 0.5) {
    const first = stocks[0]!;
    add("rogue", () => new RogueStrategy(`OFF-${first}`));
  }
  const skilled = 1 + Math.floor(u() * 3);
  let shared = 0;
  for (let i = 0; i < skilled; i++) {
    const noiseLevel = range(u, 0.001, 0.006);
    const k = 1 + Math.floor(u() * 2);
    const s = seed * 131 + i;
    const operator = `op-${op++}`;
    recipes.push({ label: `picker-${i}`, pod: pick(u, pods), operator, make: () => new SkilledPicker(market, noiseLevel, k, s), universe: stocks });
    // Sometimes the same operator also runs a near-copy under another name.
    if (u() < 0.4) {
      shared++;
      const s2 = s + 7;
      recipes.push({ label: `desk-${i}`, pod: pick(u, pods), operator, make: () => new SkilledPicker(market, noiseLevel * 1.1, k, s2), universe: stocks });
    }
  }
  const swarm = (): SwarmSpec => ({
    principal: "arena",
    fund: "arena.eth",
    aum: 10_000_000,
    pods: pods.map((label) => ({ label, instruments: stocks })),
    agents: recipes.map(
      (r): AgentSpec => ({ label: r.label, pod: r.pod, operator: r.operator, instruments: r.universe, strategy: r.make() }),
    ),
  });
  return { seed, market, swarm, meta: { stocks: n, crowd: hasCrowd, agents: recipes.length, sharedOperators: shared, skilled } };
}

/* ------------------------------------------------------------------ */
/* Tracks                                                             */
/* ------------------------------------------------------------------ */

export interface AllocatorScore {
  seed: number;
  centerUtility: number;
  naiveUtility: number;
  centerSharpe: number;
  naiveSharpe: number;
  centerMaxDD: number;
  naiveMaxDD: number;
}

export async function scoreAllocator(world: World, policy: CenterBookPolicy = defaultCenterBookPolicy()): Promise<AllocatorScore> {
  const center = await runBook(world.market, world.swarm(), policy);
  const naive = await runBook(world.market, world.swarm(), { ...defaultNaivePolicy(), leverage: policy.leverage, deploy: policy.deploy, ddStop: policy.ddStop });
  const pc = performance(center.returns);
  const pn = performance(naive.returns);
  return {
    seed: world.seed,
    centerUtility: certaintyEquivalent(center.returns),
    naiveUtility: certaintyEquivalent(naive.returns),
    centerSharpe: pc.sharpe,
    naiveSharpe: pn.sharpe,
    centerMaxDD: pc.maxDrawdown,
    naiveMaxDD: pn.maxDrawdown,
  };
}

/**
 * Single-name view of a world for the Tiger overlay: the most volatile stock
 * is the primary, an equal-weight index of the others is the hedge, prints
 * come from its catalyst schedule, cash earns 4%.
 */
export function tigerPanel(world: World): { panel: Panel; events: PanelEvent[] } {
  const m = world.market;
  const vol = (s: string) => {
    const r = m.ticks.map((t) => t.returns[s]!);
    const mu = r.reduce((a, b) => a + b, 0) / r.length;
    return r.reduce((a, b) => a + (b - mu) ** 2, 0);
  };
  const primary = [...m.instruments].sort((a, b) => vol(b) - vol(a))[0]!;
  const others = m.instruments.filter((s) => s !== primary);
  const dates = ["T0000", ...m.ticks.map((t) => `T${String(t.t + 1).padStart(4, "0")}`)];
  const rP = [0, ...m.ticks.map((t) => t.returns[primary]!)];
  const rH = [0, ...m.ticks.map((t) => others.reduce((a, s) => a + t.returns[s]!, 0) / others.length)];
  const px = (r: number[]) => r.reduce<number[]>((acc, x, i) => (i === 0 ? [100] : [...acc, acc[i - 1]! * (1 + x)]), []);
  const events = (m.config.events ?? []).filter((e) => e.instrument === primary).map((e) => ({ t: e.tick + 1, date: `T${e.tick + 1}`, label: e.label }));
  return {
    panel: {
      primary,
      symbols: [primary, "VIDX"],
      dates,
      px: { [primary]: px(rP), VIDX: px(rH) },
      ret: { [primary]: rP, VIDX: rH },
      rf: dates.map(() => 0.04 / 252),
    },
    events,
  };
}

export interface TigerScore {
  seed: number;
  overlayUtility: number;
  buyHoldUtility: number;
  overlaySharpe: number;
  buyHoldSharpe: number;
  overlayMaxDD: number;
  buyHoldMaxDD: number;
}

export function scoreTiger(world: World, params: TigerParams = RECOMMENDED_TIGER): TigerScore {
  const { panel, events } = tigerPanel(world);
  const hedged = { ...params, hedgeSymbol: params.hedgeSymbol ? "VIDX" : null };
  const range = { from: 60, to: panel.dates.length - 1 };
  const o = runTiger(panel, events, hedged, range);
  const b = runTiger(panel, events, BUY_AND_HOLD, range);
  const po = performance(o.ret, o.rf);
  const pb = performance(b.ret, b.rf);
  return {
    seed: world.seed,
    overlayUtility: certaintyEquivalent(o.ret),
    buyHoldUtility: certaintyEquivalent(b.ret),
    overlaySharpe: po.sharpe,
    buyHoldSharpe: pb.sharpe,
    overlayMaxDD: po.maxDrawdown,
    buyHoldMaxDD: pb.maxDrawdown,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                         */
/* ------------------------------------------------------------------ */

export interface TrackSummary {
  worlds: number;
  /** Mean utility of the agent being improved. */
  utility: number;
  /** Mean utility of its baseline (per-agent guardrails / buy-and-hold). */
  baseline: number;
  /** Mean paired uplift over the baseline, with a 90% t-interval. */
  uplift: number;
  upliftLo: number;
  upliftHi: number;
  /** Share of worlds where the agent beat its baseline. */
  winRate: number;
  sharpe: number;
  baselineSharpe: number;
  maxDD: number;
  baselineMaxDD: number;
}

function summarize(pairs: { a: number; b: number; sa: number; sb: number; da: number; db: number }[]): TrackSummary {
  const n = pairs.length;
  const mean = (f: (p: (typeof pairs)[number]) => number) => pairs.reduce((s, p) => s + f(p), 0) / n;
  const d = pairs.map((p) => p.a - p.b);
  const md = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / Math.max(1, n - 1));
  const half = 1.645 * (sd / Math.sqrt(n));
  return {
    worlds: n,
    utility: mean((p) => p.a),
    baseline: mean((p) => p.b),
    uplift: md,
    upliftLo: md - half,
    upliftHi: md + half,
    winRate: d.filter((x) => x > 0).length / n,
    sharpe: mean((p) => p.sa),
    baselineSharpe: mean((p) => p.sb),
    maxDD: mean((p) => p.da),
    baselineMaxDD: mean((p) => p.db),
  };
}

export interface EvaluateOptions {
  from: number;
  count: number;
  /** Required to touch seeds ≥ ARENA_EVAL_FLOOR. Only the loop driver sets it. */
  sealed?: boolean;
  policy?: CenterBookPolicy;
  tiger?: TigerParams;
}

export interface WorldResult {
  seed: number;
  allocator: number;
  allocatorBaseline: number;
  tiger: number;
  tigerBaseline: number;
  /** Center book's max drawdown and Sharpe in this world (for paired risk checks). */
  allocatorMaxDD: number;
  allocatorSharpe: number;
  /** Tiger overlay's max drawdown and Sharpe in this world. */
  tigerMaxDD: number;
  tigerSharpe: number;
}

export async function evaluate(
  opts: EvaluateOptions,
): Promise<{ allocator: TrackSummary; tiger: TrackSummary; worlds: World["meta"][]; perWorld: WorldResult[] }> {
  if (opts.from + opts.count > ARENA_EVAL_FLOOR && !opts.sealed) {
    throw new Error(`seeds ≥ ${ARENA_EVAL_FLOOR} are sealed for judging; research on seeds below it`);
  }
  const alloc: Parameters<typeof summarize>[0] = [];
  const tiger: Parameters<typeof summarize>[0] = [];
  const metas: World["meta"][] = [];
  const perWorld: WorldResult[] = [];
  for (let seed = opts.from; seed < opts.from + opts.count; seed++) {
    const w = makeWorld(seed);
    metas.push(w.meta);
    const a = await scoreAllocator(w, opts.policy);
    alloc.push({ a: a.centerUtility, b: a.naiveUtility, sa: a.centerSharpe, sb: a.naiveSharpe, da: a.centerMaxDD, db: a.naiveMaxDD });
    const t = scoreTiger(w, opts.tiger);
    tiger.push({ a: t.overlayUtility, b: t.buyHoldUtility, sa: t.overlaySharpe, sb: t.buyHoldSharpe, da: t.overlayMaxDD, db: t.buyHoldMaxDD });
    perWorld.push({
      seed,
      allocator: a.centerUtility,
      allocatorBaseline: a.naiveUtility,
      tiger: t.overlayUtility,
      tigerBaseline: t.buyHoldUtility,
      allocatorMaxDD: a.centerMaxDD,
      allocatorSharpe: a.centerSharpe,
      tigerMaxDD: t.overlayMaxDD,
      tigerSharpe: t.overlaySharpe,
    });
  }
  return { allocator: summarize(alloc), tiger: summarize(tiger), worlds: metas, perWorld };
}
