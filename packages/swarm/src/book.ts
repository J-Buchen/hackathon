/**
 * The book: runs a swarm of agents against a market under an allocation policy,
 * with the Allowance mandate tree as the single source of authority.
 *
 *   fund.eth                      ← principal funds the root with AUM
 *    ├─ systematic.fund.eth       ← pods: budget = sum of their agents
 *    │    ├─ trend-fast.systematic.fund.eth
 *    │    └─ …
 *    └─ macro.fund.eth
 *         └─ …
 *
 * The mapping onto the tree is one-to-one:
 *   - capital allocation  = the node's budget      (tree.resize)
 *   - allowed instruments = the node's allowlist   (attenuated fund → pod → agent)
 *   - stop-out            = resize to 0 + revoke   (tree.revoke)
 * so every allocator action lands in the same audited event log as payments.
 *
 * Money and authority are kept separate on purpose: PnL accrues to the fund's
 * NAV ledger here, while the tree holds how much each agent is *allowed* to run.
 */

import { DelegationTree, formatAmount, parseAmount } from "@allowance/core";
import {
  allocate,
  nextLadderState,
  scanCrowding,
  type AllocationPolicy,
  type CenterBookPolicy,
  type LadderState,
} from "./allocator";
import { preTradeCheck, type GateViolation } from "./gate";
import { cosineSimilarity } from "./stats";
import { SIM_START, type Market } from "./market";
import type { Observation, Strategy, Weights } from "./strategies";
import type { TrendThesis } from "./tigercub";

/* ------------------------------------------------------------------ */
/* Spec                                                               */
/* ------------------------------------------------------------------ */

export interface PodSpec {
  label: string;
  /** Instruments this pod may trade (⊆ fund universe). */
  instruments: string[];
}

export interface AgentSpec {
  label: string;
  pod: string;
  /**
   * Who runs the agent (e.g. a World ID nullifier). Optional; two agents with
   * the same operator are one counterparty however they are named.
   */
  operator?: string;
  /** Instruments this agent may trade (⊆ its pod's). */
  instruments: string[];
  strategy: Strategy;
}

export interface SwarmSpec {
  principal: string;
  /** Root name, e.g. "fund.eth". */
  fund: string;
  /** Assets under management, in whole USDC. */
  aum: number;
  pods: PodSpec[];
  agents: AgentSpec[];
  /** The research the fundamental PMs trade on, if any (see tigercub.ts). */
  thesis?: TrendThesis;
}

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

export type DecisionKind =
  | "ALLOCATE"
  | "REALLOCATE"
  | "CUT"
  | "RESTORE"
  | "STOP_OUT"
  | "CROWDING_CUT"
  | "GATE_CLIP";

export interface Decision {
  t: number;
  kind: DecisionKind;
  /** Full node name the decision applies to. */
  node: string;
  detail: string;
}

export interface AgentResult {
  label: string;
  name: string;
  pod: string;
  style: string;
  /** Attributable per-unit-of-capital returns (the strategy's own track record). */
  unitReturns: number[];
  /** Capital (USDC) the agent ran each tick. */
  capital: number[];
  /** Realized PnL (USDC) each tick. */
  pnl: number[];
  ladder: LadderState;
  gateViolations: number;
}

export interface BookResult {
  policy: AllocationPolicy;
  tree: DelegationTree;
  /** NAV before the first tick (= AUM). */
  startNav: number;
  /** NAV at the end of each tick (USDC). */
  nav: number[];
  /** Book return each tick. */
  returns: number[];
  /** Signed exposure to the crowded instrument as a share of NAV, each tick. */
  crowdExposure: number[];
  agents: AgentResult[];
  decisions: Decision[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Unix seconds for tick 0 of the simulation (fixed so runs are reproducible). */
export const SIM_EPOCH = Math.floor(SIM_START.getTime() / 1000);
const DAY = 86_400;

/** Unix seconds of a tick: ticks are trading days (252 per 365 calendar days). */
export function tickToUnix(t: number): number {
  return SIM_EPOCH + Math.round((t * 365) / 252) * DAY;
}

function toUnits(usdc: number): bigint {
  return parseAmount(Math.max(0, usdc).toFixed(6));
}

function toUsdc(units: bigint): number {
  return Number(formatAmount(units));
}

function describeViolation(v: GateViolation): string {
  switch (v.kind) {
    case "OFF_MANDATE":
      return `off-mandate instrument ${v.instrument} dropped`;
    case "GROSS_LIMIT":
      return `gross ${v.requested.toFixed(2)}x clipped to ${v.cap.toFixed(2)}x`;
    case "REVOKED":
      return "mandate revoked";
    case "EXPIRED":
      return "mandate expired";
  }
}

/**
 * Set every agent's budget to its target, keeping the tree valid at every step:
 * shrink agents → shrink pods → grow pods → grow agents. Shrinks free parent
 * budget before any grow draws on it, so attenuation never rejects a move.
 */
function applyTargets(
  tree: DelegationTree,
  podOf: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, bigint>,
): void {
  const budget = (n: string) => tree.requireNode(n).mandate.budget;
  const podTotals = new Map<string, bigint>();
  for (const [agent, pod] of podOf) {
    const target = targets.get(agent) ?? budget(agent);
    podTotals.set(pod, (podTotals.get(pod) ?? 0n) + target);
  }
  const live = (n: string) => !tree.isRevokedInChain(n);

  for (const [agent, target] of targets) {
    if (live(agent) && target < budget(agent)) tree.resize(agent, target);
  }
  for (const [pod, total] of podTotals) {
    if (live(pod) && total < budget(pod)) tree.resize(pod, total);
  }
  for (const [pod, total] of podTotals) {
    if (live(pod) && total > budget(pod)) tree.resize(pod, total);
  }
  for (const [agent, target] of targets) {
    if (live(agent) && target > budget(agent)) tree.resize(agent, target);
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

export async function runBook(
  market: Market,
  spec: SwarmSpec,
  policy: AllocationPolicy,
): Promise<BookResult> {
  const T = market.ticks.length;
  const expiry = tickToUnix(T + 30);
  const tree = new DelegationTree();
  tree.fundRoot({
    principal: spec.principal,
    rootName: spec.fund,
    mandate: { budget: toUnits(spec.aum), allowedMerchants: [...market.instruments], expiry },
  });

  // Start with equal allocations — the only defensible prior with no track record.
  const perAgent = (spec.aum * policy.deploy) / spec.agents.length;
  const podOf = new Map<string, string>();
  for (const pod of spec.pods) {
    const n = spec.agents.filter((a) => a.pod === pod.label).length;
    tree.delegate(spec.fund, pod.label, {
      budget: toUnits(perAgent) * BigInt(n),
      allowedMerchants: [...pod.instruments],
      expiry,
    });
  }
  const agents: AgentResult[] = spec.agents.map((a) => {
    const podName = `${a.pod}.${spec.fund}`;
    const node = tree.delegate(podName, a.label, {
      budget: toUnits(perAgent),
      allowedMerchants: [...a.instruments],
      expiry,
    });
    podOf.set(node.name, podName);
    return {
      label: a.label,
      name: node.name,
      pod: a.pod,
      style: a.strategy.style,
      unitReturns: [],
      capital: [],
      pnl: [],
      ladder: "active",
      gateViolations: 0,
    };
  });

  const decisions: Decision[] = agents.map((a) => ({
    t: 0,
    kind: "ALLOCATE" as const,
    node: a.name,
    detail: `initial equal allocation ${perAgent.toFixed(0)} USDC`,
  }));

  const center: CenterBookPolicy | null = policy.kind === "center" ? policy : null;
  // Active crowding cuts: the capital ceiling and the book the agent held when
  // it was cut. The ceiling holds until the agent's book stops resembling that
  // crowded book — NOT merely until the crowd shrinks to one member, or the last
  // clone standing would be re-sized straight back into the same trade.
  const crowdCaps = new Map<string, { cap: number; book: Weights }>();
  const history: Observation["history"][number][] = [];
  const nav: number[] = [];
  const bookReturns: number[] = [];
  const crowdExposure: number[] = [];
  let currentNav = spec.aum;
  const capitalOf = (a: AgentResult) => toUsdc(tree.requireNode(a.name).mandate.budget);

  for (let t = 0; t < T; t++) {
    const tick = market.ticks[t]!;
    const now = tickToUnix(t);

    /* 1) Scheduled reallocation (center book only). ---------------- */
    if (center && t >= center.warmup && (t - center.warmup) % center.rebalanceEvery === 0) {
      const deployable = center.deploy * Math.min(currentNav, spec.aum);
      const scores = allocate(
        agents.map((a) => ({
          name: a.name,
          unitReturns: a.unitReturns,
          stopped: a.ladder === "stopped",
          ladderMultiplier: a.ladder === "cut" ? center.cutFactor : 1,
          crowdCap: crowdCaps.get(a.name)?.cap,
        })),
        deployable,
        center,
      );
      const targets = new Map<string, bigint>();
      for (const s of scores) {
        const agent = agents.find((a) => a.name === s.name)!;
        if (agent.ladder === "stopped") continue;
        const current = capitalOf(agent);
        const moved = current === 0 ? (s.target > 0 ? Infinity : 0) : Math.abs(s.target - current) / current;
        if (moved < center.rebalanceBand) continue;
        targets.set(s.name, toUnits(s.target));
        decisions.push({
          t,
          kind: "REALLOCATE",
          node: s.name,
          detail:
            `${current.toFixed(0)} → ${s.target.toFixed(0)} USDC ` +
            `(sharpe ${s.sharpe.toFixed(2)}, shrunk ${s.shrunkSharpe.toFixed(2)}, ` +
            `same-bet ×${s.multiplicity.toFixed(2)})`,
        });
      }
      applyTargets(tree, podOf, targets);
    }

    /* 2) The swarm decides — every agent concurrently. -------------- */
    const proposals = await Promise.all(
      spec.agents.map((a) =>
        a.strategy.decide({
          t,
          universe: a.instruments,
          history,
          carry: tick.carry,
          viralSignal: tick.viralSignal,
        }),
      ),
    );

    /* 3) Per-agent pre-trade gate. ---------------------------------- */
    const gated = agents.map((a, i) => {
      const g = preTradeCheck(tree, a.name, proposals[i] ?? {}, { maxGross: 1, now });
      const clips = g.violations.filter((v) => v.kind === "OFF_MANDATE" || v.kind === "GROSS_LIMIT");
      if (clips.length > 0) {
        a.gateViolations += clips.length;
        // Log the first clip per agent, then only count — a rogue agent would
        // otherwise flood the decision log every tick.
        if (a.gateViolations === clips.length) {
          decisions.push({ t, kind: "GATE_CLIP", node: a.name, detail: clips.map(describeViolation).join("; ") });
        }
      }
      return g;
    });

    /* 4) Book-level crowding check on the proposed books (center only). */
    if (center) {
      const scan = scanCrowding(
        agents.map((a, i) => ({ name: a.name, capital: capitalOf(a), weights: gated[i]!.weights })),
        currentNav,
        center.leverage,
        center,
      );
      agents.forEach((a, i) => {
        const held = crowdCaps.get(a.name);
        if (held && cosineSimilarity(gated[i]!.weights, held.book) < center.crowdSimilarity) {
          crowdCaps.delete(a.name);
        }
      });

      for (const b of scan.breaches) {
        const targets = new Map<string, bigint>();
        for (const name of b.contributors) {
          const i = agents.findIndex((a) => a.name === name);
          // Breaches apply in order and a BOOK breach is solved on capital after
          // the CLONES cuts, so scaling the live budget compounds correctly.
          const cut = capitalOf(agents[i]!) * b.scale;
          const prior = crowdCaps.get(name);
          crowdCaps.set(name, { cap: prior ? Math.min(prior.cap, cut) : cut, book: gated[i]!.weights });
          targets.set(name, toUnits(cut));
        }
        applyTargets(tree, podOf, targets);
        const podCount = (names: string[]) => new Set(names.map((m) => podOf.get(m))).size;
        const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
        decisions.push({
          t,
          kind: "CROWDING_CUT",
          node: b.contributors.join(", "),
          detail:
            (b.kind === "CLONES"
              ? `${plural(b.members.length, "agent")} across ${plural(podCount(b.members), "pod")} running one trade in ${b.instrument}`
              : `book net ${b.instrument} exposure (${plural(b.contributors.length, "agent")} across ${plural(podCount(b.contributors), "pod")})`) +
            `: ${(b.share * 100).toFixed(1)}% of NAV > ${(b.limit * 100).toFixed(0)}% limit → ` +
            `contributors scaled ×${b.scale.toFixed(2)}`,
        });
      }
    }

    /* 5) Mark to market. -------------------------------------------- */
    let tickPnl = 0;
    let crowdNotional = 0;
    const crowdName = market.config.crowd.instrument;
    agents.forEach((a, i) => {
      const g = gated[i]!;
      let unit = 0;
      for (const [k, w] of Object.entries(g.clipped)) unit += policy.leverage * w * (tick.returns[k] ?? 0);
      const capital = capitalOf(a);
      let live = 0;
      for (const [k, w] of Object.entries(g.weights)) live += policy.leverage * w * (tick.returns[k] ?? 0);
      const pnl = capital * live;
      crowdNotional += capital * policy.leverage * (g.weights[crowdName] ?? 0);
      a.unitReturns.push(unit);
      a.capital.push(capital);
      a.pnl.push(pnl);
      tickPnl += pnl;
    });
    crowdExposure.push(crowdNotional / currentNav);
    const prevNav = currentNav;
    currentNav += tickPnl;
    nav.push(currentNav);
    bookReturns.push(tickPnl / prevNav);
    history.push(tick.returns);

    /* 6) Drawdown ladder. -------------------------------------------- */
    for (const a of agents) {
      const next = nextLadderState(a.ladder, a.unitReturns, {
        ddStop: policy.ddStop,
        ddCut: center?.ddCut,
        ddRecover: center?.ddRecover,
      });
      if (next === a.ladder) continue;
      const capital = capitalOf(a);
      if (next === "stopped") {
        // Stop-out: hand the capital back up the tree, then revoke authority.
        applyTargets(tree, podOf, new Map([[a.name, 0n]]));
        tree.revoke(a.name);
        decisions.push({
          t,
          kind: "STOP_OUT",
          node: a.name,
          detail:
            `drawdown ≥ ${(policy.ddStop * 100).toFixed(0)}% → mandate revoked, ` +
            (capital > 0 ? `${capital.toFixed(0)} USDC handed back to the pod` : "no capital was at risk (already allocated zero)"),
        });
      } else if (next === "cut" && center) {
        applyTargets(tree, podOf, new Map([[a.name, toUnits(capital * center.cutFactor)]]));
        decisions.push({ t, kind: "CUT", node: a.name, detail: `drawdown ≥ ${(center.ddCut * 100).toFixed(0)}% → capital ×${center.cutFactor}` });
      } else if (next === "active" && center) {
        decisions.push({ t, kind: "RESTORE", node: a.name, detail: `recovered to within ${(center.ddRecover * 100).toFixed(0)}% of high-water mark; full sizing at next reallocation` });
      }
      a.ladder = next;
    }
  }

  return { policy, tree, startNav: spec.aum, nav, returns: bookReturns, crowdExposure, agents, decisions };
}
