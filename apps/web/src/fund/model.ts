/**
 * Pure view-model helpers for the fund console: the decision log (routine
 * reallocations collapsed per rebalance), the mandate tree at any decision
 * tick, and the fund → pods → agents hierarchy. No React, so they are unit
 * tested in ../fund.test.ts.
 */

import type { FundAgent, FundDecision, FundSnapshot, GroupCut, LoopEvidence, SealedBooks, StopOut, TreeState, Uplift } from "./types";

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
  | { id: string; t: number; type: "gate"; agent: string; detail: string }
  /** An operator cap: another agent of the same operator was stopped out (loop 3). */
  | { id: string; t: number; type: "opcap"; agent: string; detail: string };

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
        break;
      case "OPERATOR_CUT":
        out.push({ id, t: d.t, type: "opcap", agent: label(d.node), detail: d.detail });
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
      return entries.filter((e) => e.type === "group" || e.type === "opcap");
    case "operator":
      // Operator caps (one of an operator's agents was stopped out, so its
      // other agents are capped together), plus one-trade (overlapping-book)
      // cuts whose members include two agents of one operator. Book-wide cuts
      // that merely swept up both agents of an operator are left out.
      return entries.filter((e) => e.type === "opcap" || (e.type === "group" && flaggedOperatorCut(e.cut)));
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
    case "opcap":
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
  /** One-trade cuts that included two agents of one operator (flagged on the cut). */
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
  /**
   * A result a later re-measurement replaced (loop 1's block-B gain before its
   * post-push fix). Kept on the record, drawn hollow and dashed; the row that
   * replaced it follows it.
   */
  superseded: boolean;
  /** Provenance for the hover title and the data table (e.g. the commit a re-measurement is against). */
  detail: string | null;
}

const seedRange = (b: { from: number; count: number }) => `seeds ${b.from}–${b.from + b.count - 1}`;

/**
 * The uplift rows the evidence chart plots: block A and block B of each loop
 * whose change was merged AND confirmed on block B. A block-A winner that
 * failed block B was never merged, so it is never plotted as "the merged
 * change", even if a report carries its block-B numbers. When a post-push
 * correction re-measured the block-B gain, the confirmed number stays on the
 * record, marked superseded, and the re-measured one (the number that stands)
 * follows it.
 */
export function evidenceRows(loops: readonly LoopEvidence[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const worlds = (b: { from: number; count: number }) => `${b.count} worlds, ${seedRange(b)}`;
  for (const l of loops) {
    if (!l.confirmed || l.merged.length === 0) continue;
    const track = l.merged[0]?.track === "tiger" ? "tiger" : "allocator";
    const corrected = l.correctedB;
    const correctedA = l.correctedA ?? null;
    if (l.blockA) {
      rows.push({
        key: `${l.loop}A`,
        label: `Loop ${l.loop} · block A`,
        sub: correctedA ? "first measured · before the fix" : worlds(l.blocks.A),
        u: l.blockA[track],
        superseded: correctedA !== null,
        detail: correctedA ? `${worlds(l.blocks.A)}; replaced by the re-measurement after the fix` : null,
      });
    }
    if (correctedA) {
      rows.push({
        key: `${l.loop}Ac`,
        label: `Loop ${l.loop} · block A`,
        sub: "re-measured after the fix",
        u: correctedA.uplift,
        superseded: false,
        detail: `the same ${l.blocks.A.count} worlds, on the code that shipped${correctedA.vs ? `, vs ${correctedA.vs}` : ""}`,
      });
    }
    if (l.blockB) {
      rows.push({
        key: `${l.loop}B`,
        label: `Loop ${l.loop} · block B`,
        sub: corrected ? "first confirmed · before the fix" : worlds(l.blocks.B),
        u: l.blockB[track],
        superseded: corrected !== null,
        detail: corrected ? `${worlds(l.blocks.B)}; replaced by the re-measurement after the fix` : null,
      });
    }
    if (corrected) {
      rows.push({
        key: `${l.loop}Bc`,
        label: `Loop ${l.loop} · block B`,
        sub: "re-measured after the fix",
        u: corrected.uplift,
        superseded: false,
        detail: `the same ${l.blocks.B.count} worlds, on the code that shipped${corrected.vs ? `, vs ${corrected.vs}` : ""}`,
      });
    }
  }
  return rows;
}

/**
 * Where the center book's mean max drawdown stands against per-agent
 * guardrails' after a loop, and whether that loop moved it across:
 * "still-above" (above before and after), "now-above" (this loop took it
 * above), "now-below" (this loop brought it below), "below" (below throughout).
 */
export type Standing = "still-above" | "now-above" | "now-below" | "below";

export function standing(before: number, after: number, guardrails: number): Standing {
  const was = before > guardrails;
  const is = after > guardrails;
  return was && is ? "still-above" : is ? "now-above" : was ? "now-below" : "below";
}

/**
 * The evidence panel's one-line method. It names the block size only when
 * every loop used the same one; with mixed sizes, or no loop yet, it needs no
 * count.
 */
export function evidenceBlocksLine(loops: ReadonlyArray<Pick<LoopEvidence, "blocks">>): string {
  const counts = [...new Set(loops.flatMap((l) => [l.blocks.A.count, l.blocks.B.count]))];
  return counts.length === 1
    ? `Each loop is judged against the code before it on ${counts[0]} sealed virtual worlds (block A), then confirmed on ${counts[0]} more (block B).`
    : "Each loop is judged against the code before it on sealed virtual worlds (block A), then confirmed on a fresh block (block B).";
}

/**
 * A loop card's verdict. A loop that merged only structural guarantees had to
 * be neutral on block B, not win (docs/LOOPS.md, Protocol), so its card says
 * "confirmed neutral" rather than reading as a win.
 */
export function loopVerdict(l: Pick<LoopEvidence, "confirmed" | "merged">): string {
  if (!l.confirmed) return l.merged.length ? "merged · not confirmed" : "nothing merged";
  const structural = l.merged.length > 0 && l.merged.every((m) => m.track === "structure");
  return structural ? "✓ merged · confirmed neutral on block B (structural)" : "✓ merged · confirmed on block B";
}

/**
 * A plain-words gloss for a merged change whose title uses a term of art,
 * matched on the ledger's title. Loop 3's "an operator is one counterparty"
 * is the cap after a stop-out; the crowding cut does not group by operator.
 */
export function titleGloss(title: string | null): string | null {
  if (title && /\boperator is one counterparty\b/i.test(title)) {
    return (
      "One counterparty means: when one of an operator's agents is stopped out, its other live agents are capped " +
      "together until each recovers on its own record. It is not a grouping key: the crowding cut still groups agents " +
      "by overlapping positions only."
    );
  }
  return null;
}

/**
 * The center book's drawdown per unit of risk: its mean max drawdown with its
 * returns scaled to the guardrails book's volatility. Shown next to the raw
 * drawdown, never instead of it.
 */
export interface VolMatched {
  value: number;
  /** It runs more volatility than the guardrails (so scaling to theirs lowers its drawdown). */
  moreVol: boolean;
  /** At the guardrails' volatility its drawdown is below the guardrails'. */
  belowGuardrails: boolean;
}

export function volMatched(raw: number, atVol: number | null, guardrails: number): VolMatched | null {
  if (atVol === null) return null;
  return { value: atVol, moreVol: atVol < raw, belowGuardrails: atVol < guardrails };
}

export interface DrawdownRow {
  key: string;
  loop: number;
  label: string;
  sub: string;
  before: number;
  after: number;
  guardrails: number;
  /** `after` at the guardrails' volatility, when the loop recorded it. */
  atGuardrailsVol: VolMatched | null;
  /** The center book's paired change (after − before) with its 90% interval, when the loop recorded it. */
  paired: { mean: number; lo: number; hi: number } | null;
  /** The center book's mean max drawdown after this loop is above per-agent guardrails'. */
  aboveGuardrails: boolean;
  /** …and whether this loop is what moved it there (see `standing`). */
  standing: Standing;
  note: string | null;
}

/**
 * One row per loop whose report carries a drawdown summary: the center book's
 * mean max drawdown on the confirmation block before → after the loop's
 * change, next to per-agent guardrails' on the same worlds.
 */
export function drawdownRows(loops: readonly LoopEvidence[]): DrawdownRow[] {
  return loops
    .filter((l): l is LoopEvidence & { riskSummary: NonNullable<LoopEvidence["riskSummary"]> } => l.riskSummary !== null)
    .map((l) => {
      const r = l.riskSummary;
      return {
        key: `dd${l.loop}`,
        loop: l.loop,
        label: `Loop ${l.loop} · block ${r.block}`,
        sub: `seeds ${r.seeds.replace("-", "–")}`,
        before: r.centerMaxDDBefore,
        after: r.centerMaxDDAfter,
        guardrails: r.guardrailsMaxDD,
        atGuardrailsVol: volMatched(r.centerMaxDDAfter, r.centerMaxDDAtGuardrailsVolAfter, r.guardrailsMaxDD),
        paired: r.pairedChange,
        aboveGuardrails: r.centerMaxDDAfter > r.guardrailsMaxDD,
        standing: standing(r.centerMaxDDBefore, r.centerMaxDDAfter, r.guardrailsMaxDD),
        note: r.note,
      };
    });
}

/**
 * The latest loop that merged a change and confirmed it on block B with the
 * block's book-level numbers recorded: "where the center book stands" on
 * worlds nobody tuned on.
 */
export function latestSealed(loops: readonly LoopEvidence[]): (LoopEvidence & { booksB: SealedBooks }) | null {
  let best: (LoopEvidence & { booksB: SealedBooks }) | null = null;
  for (const l of loops) {
    if (l.confirmed && l.merged.length > 0 && l.booksB && (!best || l.loop > best.loop)) best = l as LoopEvidence & { booksB: SealedBooks };
  }
  return best;
}

export type Better = "center" | "guardrails" | "tie";

export interface ContextRow {
  metric: "Certainty equivalent" | "Sharpe" | "Max drawdown";
  /** Formatted, to the same precision in both columns: this world's center book / guardrails, and the sealed mean's. */
  world: { center: string; guardrails: string; better: Better };
  sealed: { center: string; guardrails: string; better: Better } | null;
}

export interface SealedAverage {
  loop: number;
  worlds: number;
  seeds: string;
  /** The center book's certainty-equivalent edge over guardrails on the sealed block. */
  gap: number;
  /** This world flatters the center book relative to the sealed average. */
  favourable: boolean;
  /** On the sealed block the center book's mean max drawdown is above the guardrails'. */
  drawdownAbove: boolean;
  utilityAbove: boolean;
  /**
   * The same loop's block-B drawdown at the guardrails' volatility, when its
   * risk summary recorded it for this very run (same block, same "after"
   * drawdown as the books); null otherwise.
   */
  volMatched: VolMatched | null;
}

export interface ShowcaseContext {
  rows: ContextRow[];
  /** The center book's certainty-equivalent edge over guardrails in this world. */
  gapWorld: number;
  /**
   * The latest sealed confirmation, or null when no loop has recorded its
   * block-B books yet: the card then says this world has no sealed average to
   * be read against, instead of disappearing.
   */
  sealed: SealedAverage | null;
}

const better = (center: number, guardrails: number, higherIsBetter: boolean, eps: number): Better =>
  Math.abs(center - guardrails) < eps ? "tie" : center > guardrails === higherIsBetter ? "center" : "guardrails";

/**
 * The showcase world next to the latest sealed confirmation, metric by metric,
 * center book vs per-agent guardrails. The showcase world's rows are always
 * there; `sealed` (and each row's sealed column) is null when no loop recorded
 * its block-B books.
 */
export function showcaseContext(s: FundSnapshot): ShowcaseContext {
  const l = latestSealed(s.evidence.loops);
  const b = l ? l.booksB : null;
  const c = s.books.center.summary;
  const g = s.books.baseline.summary;
  const rows: ContextRow[] = [
    {
      metric: "Certainty equivalent",
      world: { center: signedPct(c.utility), guardrails: signedPct(g.utility), better: better(c.utility, g.utility, true, 0.0005) },
      sealed: b && {
        center: signedPct(b.center.utility),
        guardrails: signedPct(b.guardrails.utility),
        better: better(b.center.utility, b.guardrails.utility, true, 0.0005),
      },
    },
    {
      metric: "Sharpe",
      world: { center: c.sharpe.toFixed(2), guardrails: g.sharpe.toFixed(2), better: better(c.sharpe, g.sharpe, true, 0.005) },
      sealed:
        b === null || b.guardrails.sharpe === null
          ? null
          : {
              center: b.center.sharpe.toFixed(2),
              guardrails: b.guardrails.sharpe.toFixed(2),
              better: better(b.center.sharpe, b.guardrails.sharpe, true, 0.005),
            },
    },
    {
      metric: "Max drawdown",
      // Two decimals in both columns: the ledger quotes the sealed means that way (7.75% vs 6.88%).
      world: { center: pct(c.maxDrawdown, 2), guardrails: pct(g.maxDrawdown, 2), better: better(c.maxDrawdown, g.maxDrawdown, false, 0.00005) },
      sealed: b && {
        center: pct(b.center.maxDrawdown, 2),
        guardrails: pct(b.guardrails.maxDrawdown, 2),
        better: better(b.center.maxDrawdown, b.guardrails.maxDrawdown, false, 0.00005),
      },
    },
  ];
  const gapWorld = c.utility - g.utility;
  if (!l || !b) return { rows, gapWorld, sealed: null };
  const gap = b.center.utility - b.guardrails.utility;
  // Only a vol-matched number measured on these very books: block B, and the
  // risk summary's raw "after" drawdown is the books' (to the ledger's rounding).
  const r = l.riskSummary;
  const sameRun = r !== null && r.block === "B" && Math.abs(r.centerMaxDDAfter - b.center.maxDrawdown) < 0.0005;
  return {
    rows,
    gapWorld,
    sealed: {
      loop: l.loop,
      worlds: b.seeds.count,
      seeds: seedRange(b.seeds),
      gap,
      favourable: gapWorld > gap,
      drawdownAbove: b.center.maxDrawdown > b.guardrails.maxDrawdown,
      utilityAbove: b.center.utility > b.guardrails.utility,
      volMatched: sameRun && r ? volMatched(b.center.maxDrawdown, r.centerMaxDDAtGuardrailsVolAfter, b.guardrails.maxDrawdown) : null,
    },
  };
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
/**
 * A share of worlds (e.g. "better in 72.5% of worlds"): a whole percent prints
 * without decimals, anything else with one, so a rate over 200 worlds is never
 * rounded to a number the ledger (docs/LOOPS.md) contradicts.
 */
export const winPct = (x: number) => {
  const tenths = Math.round(x * 1000);
  return `${(tenths / 10).toFixed(tenths % 10 === 0 ? 0 : 1)}%`;
};
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
