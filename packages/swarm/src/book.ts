/**
 * The book: runs a swarm of agents against a market under an allocation policy,
 * with the Allowance mandate tree as the single source of authority.
 *
 *   fund.eth                      ← principal funds the root with AUM
 *    ├─ systematic.fund.eth       ← pods: budget = sum of their agents
 *    │    ├─ trend-fast.systematic.fund.eth
 *    │    │    └─ exec.trend-fast.systematic.fund.eth   ← optional sub-mandate:
 *    │    └─ …                                             a slice of the agent's budget
 *    └─ macro.fund.eth
 *         └─ …
 *
 * The mapping onto the tree is one-to-one:
 *   - capital allocation  = the node's budget      (tree.resize; sub-mandates keep their slice)
 *   - allowed instruments = the node's allowlist   (attenuated fund → pod → agent → sub)
 *   - stop-out            = tree.close(agent)      (the agent AND every sub-mandate it
 *                           handed out shrink to what they spent and are revoked, in one
 *                           operation; the unspent authority is back in the pod); the
 *                           drawdown rungs are risk-scaled in the center book
 *   - counterparty        = AgentSpec.operator     (a stop-out of one name caps the
 *                           operator's other live names at cutFactor of their full size,
 *                           as a group in one applyTargets plan, until each recovers on
 *                           its own record; a ceiling kept apart from the name's own
 *                           size, so a name holds min(own size, ceiling): the cap never
 *                           compounds with a ladder cut or an earlier cap, never weakens
 *                           the name's own ladder, and never revokes)
 *   - trading size        = available × leverage   (available = the budget − what the node
 *                           spent itself − what it handed down; sized by `sizeOrder` in the
 *                           gate, never from a number the book keeps)
 * so every allocator action lands in the same audited event log as payments.
 *
 * The tree's invariants (`bookViolations`) are checked twice a tick: before the
 * tick trades (after anything outside the book, see `RunBookOptions.onTick`,
 * has acted) and at its end. Children never exceed their parent, nothing is
 * over-committed, the root still holds the AUM, every revoked mandate is
 * closed (no authority stranded under a dead node), every stopped agent is
 * closed and every live one is not. Between the two, every order the tick is
 * about to mark is checked against the tree as it then stands
 * (`tradeViolations`): no agent's gross notional exceeds its available
 * authority × leverage, a closed agent trades nothing, and nothing off its
 * allowlist is held. A violation throws `BookInvariantError`: no tick trades
 * on a tree that failed the check, no order is marked that exceeds its
 * reservation, and a break made during a tick is caught before the next one
 * starts.
 *
 * Money and authority are kept separate on purpose: PnL accrues to the fund's
 * NAV ledger here, while the tree holds how much each agent is *allowed* to run.
 */

import { DelegationTree, formatAmount, parseAmount } from "@allowance/core";
import {
  allocate,
  cutTo,
  ladderStep,
  nextCounterpartyCaps,
  nextSizing,
  rebalanceMove,
  scanCrowding,
  sizedBudget,
  type AllocationPolicy,
  type CenterBookPolicy,
  type CounterpartyCap,
  type LadderState,
  type OperatorSizing,
  type SizingEvent,
} from "./allocator";
import { orderNotional, orderPnl, preTradeCheck, sizeOrder, type GateViolation, type SizedOrder } from "./gate";
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
  /**
   * Sub-mandates the agent hands down (an execution desk, a data scraper…).
   * Each is a child node holding a slice of the agent's budget: reserved when
   * granted, resized with the agent, and closed with it on a stop-out.
   */
  subMandates?: SubMandateSpec[];
}

export interface SubMandateSpec {
  /** Left-most label: the node is `<label>.<agent>.<pod>.<fund>`. */
  label: string;
  /**
   * Share of the agent's budget reserved for it, in [0, 1]. Shares are cut in
   * whole parts per million (`sharePpm`), and one agent's must sum to at most
   * 1,000,000 ppm, so its slices always fit inside its budget. A sub-mandate
   * never shrinks below what it has spent or delegated.
   */
  share: number;
  /** What it may trade or pay for (⊆ the agent's). Defaults to the agent's list. */
  instruments?: string[];
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
  | "OPERATOR_CUT"
  | "OPERATOR_RESTORE"
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
  /** Who runs the agent (`AgentSpec.operator`), if known. */
  operator?: string;
  /** Attributable per-unit-of-capital returns (the strategy's own track record). */
  unitReturns: number[];
  /**
   * Capital (USDC) the agent ran each tick: the authority its order was sized
   * on, i.e. its mandate's available authority at the trade (0 once closed).
   */
  capital: number[];
  /**
   * The agent's full size in force each tick (USDC): what the allocator gives
   * it when nothing cuts or caps it (the equal initial allocation until the
   * first reallocation, then its share of deployable capital at the latest
   * one; 0 once its mandate is closed). An operator cap is a fraction of this.
   */
  fullSize: number[];
  /**
   * The agent's OWN size each tick (USDC, a budget, like `fullSize`): what its
   * own rules give it, i.e. what it would hold with no operator (see
   * `OperatorSizing`). Its budget is this, or its operator's ceiling
   * (cutFactor × `fullSize`) while one holds it, whichever is smaller. 0 once
   * its mandate is closed.
   */
  ownSize: number[];
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

/** `usdc` rounded to whole micro-USDC, as a budget in the tree is. */
function asBudget(usdc: number): number {
  return toUsdc(toUnits(usdc));
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

const PPM = 1_000_000n;

/** A share in whole parts per million: the unit sub-mandate slices are cut in. */
export function sharePpm(share: number): bigint {
  return BigInt(Math.round(share * 1_000_000));
}

/** `ppm` parts per million of `budget`, rounded down (so slices never sum above it). */
function slice(budget: bigint, ppm: bigint): bigint {
  return (budget * ppm) / PPM;
}

/** Agent node → the sub-mandates it handed out, with each one's share of its budget. */
export type SubMandates = ReadonlyMap<string, readonly { name: string; ppm: bigint }[]>;

/**
 * Set every agent's budget to its target, keeping the tree valid at every step:
 * shrink sub-mandates → shrink agents → shrink pods → grow pods → grow agents →
 * grow sub-mandates. Every shrink frees its parent's budget before any grow
 * draws on it, no node is shrunk below what it has committed (spent plus
 * delegated), and every grow is clipped to what its parent still has
 * available, so on a sound tree it never makes a move the tree refuses. A
 * grow is clipped only when its parent has no authority left to give; in the
 * book that takes sub-mandates whose spent (hence unreclaimable) authority
 * has used up the fund's undeployed buffer. The allocator's target is then a
 * ceiling, not a claim on authority the fund no longer holds.
 *
 * A sub-mandate is a slice of its agent: it is resized to its share of the
 * agent's target (of what the agent actually got, if its grow was clipped),
 * but never below what it has itself committed. If those floors (plus the
 * agent's own spend and any children the book does not manage) exceed the
 * target, the agent keeps the floor: authority that was already spent cannot
 * be taken back.
 */
export function applyTargets(
  tree: DelegationTree,
  podOf: ReadonlyMap<string, string>,
  subsOf: SubMandates,
  targets: ReadonlyMap<string, bigint>,
): void {
  const budget = (n: string) => tree.requireNode(n).mandate.budget;
  const committed = (n: string) => tree.requireNode(n).mandate.spentDirect + tree.reserved(n);
  const live = (n: string) => !tree.isRevokedInChain(n);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  // The agent's live sub-mandates, each sized to its slice of `of`, floored at what it committed.
  const slices = (agent: string, of: bigint) =>
    (subsOf.get(agent) ?? [])
      .filter((sub) => live(sub.name))
      .map((sub) => ({ name: sub.name, budget: max(committed(sub.name), slice(of, sub.ppm)) }));

  const plan = new Map<string, { target: bigint; budget: bigint; subs: { name: string; budget: bigint }[] }>();
  for (const [agent, target] of targets) {
    if (!live(agent)) continue;
    const subs = slices(agent, target);
    const mine = new Set(subs.map((sub) => sub.name));
    let floor = tree.requireNode(agent).mandate.spentDirect;
    for (const child of tree.childrenOf(agent)) if (!mine.has(child.name)) floor += child.mandate.budget;
    for (const sub of subs) floor += sub.budget;
    plan.set(agent, { target, budget: max(target, floor), subs });
  }
  // A pod holds exactly what its children will hold (plus anything it spent itself).
  const podTotals = new Map<string, bigint>();
  for (const pod of new Set(podOf.values())) {
    let total = tree.requireNode(pod).mandate.spentDirect;
    for (const child of tree.childrenOf(pod)) total += plan.get(child.name)?.budget ?? child.mandate.budget;
    podTotals.set(pod, total);
  }
  // Grow `n` toward `want` out of its parent's available authority, never past it.
  const grow = (n: string, want: bigint): void => {
    const node = tree.requireNode(n);
    const room = node.parent === null ? 0n : tree.available(node.parent);
    if (want <= node.mandate.budget || room <= 0n || !live(n)) return;
    tree.resize(n, node.mandate.budget + min(want - node.mandate.budget, room));
  };

  for (const p of plan.values()) {
    for (const sub of p.subs) if (sub.budget < budget(sub.name)) tree.resize(sub.name, sub.budget);
  }
  for (const [agent, p] of plan) {
    if (p.budget < budget(agent)) tree.resize(agent, p.budget);
  }
  for (const [pod, total] of podTotals) {
    if (live(pod) && total < budget(pod)) tree.resize(pod, total);
  }
  for (const [pod, total] of podTotals) grow(pod, total);
  for (const [agent, p] of plan) {
    grow(agent, p.budget);
    const got = budget(agent);
    if (got < p.budget) {
      // Clipped: its sub-mandates are cut from what it got (this only shrinks them).
      p.subs = slices(agent, min(p.target, got));
      for (const sub of p.subs) if (sub.budget < budget(sub.name)) tree.resize(sub.name, sub.budget);
    }
  }
  for (const p of plan.values()) {
    for (const sub of p.subs) grow(sub.name, sub.budget);
  }
}

/* ------------------------------------------------------------------ */
/* Invariants                                                         */
/* ------------------------------------------------------------------ */

/**
 * Thrown by `runBook` when the tree breaks one of the book's invariants, at
 * tick `t`: at its `"start"` (before it trades), at the `"trade"` (an order
 * about to be marked breaks its mandate, see `tradeViolations`) or at its
 * `"end"`.
 */
export class BookInvariantError extends Error {
  constructor(
    readonly t: number,
    readonly at: "start" | "trade" | "end",
    readonly violations: readonly string[],
  ) {
    super(`book invariant broken at the ${at} of tick ${t}: ${violations.join("; ")}`);
    this.name = "BookInvariantError";
  }
}

/**
 * Every standing guarantee of the book's tree, as a list of violations (empty
 * when sound). `runBook` checks it at the start of every tick, before it
 * trades, and at its end:
 *
 *  (R) reservation: the core audit (no node has handed down or spent more
 *      than it holds, i.e. children ≤ parent and available ≥ 0; allowlists,
 *      purposes and expiry attenuate; no negative budget, no broken link), and
 *      the root still holds exactly the AUM it was funded with.
 *  (C) close: every revoked mandate is CLOSED, so nothing under it holds
 *      unspent authority. A dead subtree can neither spend nor strand capital
 *      its pod could reuse. Every stopped agent's mandate is dead (revoked,
 *      hence closed), and no agent that is not stopped sits in a dead subtree.
 */
export function bookViolations(
  tree: DelegationTree,
  root: { name: string; budget: bigint },
  agents: readonly { name: string; ladder: LadderState }[],
): string[] {
  const out = tree.audit().map((v) => `${v.kind} ${v.node}: ${v.message}`);
  const rootBudget = tree.requireNode(root.name).mandate.budget;
  if (rootBudget !== root.budget) out.push(`ROOT_CHANGED ${root.name}: budget ${rootBudget} != funded ${root.budget}`);
  for (const node of tree.listNodes()) {
    if (node.mandate.revoked && !tree.isClosed(node.name)) {
      const stranded = tree.subtree(node.name).reduce((s, n) => s + tree.available(n.name), 0n);
      out.push(`NOT_CLOSED ${node.name}: revoked but its subtree still holds ${stranded} unspent`);
    }
  }
  for (const a of agents) {
    const dead = tree.isRevokedInChain(a.name);
    if (a.ladder === "stopped" && !dead) out.push(`STOP_NOT_REVOKED ${a.name}: stopped out, but its mandate is live`);
    if (a.ladder !== "stopped" && dead) out.push(`LIVE_BUT_REVOKED ${a.name}: not stopped out, but its mandate is dead`);
  }
  return out;
}

/**
 * Relative slack on the notional bound in `tradeViolations`: the gate leaves
 * Σ|w| unclipped up to 1 + 1e-9, and the sums are floating point. On $20M of
 * notional that is 20 cents; nothing larger passes.
 */
export const TRADE_SLACK = 1e-8;

/**
 * (R) at the trade: the orders a tick is about to mark, checked against the
 * tree as it stands at that moment (after every allocator and crowding write
 * of the tick), as a list of violations (empty when sound). `runBook` checks
 * it every tick, after sizing and before anything is marked:
 *
 *  - OVER_RESERVATION  an order's gross notional exceeds its mandate's
 *                      available authority × `leverage` (the policy's gross
 *                      leverage; the gate keeps Σ|w| ≤ 1). The reservation, not
 *                      any number the book keeps, bounds what an agent trades.
 *  - DEAD_TRADES       its mandate (or an ancestor) is revoked or expired and
 *                      it still trades: a closed agent trades nothing.
 *  - OFF_MANDATE       it holds an instrument outside its node's allowlist.
 *  - NOT_FINITE        a non-finite authority, leverage or notional (NaN would
 *                      pass every comparison above).
 *  - UNKNOWN_NODE      the order names no node of the tree.
 *
 * The notional bound is checked up to `TRADE_SLACK`.
 */
export function tradeViolations(
  tree: DelegationTree,
  orders: readonly SizedOrder[],
  opts: { leverage: number; now: number },
): string[] {
  const out: string[] = [];
  for (const o of orders) {
    if (!tree.getNode(o.node)) {
      out.push(`UNKNOWN_NODE ${o.node}: no such mandate`);
      continue;
    }
    const notional = Object.entries(orderNotional(o));
    if (!Number.isFinite(o.authority) || !Number.isFinite(o.leverage) || notional.some(([, n]) => !Number.isFinite(n))) {
      out.push(`NOT_FINITE ${o.node}: authority ${o.authority}, leverage ${o.leverage}`);
      continue;
    }
    const gross = notional.reduce((s, [, n]) => s + Math.abs(n), 0);
    if (tree.isRevokedInChain(o.node) || tree.isExpiredInChain(o.node, opts.now)) {
      if (gross > 0) out.push(`DEAD_TRADES ${o.node}: its mandate is dead, yet it trades ${gross.toFixed(2)} USDC gross`);
      continue;
    }
    const available = toUsdc(tree.available(o.node));
    if (gross > available * opts.leverage * (1 + TRADE_SLACK)) {
      out.push(
        `OVER_RESERVATION ${o.node}: gross notional ${gross.toFixed(2)} > available ${available.toFixed(2)} × leverage ${opts.leverage}`,
      );
    }
    const allowed = tree.requireNode(o.node).mandate.allowedMerchants;
    for (const [k, n] of notional) {
      if (n !== 0 && allowed !== undefined && !allowed.includes(k)) out.push(`OFF_MANDATE ${o.node}: holds ${k}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

export interface RunBookOptions {
  /**
   * Called at the start of every tick, before the allocator acts, with the
   * live tree: the seam through which agents' sub-mandates act outside the
   * book (e.g. a data sub-agent paying a vendor through core's `pay()`), and
   * through which a test can watch the tree tick by tick. Whatever it does is
   * held to the book's invariants before the tick trades.
   */
  onTick?: (t: number, tree: DelegationTree) => void | Promise<void>;
  /**
   * Called every tick once the orders are sized from the tree (after the
   * crowding check), just before they are audited and marked, with one order
   * per agent in roster order: the seam through which an execution layer
   * outside the book receives the orders, and through which a test can watch
   * (or tamper with) them. Whatever it does to them is held to
   * `tradeViolations`, against the tree as it then stands, before anything is
   * marked; what is marked is exactly these orders. What it does to the tree
   * is held to `bookViolations` at the tick's end, like any mid-tick change.
   */
  onTrade?: (t: number, tree: DelegationTree, orders: readonly SizedOrder[]) => void | Promise<void>;
}

export async function runBook(
  market: Market,
  spec: SwarmSpec,
  policy: AllocationPolicy,
  options: RunBookOptions = {},
): Promise<BookResult> {
  const T = market.ticks.length;
  const expiry = tickToUnix(T + 30);
  const tree = new DelegationTree();
  const root = { name: spec.fund, budget: toUnits(spec.aum) };
  tree.fundRoot({
    principal: spec.principal,
    rootName: spec.fund,
    mandate: { budget: root.budget, allowedMerchants: [...market.instruments], expiry },
  });

  // Start with equal allocations — the only defensible prior with no track record.
  const perAgent = (spec.aum * policy.deploy) / spec.agents.length;
  const podOf = new Map<string, string>();
  const subsOf = new Map<string, { name: string; ppm: bigint }[]>();
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
    if (a.subMandates?.length) {
      // Validated in the unit the slices are cut in, so shares that pass always
      // fit: Σ ppm ≤ 1,000,000 ⇒ Σ slices ≤ the agent's budget.
      const ppms = a.subMandates.map((sm) => {
        if (!Number.isFinite(sm.share) || sm.share < 0 || sm.share > 1) {
          throw new Error(`${node.name}: sub-mandate share ${sm.share} is not in [0, 1]`);
        }
        return sharePpm(sm.share);
      });
      const total = ppms.reduce((s, x) => s + x, 0n);
      if (total > PPM) {
        throw new Error(`${node.name}: sub-mandate shares sum to ${total} ppm, more than the agent's whole budget`);
      }
      // Each sub-mandate is reserved out of the agent's budget as it is granted.
      subsOf.set(
        node.name,
        a.subMandates.map((sm, i) => ({
          name: tree.delegate(node.name, sm.label, {
            budget: slice(node.mandate.budget, ppms[i]!),
            allowedMerchants: [...(sm.instruments ?? a.instruments)],
            expiry,
          }).name,
          ppm: ppms[i]!,
        })),
      );
    }
    return {
      label: a.label,
      name: node.name,
      pod: a.pod,
      style: a.strategy.style,
      ...(a.operator === undefined ? {} : { operator: a.operator }),
      unitReturns: [],
      capital: [],
      fullSize: [],
      ownSize: [],
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
  // Each agent's full size (see `AgentResult.fullSize`), and the names capped
  // because another name of the same operator was stopped out. The cap is a
  // ceiling on capital (`OperatorSizing`), a fraction of that full size.
  const fullSize = new Map<string, number>(agents.map((a) => [a.name, perAgent]));
  let operatorCaps: ReadonlyMap<string, CounterpartyCap> = new Map();
  // The operator cap is a cut to `cutFactor`: without a cut factor below 1 there is none.
  const capFactor = center?.cutFactor !== undefined && center.cutFactor < 1 ? center.cutFactor : null;
  // Every name an operator ceiling holds (capped, or lifted and not yet
  // re-sized), with its OWN size kept apart from the ceiling: it holds the
  // smaller of the two (`OperatorSizing`). A name without an entry holds its
  // own size, which is then simply its budget in the tree.
  const holds = new Map<string, OperatorSizing & { ceiling: number }>();
  const sizingPolicy = { cutFactor: capFactor ?? 1, rebalanceBand: center?.rebalanceBand ?? 0 };
  const history: Observation["history"][number][] = [];
  const nav: number[] = [];
  const bookReturns: number[] = [];
  const crowdExposure: number[] = [];
  let currentNav = spec.aum;
  // The allocator's lever: the agent's budget in the tree, 0 once its mandate
  // is closed (what is left of the budget is then only the record of what its
  // subtree spent). Reallocation bands, crowding cuts and the cut rung are
  // decided on it. It never sizes a trade: every order is sized by the gate
  // from the mandate's AVAILABLE authority and audited against the tree.
  const budgetOf = (a: AgentResult) =>
    tree.isRevokedInChain(a.name) ? 0 : toUsdc(tree.requireNode(a.name).mandate.budget);
  // Move a name's sizing by one event and return the budget it now holds (a
  // name with no hold starts from its budget in the tree, which is its own
  // size). Its own size is kept in whole micro-USDC, as a budget in the tree
  // is; the entry is dropped once no ceiling holds the name.
  const moveHeld = (a: AgentResult, e: SizingEvent): number => {
    const next = nextSizing(holds.get(a.name) ?? { own: budgetOf(a), ceiling: null }, e, sizingPolicy);
    const own = asBudget(next.own);
    if (next.ceiling === null) holds.delete(a.name);
    else holds.set(a.name, { own, ceiling: next.ceiling });
    return sizedBudget({ own, ceiling: next.ceiling });
  };
  const size = (gated: readonly { weights: Weights }[], now: number): SizedOrder[] =>
    agents.map((a, i) => sizeOrder(tree, a.name, gated[i]!.weights, { leverage: policy.leverage, now }));
  const audit = (t: number, at: "start" | "end") => {
    const violations = bookViolations(tree, root, agents);
    if (violations.length > 0) throw new BookInvariantError(t, at, violations);
  };
  const auditTrade = (t: number, orders: readonly SizedOrder[], now: number) => {
    if (orders.length !== agents.length || agents.some((a, i) => orders[i]?.node !== a.name)) {
      throw new BookInvariantError(t, "trade", [
        `ORDERS_MISMATCH: ${orders.length} orders for ${agents.length} agents, or not one per agent in roster order`,
      ]);
    }
    const violations = tradeViolations(tree, orders, { leverage: policy.leverage, now });
    if (violations.length > 0) throw new BookInvariantError(t, "trade", violations);
  };

  for (let t = 0; t < T; t++) {
    const tick = market.ticks[t]!;
    const now = tickToUnix(t);
    await options.onTick?.(t, tree);
    // Nothing trades on a tree that fails the audit (at t = 0 this checks setup).
    audit(t, "start");

    /* 1) Scheduled reallocation (center book only). ---------------- */
    if (center && t >= center.warmup && (t - center.warmup) % center.rebalanceEvery === 0) {
      const deployable = center.deploy * Math.min(currentNav, spec.aum);
      // Each name's OWN target: its ladder's cut and any crowding cap, and no
      // operator cap. An operator's ceiling is applied on top (`holds`).
      const scores = allocate(
        agents.map((a) => ({
          name: a.name,
          unitReturns: a.unitReturns,
          stopped: a.ladder === "stopped",
          ladderMultiplier: a.ladder === "cut" ? (center.cutFactor ?? 1) : 1,
          crowdCap: crowdCaps.get(a.name)?.cap,
        })),
        deployable,
        center,
      );
      const targets = new Map<string, bigint>();
      for (const s of scores) {
        fullSize.set(s.name, s.fullTarget);
        const agent = agents.find((a) => a.name === s.name)!;
        if (agent.ladder === "stopped") continue;
        const current = budgetOf(agent);
        const record = `(sharpe ${s.sharpe.toFixed(2)}, shrunk ${s.shrunkSharpe.toFixed(2)}, same-bet ×${s.multiplicity.toFixed(2)})`;
        const held = holds.get(s.name);
        if (held) {
          // Its own size moves as every budget does (to its own target, under
          // the band). The ceiling is refreshed at its new full size while the
          // cap is in force, and dropped once the cap has lifted. It holds the
          // smaller of the two, exactly: no band on top.
          const capped = operatorCaps.has(s.name);
          const to = moveHeld(agent, { kind: "reallocate", target: s.target, fullSize: s.fullTarget, capped });
          if (toUnits(to) === toUnits(current)) continue;
          targets.set(s.name, toUnits(to));
          decisions.push({
            t,
            kind: "REALLOCATE",
            node: s.name,
            detail:
              `${current.toFixed(0)} → ${to.toFixed(0)} USDC ` +
              (capped
                ? `(its own size ${held.own.toFixed(0)} → ${holds.get(s.name)!.own.toFixed(0)}, under its operator's cap ` +
                  `at ×${capFactor} of its full size ${s.fullTarget.toFixed(0)}) `
                : "(its operator's cap has lifted: back to its own size) ") +
              record,
          });
          continue;
        }
        if (rebalanceMove(current, s.target) < center.rebalanceBand) continue;
        targets.set(s.name, toUnits(s.target));
        decisions.push({
          t,
          kind: "REALLOCATE",
          node: s.name,
          detail: `${current.toFixed(0)} → ${s.target.toFixed(0)} USDC ${record}`,
        });
      }
      applyTargets(tree, podOf, subsOf, targets);
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
      // Exposure is measured on what each agent would trade now: its gated
      // weights sized from the tree as it stands before any cut.
      const scan = scanCrowding(
        size(gated, now).map((o) => ({ name: o.node, capital: o.authority, weights: o.weights })),
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
          const cut = budgetOf(agents[i]!) * b.scale;
          const prior = crowdCaps.get(name);
          crowdCaps.set(name, { cap: prior ? Math.min(prior.cap, cut) : cut, book: gated[i]!.weights });
          targets.set(name, toUnits(cut));
          // A held name's own size is cut to the same level: it holds `cut` either way.
          if (holds.has(name)) moveHeld(agents[i]!, { kind: "crowdCut", to: cut });
        }
        applyTargets(tree, podOf, subsOf, targets);
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

    /* 5) Size every order from the tree, audit it, mark it. --------- */
    // Sized after the crowding cuts, from each mandate's available authority
    // as it now stands. No order is marked before it passes the audit, and
    // what is marked is exactly the audited order.
    const orders = size(gated, now);
    await options.onTrade?.(t, tree, orders);
    auditTrade(t, orders, now);
    let tickPnl = 0;
    let crowdNotional = 0;
    const crowdName = market.config.crowd.instrument;
    agents.forEach((a, i) => {
      const g = gated[i]!;
      const order = orders[i]!;
      let unit = 0;
      for (const [k, w] of Object.entries(g.clipped)) unit += policy.leverage * w * (tick.returns[k] ?? 0);
      const pnl = orderPnl(order, tick.returns);
      crowdNotional += order.authority * order.leverage * (order.weights[crowdName] ?? 0);
      a.unitReturns.push(unit);
      a.capital.push(order.authority);
      a.fullSize.push(tree.isRevokedInChain(a.name) ? 0 : fullSize.get(a.name)!);
      a.ownSize.push(tree.isRevokedInChain(a.name) ? 0 : (holds.get(a.name)?.own ?? budgetOf(a)));
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
    const stoppedNow: string[] = [];
    const restoredNow: string[] = [];
    for (const a of agents) {
      if (a.ladder === "stopped") continue;
      // The rungs in force for THIS record: the center book widens them to the
      // risk the agent runs (never below the fixed percentages); per-agent
      // guardrails keep the fixed stop-loss.
      const { next, rungs } = ladderStep(a.ladder, a.unitReturns, {
        ddStop: policy.ddStop,
        ddCut: center?.ddCut,
        ddRecover: center?.ddRecover,
        ddStopVol: center?.ddStopVol,
        volWindow: center?.window,
        ddStopMax: center?.ddStopMax,
      });
      if (next === a.ladder) continue;
      const pct = (x: number | undefined) => `${((x ?? 0) * 100).toFixed(0)}%`;
      const why = rungs.scale > 1 ? ` (rungs risk-scaled ×${rungs.scale.toFixed(2)}: the agent runs ${pct(rungs.vol)} vol)` : "";
      const capital = budgetOf(a);
      if (next === "stopped") {
        // Stop-out: ONE tree.close takes back the agent's capital and every
        // sub-mandate it handed out (each shrinks to what it spent, then the
        // subtree is revoked). The freed authority is available to the pod.
        const subs = tree.subtree(a.name).length - 1;
        const freed = toUsdc(tree.close(a.name));
        holds.delete(a.name);
        stoppedNow.push(a.name);
        decisions.push({
          t,
          kind: "STOP_OUT",
          node: a.name,
          detail:
            `drawdown ≥ ${pct(rungs.ddStop)}${why} → mandate closed` +
            (subs > 0 ? ` with its ${subs} sub-mandate${subs === 1 ? "" : "s"}` : "") +
            ", " +
            (freed > 0 ? `${freed.toFixed(0)} USDC handed back to the pod` : "no capital was at risk (already allocated zero)"),
        });
      } else if (next === "cut" && center) {
        const factor = center.cutFactor ?? 1;
        const held = holds.get(a.name);
        if (held) {
          // An operator ceiling holds it below its own size. Its ladder cuts its
          // OWN size, as it cuts every name's, and it holds the smaller of that
          // and the ceiling: never more than its ladder alone allows, and not
          // cut again where the ceiling already holds it.
          const to = cutTo(capital, moveHeld(a, { kind: "ladderCut" }));
          if (to !== null) applyTargets(tree, podOf, subsOf, new Map([[a.name, toUnits(to)]]));
          decisions.push({
            t,
            kind: "CUT",
            node: a.name,
            detail:
              `drawdown ≥ ${pct(rungs.ddCut)}${why} → its own size ×${factor} ` +
              `(${held.own.toFixed(0)} → ${holds.get(a.name)!.own.toFixed(0)} USDC), under its operator's ceiling ` +
              `${held.ceiling.toFixed(0)} ` +
              (to === null ? `(it holds ${capital.toFixed(0)}: not cut again)` : `(${capital.toFixed(0)} → ${to.toFixed(0)} USDC)`),
          });
        } else {
          applyTargets(tree, podOf, subsOf, new Map([[a.name, toUnits(capital * factor)]]));
          decisions.push({ t, kind: "CUT", node: a.name, detail: `drawdown ≥ ${pct(rungs.ddCut)}${why} → capital ×${factor}` });
        }
      } else if (next === "active" && center) {
        restoredNow.push(a.name);
        decisions.push({ t, kind: "RESTORE", node: a.name, detail: `recovered to within ${pct(rungs.ddRecover)} of high-water mark; full sizing at next reallocation` });
      }
      a.ladder = next;
    }

    /* 6b) Counterparties (center book only). ------------------------- */
    // After every name's own ladder has moved this tick: it reads the ladders
    // and never writes one, and it only ever shrinks capital, so it can
    // neither delay nor bring forward any stop-out.
    if (capFactor !== null) {
      const update = nextCounterpartyCaps(
        operatorCaps,
        agents.map((a) => ({ name: a.name, operator: a.operator, ladder: a.ladder, unitReturns: a.unitReturns })),
        stoppedNow,
        restoredNow,
        t,
      );
      for (const name of update.lifted) {
        decisions.push({
          t,
          kind: "OPERATOR_RESTORE",
          node: name,
          detail:
            (restoredNow.includes(name) ? "its own ladder lifted its cut" : "new high on its own record") +
            " since its operator's stop-out; full sizing at next reallocation",
        });
      }
      // The whole group in ONE plan: shrinks, then the pods, in one applyTargets.
      const cuts = new Map<string, bigint>();
      for (const { name, after } of update.capped) {
        const agent = agents.find((a) => a.name === name)!;
        const capital = budgetOf(agent);
        const full = fullSize.get(name)!;
        // The ceiling is cutFactor × its full size however many caps came
        // before, and its own size is untouched: a name lifted and not yet
        // re-sized keeps the own size its hold kept, not the capped budget.
        const to = cutTo(capital, moveHeld(agent, { kind: "cap", fullSize: full }));
        if (to !== null) cuts.set(name, toUnits(to));
        decisions.push({
          t,
          kind: "OPERATOR_CUT",
          node: name,
          detail:
            `same operator as ${after}, stopped out → capped at ×${capFactor} of its full size ${full.toFixed(0)} USDC ` +
            (to === null
              ? `(it already holds ${capital.toFixed(0)}: not cut again)`
              : `(${capital.toFixed(0)} → ${to.toFixed(0)} USDC)`) +
            " until it recovers on its own record (a new high, or its ladder lifting a cut); its own ladder is unchanged",
        });
      }
      if (cuts.size > 0) applyTargets(tree, podOf, subsOf, cuts);
      operatorCaps = update.caps;
    }

    /* 7) Invariants: a break made during the tick is caught before the next. */
    audit(t, "end");
  }

  return { policy, tree, startNav: spec.aum, nav, returns: bookReturns, crowdExposure, agents, decisions };
}
