/**
 * The center book's brain. Pure functions only — no tree, no I/O — so every
 * allocation decision is reproducible and unit-testable. `book.ts` turns these
 * decisions into mandate-tree writes (resize = reallocate, close = stop-out).
 *
 * Four things a pod shop does that per-agent guardrails cannot:
 *
 *  1. ALLOCATE BY RISK-ADJUSTED, ATTRIBUTABLE RETURNS, CORRELATION-AWARE.
 *     score = shrunk Sharpe over the agent's last year of record (`recordWindow`),
 *     then divided by how many OTHER agents are really the same bet (sum of
 *     positive return correlations). Two clones split one allocation instead of
 *     each taking a full one.
 *  2. A DRAWDOWN LADDER. At `ddCut` an agent's capital is cut to `cutFactor`;
 *     it is restored only once it recovers above `ddRecover`. At `ddStop` it is
 *     stopped out: its mandate is closed together with every sub-mandate it
 *     handed out, and it never trades again. The rungs are RISK-SCALED:
 *     drawdowns are judged against the vol the agent runs (`ddStopVol`), so a
 *     volatile skilled book is not revoked for ordinary noise while the fixed
 *     percentages remain the floor. The cut rung is optional (leave `ddCut`
 *     unset for a stop-only ladder). It stays on by default: under the scaled
 *     ladder, dropping it moved CE utility by only +0.05pp on arena research
 *     seeds 801–1000 (90% CI −0.06..+0.16) and +0.12pp on 5600–5749
 *     (−0.03..+0.27), which is not evidence enough to change the default.
 *  3. CROWDING. Agents whose proposed books point the same way (cosine
 *     similarity ≥ `crowdSimilarity`) form a crowd. If a crowd's combined
 *     exposure to any one instrument exceeds `crowdMaxShare` of NAV, every
 *     member contributing to it is scaled down until it doesn't. The whole
 *     book's net exposure to any one instrument is capped too (`bookMaxShare`).
 *     No single agent ever breached a limit — that is the point.
 *  4. COUNTERPARTIES. An operator (`AgentSpec.operator`, a verified human in
 *     production) is one counterparty however many names it runs, so a
 *     stop-out of one of its names is a credit event for all of them: its
 *     other live names are capped at `cutFactor` of their FULL SIZE (the
 *     capital the allocator gives them uncut) until each recovers on its own
 *     record: a new high, or its own ladder lifting a cut. The cap is a
 *     ceiling on capital, not a multiplier on whatever the name holds: a name
 *     the ladder already cut (or an earlier operator event already capped) is
 *     not cut again, and at a reallocation the ladder and the cap take the
 *     smaller multiplier, never the product. Every name keeps its own ladder:
 *     the cap never stops anyone, and no name's own stop-out is ever delayed
 *     or brought forward.
 */

import {
  annualVol,
  correlationMatrix,
  cosineSimilarity,
  currentDrawdown,
  isNewHigh,
  sharpe,
  volAtHighWater,
} from "./stats";
import type { Weights } from "./strategies";

export interface CenterBookPolicy {
  kind: "center";
  /** Gross leverage each agent trades at (notional = capital × leverage × weight). */
  leverage: number;
  /** Fraction of deployable NAV handed to agents; the rest is held as cash. */
  deploy: number;
  /** Ticks between scheduled reallocations. */
  rebalanceEvery: number;
  /** Ticks of track record before scores replace equal weighting. */
  warmup: number;
  /**
   * Trailing window (ticks) of the ladder's risk measure: the vol each agent
   * runs, measured up to its high-water mark (see `ddStopVol`).
   */
  window: number;
  /**
   * Trailing ticks of track record that scores and correlations are estimated
   * on. A Sharpe ratio estimated on n daily returns carries a standard error
   * of about √(252 / n): ±1.7 on 90 ticks, as large as the skill being
   * measured, so a short trailing window re-ranks agents on luck every few
   * weeks. Skill that persists is measured on all of the record that is still
   * current — one trading year. Agents whose edge decays are handled by the
   * drawdown ladder, not by forgetting the evidence.
   */
  recordWindow: number;
  /**
   * Bayesian-style shrinkage: Sharpe × n / (n + shrinkageObs). It only matters
   * between records of different lengths: when every agent started together
   * (the examples, the arena), the factor is common and cancels in the shares.
   */
  shrinkageObs: number;
  /** Max share of deployable capital any single agent may hold. */
  maxAgentShare: number;
  /** Relative change below which a reallocation is skipped (avoids churn). */
  rebalanceBand: number;
  /**
   * Drawdown (from the agent's own high-water mark) that cuts its capital to
   * `cutFactor`. Optional: unset = no cut rung, only the stop-out (see the
   * header). On by default.
   */
  ddCut?: number;
  /** Capital multiplier while cut (with `ddCut`; default 1). */
  cutFactor?: number;
  /** Drawdown the agent must recover to before a cut is lifted (with `ddCut`). */
  ddRecover?: number;
  /** Drawdown that triggers a stop-out (the mandate subtree is closed). */
  ddStop: number;
  /**
   * Risk-scaled ladder. A fixed-percentage drawdown is not evidence on its own:
   * 20% is routine for a book running 45% annual vol and alarming for one
   * running 10%. The center book sees each agent's record, so it measures
   * drawdowns in units of the risk the agent runs: the stop fires at
   * max(ddStop, ddStopVol × σ), where σ is the agent's annualized vol over
   * `window` ticks up to its high-water mark, and the cut and recover rungs
   * widen by the same factor. The fixed percentages remain floors, so the center
   * book never cuts or stops an agent sooner than its own stop-loss would.
   * 0 = the fixed-percentage ladder.
   */
  ddStopVol: number;
  /**
   * Ceiling on the risk-scaled stop (a drawdown, < 1). However volatile the
   * record, the stop never sits above this, so every agent can still be stopped
   * out; the cut and recover rungs are capped in proportion.
   */
  ddStopMax: number;
  /** Cosine similarity at which two agents' books count as the same trade. */
  crowdSimilarity: number;
  /** Max combined exposure of one crowd to one instrument, as a share of NAV. */
  crowdMaxShare: number;
  /** Max net exposure of the WHOLE book to one instrument, as a share of NAV. */
  bookMaxShare: number;
}

/**
 * The baseline everyone ships today: equal capital, static, per-agent guardrails
 * only (the same pre-trade gate, plus each agent's own stop-loss).
 */
export interface NaivePolicy {
  kind: "naive";
  leverage: number;
  deploy: number;
  ddStop: number;
}

export type AllocationPolicy = CenterBookPolicy | NaivePolicy;

export function defaultCenterBookPolicy(): CenterBookPolicy {
  return {
    kind: "center",
    leverage: 2,
    deploy: 0.8,
    rebalanceEvery: 5,
    warmup: 30,
    window: 90,
    recordWindow: 252,
    shrinkageObs: 60,
    maxAgentShare: 0.25,
    rebalanceBand: 0.1,
    ddCut: 0.1,
    cutFactor: 0.5,
    ddRecover: 0.05,
    ddStop: 0.2,
    // A skilled agent (Sharpe S) sits in a drawdown ≥ kσ about e^(−2Sk) of the
    // time; at k = 1.5 that is ~5% for S = 1, so revocation needs real evidence.
    ddStopVol: 1.5,
    // At most twice the room of the agent's own 20% stop-loss.
    ddStopMax: 0.4,
    crowdSimilarity: 0.8,
    crowdMaxShare: 0.1,
    bookMaxShare: 0.2,
  };
}

export function defaultNaivePolicy(): NaivePolicy {
  return { kind: "naive", leverage: 2, deploy: 0.8, ddStop: 0.2 };
}

/* ------------------------------------------------------------------ */
/* 1. Correlation-aware, risk-adjusted allocation                     */
/* ------------------------------------------------------------------ */

export interface AgentScoreInput {
  name: string;
  /** Attributable per-unit-of-capital returns, oldest first. */
  unitReturns: readonly number[];
  /** Stopped-out agents get nothing. */
  stopped: boolean;
  /** Capital multiplier from the drawdown ladder (1, or cutFactor while cut). */
  ladderMultiplier: number;
  /**
   * Capital multiplier from an operator cap (cutFactor while one is in force;
   * see `nextCounterpartyCaps`). Both multipliers are ceilings on the same
   * full-size target, so the target takes the SMALLER of the two: a name the
   * ladder cut and its operator capped is sized at cutFactor, not cutFactor².
   */
  counterpartyMultiplier?: number;
  /** Absolute capital ceiling from an active crowding cut, if any. */
  crowdCap?: number;
}

export interface AgentScore {
  name: string;
  sharpe: number;
  shrunkSharpe: number;
  vol: number;
  /** How many agents this one effectively duplicates (≥ 1). */
  multiplicity: number;
  /** Share of deployable capital before ladder / crowding multipliers. */
  share: number;
  /**
   * Full size: share × deployable, the capital the agent gets when nothing
   * cuts or caps it. Cuts and caps are fractions of this.
   */
  fullTarget: number;
  /** Final capital target. */
  target: number;
}

/**
 * Compute capital targets for every agent. Capital freed by caps, cuts and
 * crowding stays in cash rather than being pushed onto whoever is left —
 * cutting risk should reduce risk, not relocate it.
 */
export function allocate(
  agents: readonly AgentScoreInput[],
  deployable: number,
  policy: CenterBookPolicy,
): AgentScore[] {
  const live = agents.filter((a) => !a.stopped);
  const windows = live.map((a) => a.unitReturns.slice(-policy.recordWindow));
  const n = windows[0]?.length ?? 0;

  const base = live.map((a, i) => {
    const w = windows[i]!;
    const s = sharpe(w);
    const shrunk = s * (w.length / (w.length + policy.shrinkageObs));
    return { name: a.name, sharpe: s, shrunkSharpe: shrunk, vol: Math.max(annualVol(w), 1e-6) };
  });

  let raw: number[];
  let multiplicity: number[];
  if (n < policy.warmup) {
    // Not enough evidence yet: equal weight, no correlation adjustment.
    raw = live.map(() => 1);
    multiplicity = live.map(() => 1);
  } else {
    // Rank on Sharpe itself, not Sharpe ÷ vol (the Kelly weight μ/σ²). Every
    // agent's Sharpe estimate carries the same sampling error, ≈ √(252 / n),
    // so ranking by it ranks by strength of evidence. Dividing by vol again
    // gives a low-vol book's luck 1/σ times the weight of a high-vol book's —
    // and buys nothing here: capital is capped per agent (`maxAgentShare`)
    // and in aggregate (`deploy`) far below any skilled agent's Kelly
    // fraction, so what is scarce is capital, not risk budget.
    const scores = base.map((b) => Math.max(0, b.shrunkSharpe));
    const corr = correlationMatrix(windows);
    multiplicity = scores.map((_, i) => {
      let m = 0;
      for (let j = 0; j < scores.length; j++) {
        if (scores[j]! > 0 || i === j) m += Math.max(0, corr[i]![j]!);
      }
      return Math.max(1, m);
    });
    raw = scores.map((s, i) => s / multiplicity[i]!);
  }

  const shares = capShares(raw, policy.maxAgentShare);

  const out: AgentScore[] = live.map((a, i) => {
    const fullTarget = shares[i]! * deployable;
    // Ladder cut and operator cap are one ceiling, not two: the smaller wins.
    const multiplier = Math.min(a.ladderMultiplier, a.counterpartyMultiplier ?? a.ladderMultiplier);
    let target = fullTarget * multiplier;
    if (a.crowdCap !== undefined) target = Math.min(target, a.crowdCap);
    return { ...base[i]!, multiplicity: multiplicity[i]!, share: shares[i]!, fullTarget, target };
  });
  for (const a of agents) {
    if (a.stopped) {
      out.push({ name: a.name, sharpe: 0, shrunkSharpe: 0, vol: 0, multiplicity: 1, share: 0, fullTarget: 0, target: 0 });
    }
  }
  return out;
}

/**
 * Normalize non-negative raw weights to shares summing to ≤ 1, with no share
 * above `cap`. Water-filling: capped names are pinned at the cap and the excess
 * is redistributed pro rata among the rest; if everyone hits the cap, the
 * remainder is simply left undeployed.
 */
export function capShares(raw: readonly number[], cap: number): number[] {
  const total = raw.reduce((s, x) => s + Math.max(0, x), 0);
  if (total === 0) return raw.map(() => 0);
  const shares = raw.map((x) => Math.max(0, x) / total);
  const pinned = new Set<number>();
  for (let iter = 0; iter < raw.length; iter++) {
    let excess = 0;
    for (let i = 0; i < shares.length; i++) {
      if (!pinned.has(i) && shares[i]! > cap) {
        excess += shares[i]! - cap;
        shares[i] = cap;
        pinned.add(i);
      }
    }
    if (excess === 0) break;
    const freeTotal = shares.reduce((s, x, i) => (pinned.has(i) ? s : s + x), 0);
    if (freeTotal === 0) break;
    for (let i = 0; i < shares.length; i++) {
      if (!pinned.has(i)) shares[i] = shares[i]! + (excess * shares[i]!) / freeTotal;
    }
  }
  return shares;
}

/* ------------------------------------------------------------------ */
/* 2. Drawdown ladder                                                 */
/* ------------------------------------------------------------------ */

export type LadderState = "active" | "cut" | "stopped";

export interface LadderThresholds {
  ddCut?: number;
  ddRecover?: number;
  ddStop: number;
  /** Risk scaling (see `CenterBookPolicy.ddStopVol`); absent or 0 = fixed rungs. */
  ddStopVol?: number;
  /** Trailing ticks the risk measure is taken over (default: the whole record). */
  volWindow?: number;
  /** Ceiling on the scaled stop, < 1 (default 2 × ddStop, capped below 1). */
  ddStopMax?: number;
}

/** The rungs actually in force for one record, after risk scaling. */
export interface ScaledLadder {
  ddCut?: number;
  ddRecover?: number;
  ddStop: number;
  /** Annualized vol of the record up to its high-water mark. */
  vol: number;
  /** Factor the configured rungs were widened by (≥ 1). */
  scale: number;
}

/** Default ceiling on the widening when `ddStopMax` is not given. */
export const DEFAULT_MAX_WIDENING = 2;

/**
 * Widen the configured rungs to the risk this record runs: every rung is
 * multiplied by ddStopVol × σ / ddStop, clamped to [1, ddStopMax / ddStop].
 * σ is measured up to the last high-water mark, so the losses being judged
 * cannot loosen their own limit. Never tighter than the configured
 * percentages, never looser than `ddStopMax`: every agent can still be
 * stopped out, however volatile (or however short) its record.
 */
export function scaleLadder(unitReturns: readonly number[], t: LadderThresholds): ScaledLadder {
  const ceiling = t.ddStopMax ?? Math.min(DEFAULT_MAX_WIDENING * t.ddStop, 0.95);
  if (!(ceiling < 1)) throw new RangeError(`ddStopMax must be below 100% (got ${ceiling}): a stop at or above it can never fire`);
  const vol = t.ddStopVol ? volAtHighWater(unitReturns, t.volWindow ?? unitReturns.length) : 0;
  const scale =
    t.ddStopVol && t.ddStop > 0 ? Math.min(Math.max(1, (t.ddStopVol * vol) / t.ddStop), Math.max(1, ceiling / t.ddStop)) : 1;
  return {
    ddStop: t.ddStop * scale,
    ddCut: t.ddCut === undefined ? undefined : t.ddCut * scale,
    ddRecover: t.ddRecover === undefined ? undefined : t.ddRecover * scale,
    vol,
    scale,
  };
}

/**
 * One ladder step from the agent's own attributable track record: the next
 * state and the rungs (after risk scaling) it was judged against.
 */
export function ladderStep(
  state: LadderState,
  unitReturns: readonly number[],
  thresholds: LadderThresholds,
): { next: LadderState; rungs: ScaledLadder } {
  const rungs = scaleLadder(unitReturns, thresholds);
  const next = ((): LadderState => {
    if (state === "stopped") return "stopped"; // revocation is final
    const dd = currentDrawdown(unitReturns);
    if (dd >= rungs.ddStop) return "stopped";
    if (rungs.ddCut === undefined) return "active";
    if (state === "active" && dd >= rungs.ddCut) return "cut";
    if (state === "cut" && dd <= (rungs.ddRecover ?? 0)) return "active";
    return state;
  })();
  return { next, rungs };
}

/** Next ladder state from the agent's own attributable track record. */
export function nextLadderState(
  state: LadderState,
  unitReturns: readonly number[],
  thresholds: LadderThresholds,
): LadderState {
  return ladderStep(state, unitReturns, thresholds).next;
}

/* ------------------------------------------------------------------ */
/* 3. Crowding                                                        */
/* ------------------------------------------------------------------ */

export interface CrowdInput {
  name: string;
  capital: number;
  /** Tradeable weights this tick (post-gate). */
  weights: Weights;
}

export interface CrowdBreach {
  /**
   * CLONES: a cluster of agents running near-identical books.
   * BOOK:   the whole book's net exposure to one instrument, whoever holds it.
   */
  kind: "CLONES" | "BOOK";
  /** Agents in the group, in input order. */
  members: string[];
  instrument: string;
  /** Combined signed notional exposure to `instrument`. */
  exposure: number;
  /** |exposure| / NAV. */
  share: number;
  /** The limit that was breached, as a share of NAV. */
  limit: number;
  /** Multiplier applied to each contributing member's capital. */
  scale: number;
  /** Members whose capital is scaled (same sign as the group's exposure). */
  contributors: string[];
}

export interface CrowdScan {
  /** Every cluster of ≥ 2 similar books, breaching or not. */
  clusters: string[][];
  breaches: CrowdBreach[];
}

/**
 * If `members`' combined exposure to their largest instrument exceeds
 * `limitShare` of NAV, return the uniform capital scale on the same-direction
 * contributors that brings it back to the limit.
 */
function concentrationBreach(
  kind: CrowdBreach["kind"],
  members: readonly CrowdInput[],
  nav: number,
  leverage: number,
  limitShare: number,
): CrowdBreach | null {
  if (nav <= 0) return null;
  const exposure = new Map<string, number>();
  for (const m of members) {
    for (const [k, w] of Object.entries(m.weights)) {
      exposure.set(k, (exposure.get(k) ?? 0) + m.capital * leverage * w);
    }
  }
  let worst: [string, number] | null = null;
  for (const [k, e] of exposure) {
    if (worst === null || Math.abs(e) > Math.abs(worst[1])) worst = [k, e];
  }
  const limit = limitShare * nav;
  // Small tolerance so a group sitting exactly at the limit (e.g. right after a
  // cut, or drifting a few percent with prices) doesn't churn the tree.
  if (worst === null || Math.abs(worst[1]) <= limit * 1.05) return null;

  const [instrument, e] = worst;
  const dir = Math.sign(e);
  const contributors = members.filter((m) => Math.sign(m.weights[instrument] ?? 0) === dir);
  // Only the contributors shrink, so solve for the scale on THEIR share.
  const contributed = contributors.reduce(
    (s, m) => s + m.capital * leverage * (m.weights[instrument] ?? 0),
    0,
  );
  const others = e - contributed;
  const scale = Math.max(0, Math.min(1, (dir * limit - others) / contributed));
  return {
    kind,
    members: members.map((m) => m.name),
    instrument,
    exposure: e,
    share: Math.abs(e) / nav,
    limit: limitShare,
    scale,
    contributors: contributors.map((m) => m.name),
  };
}

/**
 * Two book-level checks no per-agent limit can make:
 *
 *  - CLONES: cluster agents whose proposed books point the same way (cosine
 *    similarity ≥ `crowdSimilarity`, union-find) and cap each cluster's
 *    concentrated exposure at `crowdMaxShare` of NAV. This is the check that
 *    names names: "these three agents in three pods are one trade".
 *  - BOOK: cap the whole book's net exposure to any single instrument at
 *    `bookMaxShare`, however many different-looking strategies it is spread
 *    across (a trend agent riding the crowd's run-up is crowding too).
 */
export function scanCrowding(
  agents: readonly CrowdInput[],
  nav: number,
  leverage: number,
  policy: Pick<CenterBookPolicy, "crowdSimilarity" | "crowdMaxShare" | "bookMaxShare">,
): CrowdScan {
  const active = agents.filter((a) => a.capital > 0 && Object.keys(a.weights).length > 0);
  const parent = active.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (cosineSimilarity(active[i]!.weights, active[j]!.weights) >= policy.crowdSimilarity) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, CrowdInput[]>();
  active.forEach((a, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(a);
    else groups.set(root, [a]);
  });

  const clusters: string[][] = [];
  const breaches: CrowdBreach[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    clusters.push(members.map((m) => m.name));
    const b = concentrationBreach("CLONES", members, nav, leverage, policy.crowdMaxShare);
    if (b) breaches.push(b);
  }

  // Book-level check runs on capital AFTER the clone cuts above are applied, so
  // it only bites for concentration the clone check didn't already remove.
  const scaled = new Map<string, number>();
  for (const b of breaches) for (const c of b.contributors) scaled.set(c, b.scale);
  const post = active.map((a) => ({ ...a, capital: a.capital * (scaled.get(a.name) ?? 1) }));
  const book = concentrationBreach("BOOK", post, nav, leverage, policy.bookMaxShare);
  if (book) breaches.push(book);

  return { clusters, breaches };
}

/* ------------------------------------------------------------------ */
/* 4. Counterparties                                                  */
/* ------------------------------------------------------------------ */

export interface CounterpartyAgent {
  name: string;
  /** Who runs the agent; absent = a counterparty of its own. */
  operator?: string;
  ladder: LadderState;
  /** The agent's own attributable record, oldest first. */
  unitReturns: readonly number[];
}

/** An operator cap on one name, in force since tick `since`. */
export interface CounterpartyCap {
  /** The name of the same operator whose stop-out set the cap. */
  after: string;
  since: number;
}

export interface CounterpartyUpdate {
  /** Caps in force after this tick. */
  caps: Map<string, CounterpartyCap>;
  /** Names capped this tick (none was capped before), each with the stopped name that caused it. */
  capped: { name: string; after: string }[];
  /** Names whose cap lifted this tick (a recovery on their own record, see `nextCounterpartyCaps`). */
  lifted: string[];
}

/**
 * One operator, one counterparty, one credit event. When a name is stopped
 * out this tick (`stoppedNow`, by its OWN ladder), every other live name of
 * the same operator that is not capped already is capped. A name that is
 * already capped stays capped as it was (caps are not stacked), and stopped
 * names drop out.
 *
 * A cap lifts at the first tick after it was set on which the name's own
 * record shows a recovery: a strict new high (it has re-earned its capital),
 * or its own ladder lifting a cut this tick (`restoredNow`: back within its
 * recover rung of its high-water mark). The cap and the ladder's cut are one
 * ceiling (cutFactor of full size), so they compound neither in size (see
 * `cutToCeiling`) nor in time: a credit event never holds a name at the cut
 * size after its own ladder has judged it recovered from that very cut.
 *
 * Pure bookkeeping on names and records: capital is not an input, and ladder
 * states are only read, never written, so no name's stop-out can move.
 */
export function nextCounterpartyCaps(
  caps: ReadonlyMap<string, CounterpartyCap>,
  agents: readonly CounterpartyAgent[],
  stoppedNow: readonly string[],
  restoredNow: readonly string[],
  t: number,
): CounterpartyUpdate {
  const next = new Map<string, CounterpartyCap>();
  const lifted: string[] = [];
  for (const a of agents) {
    const cap = caps.get(a.name);
    if (!cap || a.ladder === "stopped") continue;
    if (t > cap.since && (isNewHigh(a.unitReturns) || restoredNow.includes(a.name))) lifted.push(a.name);
    else next.set(a.name, cap);
  }
  const capped: { name: string; after: string }[] = [];
  for (const stopped of stoppedNow) {
    const op = agents.find((a) => a.name === stopped)?.operator;
    if (op === undefined) continue;
    for (const a of agents) {
      if (a.name === stopped || a.operator !== op || a.ladder === "stopped" || next.has(a.name)) continue;
      next.set(a.name, { after: stopped, since: t });
      capped.push({ name: a.name, after: stopped });
    }
  }
  return { caps: next, capped, lifted };
}

/**
 * Relative slack under which capital counts as already AT a ceiling: budgets
 * are whole micro-USDC, so a name cut to the ceiling can sit a rounding unit
 * above it, and must not be "cut" again by that unit.
 */
export const CEILING_SLACK = 1e-9;

/**
 * Where a cut to `factor` of the agent's full size leaves its capital: the
 * ceiling `factor × fullSize` if it holds more than that, else `null` (no
 * write: it is already there or below, e.g. cut by its own ladder, capped by
 * an earlier operator event, or cut by crowding). A cut decided this way is
 * decided on capital, not on ladder state, so two cuts never compound: after
 * any number of them the agent holds min(capital, factor × fullSize), never
 * factor² × fullSize.
 */
export function cutToCeiling(capital: number, fullSize: number, factor: number): number | null {
  const ceiling = Math.max(0, factor * fullSize);
  return capital > ceiling * (1 + CEILING_SLACK) ? ceiling : null;
}
