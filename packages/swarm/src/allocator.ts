/**
 * The center book's brain. Pure functions only — no tree, no I/O — so every
 * allocation decision is reproducible and unit-testable. `book.ts` turns these
 * decisions into mandate-tree writes (resize = reallocate, revoke = stop-out).
 *
 * Three things a pod shop does that per-agent guardrails cannot:
 *
 *  1. ALLOCATE BY RISK-ADJUSTED, ATTRIBUTABLE RETURNS, CORRELATION-AWARE.
 *     score = shrunk Sharpe (short track records are pulled toward zero) ÷ vol,
 *     then divided by how many OTHER agents are really the same bet (sum of
 *     positive return correlations). Two clones split one allocation instead of
 *     each taking a full one.
 *  2. A DRAWDOWN LADDER. At `ddCut` an agent's capital is cut to `cutFactor`;
 *     it is restored only once it recovers above `ddRecover`. At `ddStop` it is
 *     stopped out: capital to zero and the mandate revoked. The rungs are
 *     RISK-SCALED: drawdowns are judged against the vol the agent runs
 *     (`ddStopVol`), so a volatile skilled book is not revoked for ordinary
 *     noise while the fixed percentages remain the floor.
 *  3. CROWDING. Agents whose proposed books point the same way (cosine
 *     similarity ≥ `crowdSimilarity`) form a crowd. If a crowd's combined
 *     exposure to any one instrument exceeds `crowdMaxShare` of NAV, every
 *     member contributing to it is scaled down until it doesn't. The whole
 *     book's net exposure to any one instrument is capped too (`bookMaxShare`).
 *     No single agent ever breached a limit — that is the point.
 */

import {
  annualVol,
  correlationMatrix,
  cosineSimilarity,
  currentDrawdown,
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
  /** Trailing window (ticks) scores and correlations are computed over. */
  window: number;
  /** Bayesian-style shrinkage: Sharpe × n / (n + shrinkageObs). */
  shrinkageObs: number;
  /** Max share of deployable capital any single agent may hold. */
  maxAgentShare: number;
  /** Relative change below which a reallocation is skipped (avoids churn). */
  rebalanceBand: number;
  /** Drawdown (from the agent's own high-water mark) that triggers a cut. */
  ddCut: number;
  /** Capital multiplier while cut. */
  cutFactor: number;
  /** Drawdown the agent must recover to before a cut is lifted. */
  ddRecover: number;
  /** Drawdown that triggers a stop-out (revocation). */
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
  const windows = live.map((a) => a.unitReturns.slice(-policy.window));
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
    const scores = base.map((b) => Math.max(0, b.shrunkSharpe) / b.vol);
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
    let target = shares[i]! * deployable * a.ladderMultiplier;
    if (a.crowdCap !== undefined) target = Math.min(target, a.crowdCap);
    return { ...base[i]!, multiplicity: multiplicity[i]!, share: shares[i]!, target };
  });
  for (const a of agents) {
    if (a.stopped) {
      out.push({ name: a.name, sharpe: 0, shrunkSharpe: 0, vol: 0, multiplicity: 1, share: 0, target: 0 });
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

/**
 * Widen the configured rungs to the risk this record runs: every rung is
 * multiplied by max(1, ddStopVol × σ / ddStop), σ measured up to the last
 * high-water mark so the losses being judged cannot loosen their own limit.
 * Never tighter than the configured percentages.
 */
export function scaleLadder(unitReturns: readonly number[], t: LadderThresholds): ScaledLadder {
  const vol = t.ddStopVol ? volAtHighWater(unitReturns, t.volWindow ?? unitReturns.length) : 0;
  const scale = t.ddStopVol && t.ddStop > 0 ? Math.max(1, (t.ddStopVol * vol) / t.ddStop) : 1;
  return {
    ddStop: t.ddStop * scale,
    ddCut: t.ddCut === undefined ? undefined : t.ddCut * scale,
    ddRecover: t.ddRecover === undefined ? undefined : t.ddRecover * scale,
    vol,
    scale,
  };
}

/** Next ladder state from the agent's own attributable track record. */
export function nextLadderState(
  state: LadderState,
  unitReturns: readonly number[],
  thresholds: LadderThresholds,
): LadderState {
  if (state === "stopped") return "stopped"; // revocation is final
  const t = scaleLadder(unitReturns, thresholds);
  const dd = currentDrawdown(unitReturns);
  if (dd >= t.ddStop) return "stopped";
  if (t.ddCut === undefined) return "active";
  if (state === "active" && dd >= t.ddCut) return "cut";
  if (state === "cut" && dd <= (t.ddRecover ?? 0)) return "active";
  return state;
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
