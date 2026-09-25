/**
 * Pure view-model helpers for the fund console: the decision log (routine
 * reallocations collapsed per rebalance), the mandate tree at any decision
 * tick, and the fund → pods → agents hierarchy. No React, so they are unit
 * tested in ../fund.test.ts.
 */

import type { FundAgent, FundDecision, FundSnapshot, GroupCut, LoopEvidence, StopOut, TreeState, Uplift } from "./types";

/* -------------------------------------------------------------------------- */
/* Decision log                                                                */
/* -------------------------------------------------------------------------- */

export interface Move {
  agent: string;
  from: number | null;
  to: number | null;
  detail: string;
}

export type LogEntry =
  | { id: string; t: number; type: "grant"; agents: number; each: number | null }
  | { id: string; t: number; type: "rebalance"; moves: Move[] }
  | { id: string; t: number; type: "group"; cut: GroupCut }
  | { id: string; t: number; type: "stopout"; stop: StopOut }
  | { id: string; t: number; type: "ladder"; kind: "CUT" | "RESTORE"; agent: string; detail: string }
  | { id: string; t: number; type: "gate"; agent: string; detail: string };

export type LogFilter = "key" | "group" | "operator" | "stopout" | "ladder" | "rebalance" | "all";

const labelOf = (s: FundSnapshot) => {
  const m = new Map(s.agents.map((a) => [a.name, a.label]));
  return (name: string) => m.get(name) ?? name.split(".")[0] ?? name;
};

/** "533333 → 612345 USDC (sharpe …)" → numbers; null when the text differs. */
export function parseMove(detail: string): { from: number | null; to: number | null } {
  const m = /^(\d+(?:\.\d+)?) → (\d+(?:\.\d+)?) USDC/.exec(detail);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : { from: null, to: null };
}

/**
 * Every decision, in order, with the routine ones folded: all ALLOCATEs become
 * one "grant" entry and all REALLOCATEs of one tick one "rebalance" entry. The
 * i-th CROWDING_CUT pairs with groupCuts[i] and each STOP_OUT with its stopOuts
 * record (the mandate closed).
 */
export function buildLog(s: FundSnapshot): LogEntry[] {
  const label = labelOf(s);
  const out: LogEntry[] = [];
  let group = 0;
  const stops = new Map(s.stopOuts.map((x) => [`${x.t}|${x.name}`, x]));
  const rebalance = new Map<number, Move[]>();
  const grants = s.decisions.filter((d) => d.kind === "ALLOCATE");

  s.decisions.forEach((d: FundDecision, i) => {
    const id = `${d.t}-${i}`;
    switch (d.kind) {
      case "ALLOCATE": {
        // One entry for the whole initial grant, placed where the first one was.
        if (d !== grants[0]) return;
        const each = /(\d+(?:\.\d+)?) USDC/.exec(d.detail);
        out.push({ id: "grant", t: d.t, type: "grant", agents: grants.length, each: each ? Number(each[1]) : null });
        return;
      }
      case "REALLOCATE": {
        let moves = rebalance.get(d.t);
        if (!moves) {
          moves = [];
          rebalance.set(d.t, moves);
          out.push({ id: `rebalance-${d.t}`, t: d.t, type: "rebalance", moves });
        }
        moves.push({ agent: label(d.node), ...parseMove(d.detail), detail: d.detail });
        return;
      }
      case "CROWDING_CUT": {
        const cut = s.groupCuts[group++];
        if (cut) out.push({ id, t: d.t, type: "group", cut });
        return;
      }
      case "STOP_OUT": {
        const stop = stops.get(`${d.t}|${d.node}`) ?? {
          t: d.t,
          agent: label(d.node),
          name: d.node,
          freed: 0,
          subtree: [d.node],
          detail: d.detail,
        };
        out.push({ id, t: d.t, type: "stopout", stop });
        return;
      }
      case "CUT":
      case "RESTORE":
        out.push({ id, t: d.t, type: "ladder", kind: d.kind, agent: label(d.node), detail: d.detail });
        return;
      case "GATE_CLIP":
        out.push({ id, t: d.t, type: "gate", agent: label(d.node), detail: d.detail });
        return;
    }
  });
  return out;
}

export function filterLog(entries: readonly LogEntry[], f: LogFilter): LogEntry[] {
  switch (f) {
    case "all":
      return [...entries];
    case "key":
      return entries.filter((e) => e.type !== "rebalance");
    case "group":
      return entries.filter((e) => e.type === "group");
    case "operator":
      // One-trade (overlapping-book) cuts whose members include two agents of
      // one operator. The operator is flagged after the run: the allocator
      // groups by positions and does not read it. Book-wide cuts that merely
      // swept up both agents of an operator are left out.
      return entries.filter((e) => e.type === "group" && flaggedOperatorCut(e.cut));
    case "stopout":
      return entries.filter((e) => e.type === "stopout");
    case "ladder":
      return entries.filter((e) => e.type === "ladder");
    case "rebalance":
      return entries.filter((e) => e.type === "rebalance");
  }
}

/** Agent labels a log entry touches (for highlighting them in the tree). */
export function entryAgents(e: LogEntry): string[] {
  switch (e.type) {
    case "grant":
      return [];
    case "rebalance":
      return e.moves.map((m) => m.agent);
    case "group":
      return e.cut.members;
    case "stopout":
      return [e.stop.agent];
    case "ladder":
    case "gate":
      return [e.agent];
  }
}

/** A one-trade cut (overlapping books) whose members include two agents of one operator. */
export function flaggedOperatorCut(c: GroupCut): boolean {
  return c.kind === "CLONES" && c.sharedOperators.length > 0;
}

export interface GroupCutStats {
  total: number;
  /** CLONES: agents whose books overlap, cut as one trade. */
  oneTrade: number;
  /** BOOK: the whole book's net exposure to one name over its cap; every holder scaled. */
  bookWide: number;
  /** One-trade cuts that included two agents of one operator (flagged after the run). */
  oneTradeSharedOperator: number;
  /** Book-wide cuts that happened to include two agents of one operator. */
  bookWideSharedOperator: number;
}

export function groupCutStats(cuts: readonly GroupCut[]): GroupCutStats {
  const shared = (c: GroupCut) => c.sharedOperators.length > 0;
  return {
    total: cuts.length,
    oneTrade: cuts.filter((c) => c.kind === "CLONES").length,
    bookWide: cuts.filter((c) => c.kind === "BOOK").length,
    oneTradeSharedOperator: cuts.filter(flaggedOperatorCut).length,
    bookWideSharedOperator: cuts.filter((c) => c.kind === "BOOK" && shared(c)).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Tree replay                                                                 */
/* -------------------------------------------------------------------------- */

/*
 * The replay is an index over [treeAtGrant, ...treeStates]: 0 is the tree at
 * grant, i ≥ 1 is treeStates[i − 1] (the end of a decision tick), and
 * treeStates.length is the end of the run.
 */

/** The tree state a replay index shows (clamped to the recorded range). */
export function stateAtIndex(s: FundSnapshot, index: number): TreeState {
  if (index <= 0 || s.treeStates.length === 0) return s.treeAtGrant;
  return s.treeStates[Math.min(index, s.treeStates.length) - 1]!;
}

/**
 * The replay index for the end of tick `t`: the latest recorded state at or
 * before it (every decision tick has its own state), or 0 before any.
 */
export function replayIndexAt(s: FundSnapshot, t: number): number {
  let index = 0;
  s.treeStates.forEach((st, i) => {
    if (st.t <= t) index = i + 1;
  });
  return index;
}

/** The largest mandate any agent held at any recorded tick (the agents' bar scale). */
export function maxAgentBudget(s: FundSnapshot): number {
  const idx = s.agents.map((a) => s.treeNodes.indexOf(a.name)).filter((i) => i >= 0);
  let max = 0;
  for (const st of [s.treeAtGrant, ...s.treeStates]) for (const i of idx) max = Math.max(max, st.budget[i] ?? 0);
  return max;
}

export interface TreeRow {
  name: string;
  label: string;
  depth: 0 | 1 | 2;
  index: number;
  agent: FundAgent | null;
  pod: string | null;
}

/**
 * Rows in display order: the fund, then each pod followed by its agents. Pods
 * keep the tree's order; agents keep the roster's order within a pod.
 */
export function treeRows(s: FundSnapshot): TreeRow[] {
  const index = new Map(s.treeNodes.map((n, i) => [n, i]));
  const parent = new Map(s.tree.nodes.map((n) => [n.name, n.parent]));
  const agentByName = new Map(s.agents.map((a) => [a.name, a]));
  const root = s.tree.nodes.find((n) => n.parent === null);
  if (!root) return [];
  const rows: TreeRow[] = [{ name: root.name, label: root.name, depth: 0, index: index.get(root.name)!, agent: null, pod: null }];
  for (const pod of s.tree.nodes.filter((n) => n.parent === root.name)) {
    const podLabel = pod.name.split(".")[0]!;
    rows.push({ name: pod.name, label: podLabel, depth: 1, index: index.get(pod.name)!, agent: null, pod: podLabel });
    for (const n of s.tree.nodes) {
      if (parent.get(n.name) !== pod.name) continue;
      const agent = agentByName.get(n.name) ?? null;
      rows.push({ name: n.name, label: agent?.label ?? n.name.split(".")[0]!, depth: 2, index: index.get(n.name)!, agent, pod: podLabel });
    }
  }
  return rows;
}

/** Operators that run more than one agent, keyed by operator id. */
export function sharedOperatorMap(s: FundSnapshot): Map<string, string[]> {
  return new Map(s.world.operators.filter((o) => o.agents.length > 1).map((o) => [o.id, o.agents]));
}

/* -------------------------------------------------------------------------- */
/* Sealed evidence                                                             */
/* -------------------------------------------------------------------------- */

export interface EvidenceRow {
  key: string;
  label: string;
  sub: string;
  u: Uplift;
}

const seedRange = (b: { from: number; count: number }) => `seeds ${b.from}–${b.from + b.count - 1}`;

/**
 * The uplift rows the evidence chart plots: block A and block B of each loop
 * whose change was merged AND confirmed on block B. A block-A winner that
 * failed block B was never merged, so it is never plotted as "the merged
 * change", even if a report carries its block-B numbers.
 */
export function evidenceRows(loops: readonly LoopEvidence[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const l of loops) {
    if (!l.confirmed || l.merged.length === 0) continue;
    const track = l.merged[0]?.track === "tiger" ? "tiger" : "allocator";
    if (l.blockA) rows.push({ key: `${l.loop}A`, label: `Loop ${l.loop} · block A`, sub: `${l.blocks.A.count} worlds, ${seedRange(l.blocks.A)}`, u: l.blockA[track] });
    if (l.blockB) rows.push({ key: `${l.loop}B`, label: `Loop ${l.loop} · block B`, sub: `${l.blocks.B.count} worlds, ${seedRange(l.blocks.B)}`, u: l.blockB[track] });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** 1234567 → "1.23M", 53400 → "53.4K", −800 → "−800". */
export function usdCompact(x: number): string {
  const a = Math.abs(x);
  const sign = x < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a.toFixed(0)}`;
}

export const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
export const signedPct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)}%`;
export const signedUsd = (x: number) => `${x >= 0 ? "+" : "−"}${usdCompact(Math.abs(x))}`;
export const pp = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)} pp`;
export const day = (t: number) => (t < 0 ? "At grant" : `Day ${t + 1}`);

/** Each agent's ladder state (by node name) at the end of tick `t`, replayed from the decisions. */
export function ladderAt(s: FundSnapshot, t: number): Map<string, FundAgent["status"]> {
  const m = new Map<string, FundAgent["status"]>(s.agents.map((a) => [a.name, "active"]));
  for (const d of s.decisions) {
    if (d.t > t) continue;
    if (d.kind === "CUT") m.set(d.node, "cut");
    else if (d.kind === "RESTORE") m.set(d.node, "active");
    else if (d.kind === "STOP_OUT") m.set(d.node, "stopped");
  }
  return m;
}
