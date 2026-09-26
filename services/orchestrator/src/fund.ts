/**
 * The fund console's data: one showcase VIRTUAL world from the arena, run twice
 * on identical prices — once under the center book (the allocator), once with
 * per-agent guardrails only — and written out as `fund-snapshot.json`.
 *
 * Nothing here is market data. The world is drawn from a research seed (< the
 * arena's sealed floor) chosen by a fixed, published rule that looks only at
 * the world's make-up, never at how either book did in it.
 *
 * The allocator itself (packages/swarm runBook) is used exactly as shipped; this
 * file only reads what it returns. To show the mandate tree as it stood at each
 * decision, `observeBook` watches a run from outside: it wraps the market's tick
 * array so it knows when runBook starts each tick, and reads the tree's budgets
 * at that boundary through the public DelegationTree API.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DelegationTree,
  formatAmount,
  toSnapshot,
  type AllowanceEvent,
  type Snapshot,
} from "@allowance/core";
import { ARENA_EVAL_FLOOR, certaintyEquivalent, makeWorld, performance, type World } from "@allowance/lab";
import {
  defaultCenterBookPolicy,
  defaultNaivePolicy,
  runBook,
  tickToUnix,
  trackRecords,
  type AllocationPolicy,
  type BookResult,
  type CenterBookPolicy,
  type Decision,
  type Market,
  type NaivePolicy,
  type SwarmSpec,
} from "@allowance/swarm";

/* ------------------------------------------------------------------ */
/* The showcase world                                                  */
/* ------------------------------------------------------------------ */

/** The published rule. It reads only the world's make-up, never a result. */
export const SHOWCASE_RULE =
  "the smallest research seed ≥ 1 whose virtual world has a crowd, at least one operator running two agents, and at least 2 skilled pickers";

export function qualifies(meta: World["meta"]): boolean {
  return meta.crowd && meta.sharedOperators >= 1 && meta.skilled >= 2;
}

/** Apply SHOWCASE_RULE. Research seeds only: the arena seals seeds ≥ ARENA_EVAL_FLOOR. */
export function pickShowcaseSeed(): number {
  for (let seed = 1; seed < ARENA_EVAL_FLOOR; seed++) {
    if (qualifies(makeWorld(seed).meta)) return seed;
  }
  throw new Error(`no research seed below ${ARENA_EVAL_FLOOR} satisfies the showcase rule`);
}

/* ------------------------------------------------------------------ */
/* Snapshot schema (mirrored in apps/web/src/fund/types.ts)            */
/* ------------------------------------------------------------------ */

export interface BookSummaryView {
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  /** CRRA certainty-equivalent annual return (γ = 3): the arena's yardstick. */
  utility: number;
  stopOuts: number;
}

export interface FundAgent {
  label: string;
  /** Full mandate-tree node name. */
  name: string;
  pod: string;
  /** Who runs the agent (a stand-in for a World ID nullifier in the virtual world). */
  operator: string | null;
  style: string;
  /** Ladder state at the end of the run under the center book. */
  status: "active" | "cut" | "stopped";
  /** Capital (whole USDC) the agent ran each tick. */
  capital: number[];
  /** Realized PnL (whole USDC) each tick. */
  pnl: number[];
  totalPnl: number;
  sharpe: number;
  maxDrawdown: number;
  closestTwin: { agent: string; corr: number } | null;
  /** The same agent in the per-agent-guardrails book. */
  baseline: { status: "active" | "cut" | "stopped"; stoppedAt: number | null; totalPnl: number };
}

export interface GroupCut {
  t: number;
  /** CLONES: near-identical books; BOOK: the whole book's net exposure to one name. */
  kind: "CLONES" | "BOOK" | "OTHER";
  instrument: string | null;
  /** Agent labels cut together, by one factor, in one pass. */
  members: string[];
  pods: string[];
  /**
   * Operators that run two or more of the members, flagged for context. These
   * cuts group agents by overlapping positions (CLONES) or book-wide exposure
   * (BOOK); the allocator's operator rule is the separate OPERATOR_CUT.
   */
  sharedOperators: Array<{ operator: string; agents: string[] }>;
  share: number | null;
  limit: number | null;
  scale: number | null;
  detail: string;
}

export interface StopOut {
  t: number;
  agent: string;
  name: string;
  /**
   * Whole USDC handed back up the tree: the amount DelegationTree.close
   * recorded on the agent's REVOKE when the center book stopped it out.
   */
  freed: number;
  /** The revoked node and everything under it (agents are leaves: just the node). */
  subtree: string[];
  detail: string;
}

export interface TreeState {
  /** End of this tick (after every tree write the book made during it). */
  t: number;
  budget: number[];
  spent: number[];
  reserved: number[];
  available: number[];
  /** The node's own revoked flag (a descendant of a revoked node is disabled too). */
  revoked: boolean[];
  /** False for a node that did not exist yet at this tick. */
  present: boolean[];
}

export interface Uplift {
  mean: number;
  lo: number;
  hi: number;
  wins: number;
}

/**
 * The center book's mean max drawdown on one sealed block, before and after a
 * loop's change, next to per-agent guardrails' (the report's `riskSummary`).
 */
export interface RiskSummary {
  block: string;
  /** Seed range as the report writes it, e.g. "12500-12699". */
  seeds: string;
  centerMaxDDBefore: number;
  centerMaxDDAfter: number;
  guardrailsMaxDD: number;
  /**
   * The center book's mean max drawdown after the change with its returns
   * scaled to the guardrails book's volatility (the arena's
   * `maxDDAtBaselineVol`): its drawdown per unit of risk. Null when the loop
   * did not record it (before loop 3). Never a replacement for
   * `centerMaxDDAfter`, which is what the book actually drew down.
   */
  centerMaxDDAtGuardrailsVolAfter: number | null;
  /** Paired change in the center book's max drawdown with its 90% interval; null when the loop did not record it. */
  pairedChange: { mean: number; lo: number; hi: number } | null;
  /**
   * For a tiger-track loop: the Tiger overlay's mean max drawdown before and
   * after the change, buy-and-hold's on the same worlds, and the paired change.
   */
  tiger: { before: number; after: number; buyHold: number; pairedChange: { mean: number; lo: number; hi: number } | null } | null;
  note: string | null;
}

/** A candidate change the loop did not merge, with the one-line reason (the report's `rejections`). */
export interface Rejection {
  title: string;
  reason: string;
}

/**
 * Center book vs per-agent guardrails on a loop's confirmation block, with the
 * loop's change merged (the report's `confirmation.booksB`): means over the
 * block's sealed virtual worlds.
 */
export interface SealedBooks {
  block: "B";
  seeds: { from: number; count: number };
  center: { utility: number; sharpe: number; maxDrawdown: number };
  /**
   * `sharpe` is null unless the report states the guardrails book's Sharpe for
   * exactly this run (booksB, or baselineB when its guardrails numbers match).
   */
  guardrails: { utility: number; sharpe: number | null; maxDrawdown: number };
}

export interface LoopEvidence {
  loop: number;
  /** The ledger's own name for the merged change (docs/loops/loop-N.json `title`). */
  title: string | null;
  /** A correction or disclosure the ledger attaches to this loop (`note`). */
  note: string | null;
  blocks: { A: { from: number; count: number }; B: { from: number; count: number } };
  candidates: number;
  statuses: Record<string, number>;
  merged: Array<{ k: number; angle: string; track: string }>;
  confirmed: boolean;
  /** Paired uplift of the merged change vs the version before it, per track (single merged change only). */
  blockA: { allocator: Uplift; tiger: Uplift } | null;
  blockB: { allocator: Uplift; tiger: Uplift } | null;
  /**
   * Block-B uplift of the merged change after a post-push correction (the
   * report's `correction.*GainOnBAfterFix`), with the commit it is measured
   * against. Null when the loop was not corrected.
   */
  correctedB: { uplift: Uplift; vs: string | null } | null;
  /** The same for block A (`correction.<name>GainOnAAfterFix`), when a correction re-measured it. */
  correctedA: { uplift: Uplift; vs: string | null } | null;
  /** Center book vs per-agent guardrails, before this loop's change, on block A. */
  headVsBaseline: { worlds: number; utility: number; baseline: number; uplift: number; lo: number; hi: number; winRate: number } | null;
  riskSummary: RiskSummary | null;
  rejections: Rejection[];
  /** Only for a merged change that confirmed on block B. */
  booksB: SealedBooks | null;
}

export interface FundSnapshot {
  schema: "fund-snapshot/1";
  simulated: true;
  asOf: number;
  currency: "USDC";
  world: {
    seed: number;
    seedRule: string;
    ticks: number;
    fund: string;
    aum: number;
    stocks: string[];
    crowd: { present: boolean; instrument: string; startTick: number; crashTick: number };
    pods: string[];
    operators: Array<{ id: string; agents: string[] }>;
    sharedOperators: number;
    skilled: number;
  };
  policy: { center: CenterBookPolicy; baseline: NaivePolicy };
  books: {
    center: { nav: number[]; summary: BookSummaryView };
    baseline: { nav: number[]; summary: BookSummaryView };
  };
  agents: FundAgent[];
  decisions: Decision[];
  decisionCounts: Record<string, number>;
  groupCuts: GroupCut[];
  stopOuts: StopOut[];
  /** Every allocator move is a RESIZE on the tree; this counts them. */
  resizes: number;
  tree: Snapshot;
  treeNodes: string[];
  treeAtGrant: TreeState;
  treeStates: TreeState[];
  evidence: { source: string; loops: LoopEvidence[] };
}

/* ------------------------------------------------------------------ */
/* Watching a run                                                      */
/* ------------------------------------------------------------------ */

interface NodeState {
  budget: number;
  spent: number;
  reserved: number;
  available: number;
  revoked: boolean;
}

export interface ObservedBook {
  book: BookResult;
  /** Tree state at the end of each tick; key −1 is the state at grant (before tick 0). */
  states: Map<number, Map<string, NodeState>>;
  /** Index into book.tree.events of the first event recorded during each tick. */
  eventStart: Map<number, number>;
}

const usdc = (units: bigint): number => Math.round(Number(formatAmount(units)));

function readTree(tree: DelegationTree): Map<string, NodeState> {
  const out = new Map<string, NodeState>();
  for (const n of tree.listNodes()) {
    out.set(n.name, {
      budget: usdc(n.mandate.budget),
      spent: usdc(n.mandate.spentDirect),
      reserved: usdc(tree.reserved(n.name)),
      available: usdc(tree.available(n.name)),
      revoked: n.mandate.revoked,
    });
  }
  return out;
}

/** True while an observeBook call has DelegationTree.prototype.recordEvent patched. */
let observing = false;

/**
 * Run the book unchanged and read its mandate tree at every tick boundary.
 *
 * runBook builds its own tree, so the tree is found through the one event every
 * tree records first (fundRoot's FUND); the prototype hook only remembers the
 * instance, is removed before this returns, and is checked against the tree
 * runBook hands back. Tick boundaries come from runBook reading
 * `market.ticks[t]` at the top of each tick.
 *
 * Books are observed one at a time: the hook is process-global, so a second
 * call while one is running is refused, rather than letting it capture (and
 * later put back) the first call's wrapper.
 */
export async function observeBook(market: Market, spec: SwarmSpec, policy: AllocationPolicy): Promise<ObservedBook> {
  if (observing) throw new Error("observeBook: another book is being observed; observe books one at a time");
  observing = true;
  try {
    return await observeOne(market, spec, policy);
  } finally {
    observing = false;
  }
}

async function observeOne(market: Market, spec: SwarmSpec, policy: AllocationPolicy): Promise<ObservedBook> {
  const seen: { tree: DelegationTree | null } = { tree: null };
  const states = new Map<number, Map<string, NodeState>>();
  const eventStart = new Map<number, number>();
  let current = -1;
  const ticks = new Proxy(market.ticks, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && seen.tree) {
        const t = Number(key);
        if (t > current) {
          states.set(current, readTree(seen.tree));
          eventStart.set(t, seen.tree.events.length);
          current = t;
        }
      }
      return Reflect.get(target, key, receiver);
    },
  });

  const proto = DelegationTree.prototype;
  const original = proto.recordEvent;
  const wrapper = function (this: DelegationTree, event: Omit<AllowanceEvent, "seq">): AllowanceEvent {
    seen.tree ??= this;
    return original.call(this, event);
  };
  proto.recordEvent = wrapper;
  let book: BookResult;
  try {
    book = await runBook({ ...market, ticks }, spec, policy);
  } finally {
    // Put back only our own hook: anything else means something patched over it.
    if (proto.recordEvent !== wrapper) {
      throw new Error("observeBook: DelegationTree.prototype.recordEvent was replaced during the run");
    }
    proto.recordEvent = original;
  }
  if (seen.tree !== book.tree) throw new Error("observeBook: watched a different tree than runBook returned");
  states.set(current, readTree(book.tree));
  if (states.size !== market.ticks.length + 1) {
    throw new Error(`observeBook: saw ${states.size - 1} tick boundaries, expected ${market.ticks.length}`);
  }
  return { book, states, eventStart };
}

/* ------------------------------------------------------------------ */
/* Evidence from the sealed loops                                      */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

function uplift(v: unknown): Uplift | null {
  if (!isObj(v)) return null;
  const u = { mean: num(v.mean), lo: num(v.lo), hi: num(v.hi), wins: num(v.wins) };
  return Object.values(u).every(Number.isFinite) ? u : null;
}

function perTrack(v: unknown): { allocator: Uplift; tiger: Uplift } | null {
  if (!isObj(v)) return null;
  const allocator = uplift(v.allocator);
  const tiger = uplift(v.tiger);
  return allocator && tiger ? { allocator, tiger } : null;
}

const finite = (...xs: number[]) => xs.every(Number.isFinite);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/*
 * riskSummary, rejections and correction are written into the reports by hand,
 * not by loop-driver.mjs. The helpers below apply the SAME rules the console's
 * parser (apps/web/src/fund/types.ts) enforces, and return null instead of
 * throwing, so one bad hand-written value drops that field instead of making
 * the whole snapshot unreadable:
 *   - a drawdown is a fraction in [0, 1] (7.75, in percent units, is refused);
 *   - an interval has lo ≤ mean ≤ hi;
 *   - a block's world count is a positive integer.
 */
const isDrawdown = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
const ordered = (u: { mean: number; lo: number; hi: number }) => u.lo <= u.mean && u.mean <= u.hi;

/**
 * The report's `riskSummary`, or null when it is missing, a number in it is not
 * finite, a drawdown is outside [0, 1] or its paired change is not an interval
 * (lo ≤ mean ≤ hi). The optional vol-matched drawdown
 * (`centerMaxDDAtGuardrailsVolAfter`) is null when absent or not a drawdown in
 * [0, 1]; a bad value there drops only that number, never the raw ones.
 */
function riskSummary(v: unknown): RiskSummary | null {
  if (!isObj(v) || typeof v.block !== "string" || typeof v.seeds !== "string") return null;
  const before = num(v.centerMaxDDBefore);
  const after = num(v.centerMaxDDAfter);
  const guard = num(v.guardrailsMaxDD);
  if (![before, after, guard].every(isDrawdown)) return null;
  const atVol = num(v.centerMaxDDAtGuardrailsVolAfter);
  let pairedChange: RiskSummary["pairedChange"] = null;
  if (v.pairedChange !== null && v.pairedChange !== undefined) {
    if (!isObj(v.pairedChange)) return null;
    const p = { mean: num(v.pairedChange.mean), lo: num(v.pairedChange.lo), hi: num(v.pairedChange.hi) };
    if (!finite(p.mean, p.lo, p.hi) || !ordered(p)) return null;
    pairedChange = p;
  }
  let tiger: RiskSummary["tiger"] = null;
  const tb = num(v.tigerMaxDDBefore);
  const ta = num(v.tigerMaxDDAfter);
  const bh = num(v.buyHoldMaxDD);
  if ([tb, ta, bh].every(isDrawdown)) {
    let tp: { mean: number; lo: number; hi: number } | null = null;
    if (isObj(v.tigerPairedChange)) {
      const p = { mean: num(v.tigerPairedChange.mean), lo: num(v.tigerPairedChange.lo), hi: num(v.tigerPairedChange.hi) };
      if (finite(p.mean, p.lo, p.hi) && ordered(p)) tp = p;
    }
    tiger = { before: tb, after: ta, buyHold: bh, pairedChange: tp };
  }
  return {
    block: v.block,
    seeds: v.seeds,
    centerMaxDDBefore: before,
    centerMaxDDAfter: after,
    guardrailsMaxDD: guard,
    centerMaxDDAtGuardrailsVolAfter: isDrawdown(atVol) ? atVol : null,
    pairedChange,
    tiger,
    note: strOrNull(v.note),
  };
}

/** The report's `rejections`: entries without a title and a reason are dropped. */
function rejections(v: unknown): Rejection[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .filter((r) => typeof r.title === "string" && typeof r.reason === "string")
    .map((r) => ({ title: r.title as string, reason: r.reason as string }));
}

/**
 * `confirmation.booksB.allocator` as center book vs guardrails. The guardrails
 * Sharpe is taken from booksB when the report has it; otherwise from
 * `baselineB` (the pre-change run on the same block) only when its guardrails
 * utility and drawdown are identical to booksB's, i.e. it is the same
 * guardrails run. Anything else leaves it null rather than guess.
 */
function sealedBooks(conf: Json, B: { from: number; count: number }): SealedBooks | null {
  const books = isObj(conf.booksB) && isObj(conf.booksB.allocator) ? conf.booksB.allocator : null;
  // The console's parser needs a positive whole number of worlds and both
  // drawdowns as fractions in [0, 1]; anything else is dropped, not written.
  if (!books || !Number.isInteger(B.count) || B.count < 1) return null;
  const center = { utility: num(books.utility), sharpe: num(books.sharpe), maxDrawdown: num(books.maxDD) };
  const guard = { utility: num(books.baselineUtility), maxDrawdown: num(books.baselineMaxDD) };
  if (!finite(center.utility, center.sharpe, guard.utility)) return null;
  if (!isDrawdown(center.maxDrawdown) || !isDrawdown(guard.maxDrawdown)) return null;
  let sharpe = num(books.baselineSharpe);
  if (!Number.isFinite(sharpe)) {
    const pre = isObj(conf.baselineB) && isObj(conf.baselineB.allocator) ? conf.baselineB.allocator : null;
    const same = pre !== null && pre.baseline === books.baselineUtility && pre.baselineMaxDD === books.baselineMaxDD;
    sharpe = same ? num(pre.baselineSharpe) : NaN;
  }
  return {
    block: "B",
    seeds: B,
    center,
    guardrails: { ...guard, sharpe: Number.isFinite(sharpe) ? sharpe : null },
  };
}

/**
 * A post-push correction's re-measured block-B gain
 * (`correction.<name>GainOnBAfterFix`); null unless it is an interval.
 */
function correctedB(v: unknown, block: "A" | "B" = "B"): LoopEvidence["correctedB"] {
  if (!isObj(v)) return null;
  const key = Object.keys(v).find((k) => new RegExp(`GainOn${block}AfterFix$`).test(k));
  const g = key ? v[key] : null;
  const u = uplift(g);
  return u && ordered(u) ? { uplift: u, vs: isObj(g) ? strOrNull(g.vs) : null } : null;
}

/**
 * Summarize every sealed loop report in `dir` (docs/loops/loop-<n>.json), oldest
 * first. Every number written out is finite (JSON would turn NaN into null,
 * which the console's parser rejects):
 *   - a report without a loop number or without both block ranges is skipped,
 *     since the console could not say which worlds it covers;
 *   - a head-vs-baseline summary with a missing number becomes null;
 *   - uplift is kept only for a merged change. Block B in particular only when
 *     block B confirmed it: loop-driver.mjs also records block B for a block-A
 *     winner that then FAILED confirmation, and that change was never merged.
 *     The same holds for the block-B books (`booksB`), the drawdown summary
 *     (`riskSummary`: its "after" is the merged change) and a correction's
 *     re-measured block-B gain;
 *   - `riskSummary` and `rejections` are copied as the ledger states them (a
 *     malformed risk summary becomes null, a malformed rejection is dropped);
 *   - a hand-written value the console's parser would refuse (a drawdown
 *     outside [0, 1], an interval whose mean is outside [lo, hi], a block of
 *     no worlds) turns its field into null, so the snapshot always parses.
 */
export function readEvidence(dir: string): LoopEvidence[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^loop-\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const loops: LoopEvidence[] = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    if (!isObj(j)) continue;
    const loop = num(j.loop);
    const blocks = isObj(j.blocks) ? j.blocks : {};
    const block = (b: unknown) => (isObj(b) ? { from: num(b.from), count: num(b.count) } : { from: NaN, count: NaN });
    const A = block(blocks.A);
    const B = block(blocks.B);
    if (!finite(loop, A.from, A.count, B.from, B.count)) continue;

    const candidates = Array.isArray(j.candidates) ? (j.candidates.filter(isObj) as Json[]) : [];
    const statuses: Record<string, number> = {};
    for (const c of candidates) {
      const s = typeof c.status === "string" ? c.status : "unknown";
      statuses[s] = (statuses[s] ?? 0) + 1;
    }
    const kept = isObj(j.merged) && Array.isArray(j.merged.kept) ? (j.merged.kept as unknown[]).map(Number) : [];
    const keptCands = kept.map((k) => candidates.find((c) => c.k === k)).filter(isObj);
    const conf = isObj(j.confirmation) ? j.confirmation : null;
    const confirmed = keptCands.length > 0 && conf?.ok === true;
    const base = isObj(j.baselineA) && isObj(j.baselineA.allocator) ? j.baselineA.allocator : null;
    const head = base
      ? {
          worlds: num(base.worlds),
          utility: num(base.utility),
          baseline: num(base.baseline),
          uplift: num(base.uplift),
          lo: num(base.upliftLo),
          hi: num(base.upliftHi),
          winRate: num(base.winRate),
        }
      : null;
    loops.push({
      loop,
      title: typeof j.title === "string" ? j.title : null,
      note: typeof j.note === "string" ? j.note : null,
      blocks: { A, B },
      candidates: candidates.length,
      statuses,
      merged: keptCands.map((c) => ({
        k: num(c.k),
        angle: typeof c.angle === "string" ? c.angle : "",
        track: typeof c.track === "string" ? c.track : "",
      })),
      confirmed,
      blockA: keptCands.length === 1 ? perTrack(keptCands[0]!.blockA) : null,
      blockB: confirmed ? perTrack(conf?.blockB) : null,
      correctedB: confirmed ? correctedB(j.correction) : null,
      correctedA: confirmed ? correctedB(j.correction, "A") : null,
      headVsBaseline: head && finite(...Object.values(head)) ? head : null,
      riskSummary: confirmed ? riskSummary(j.riskSummary) : null,
      rejections: rejections(j.rejections),
      booksB: confirmed && conf ? sealedBooks(conf, B) : null,
    });
  }
  return loops.sort((a, b) => a.loop - b.loop);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const round = (x: number, dp: number) => Number(x.toFixed(dp));

function summary(book: BookResult): BookSummaryView {
  const p = performance(book.returns);
  return {
    totalReturn: round(p.totalReturn, 6),
    maxDrawdown: round(p.maxDrawdown, 6),
    sharpe: round(p.sharpe, 4),
    utility: round(certaintyEquivalent(book.returns), 6),
    stopOuts: book.decisions.filter((d) => d.kind === "STOP_OUT").length,
  };
}

const pctIn = (re: RegExp, s: string): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) / 100 : null;
};

function groupCut(d: Decision, byName: ReadonlyMap<string, FundAgent>): GroupCut {
  const agents = d.node
    .split(", ")
    .map((n) => byName.get(n))
    .filter((a): a is FundAgent => a !== undefined);
  const byOp = new Map<string, string[]>();
  for (const a of agents) if (a.operator) byOp.set(a.operator, [...(byOp.get(a.operator) ?? []), a.label]);
  const clones = /running one trade in (\S+?):/.exec(d.detail);
  const book = /book net (\S+) exposure/.exec(d.detail);
  const scale = /scaled ×([\d.]+)/.exec(d.detail);
  return {
    t: d.t,
    kind: clones ? "CLONES" : book ? "BOOK" : "OTHER",
    instrument: clones?.[1] ?? book?.[1] ?? null,
    members: agents.map((a) => a.label),
    pods: [...new Set(agents.map((a) => a.pod))],
    sharedOperators: [...byOp].filter(([, xs]) => xs.length > 1).map(([operator, xs]) => ({ operator, agents: xs })),
    share: pctIn(/: ([\d.]+)% of NAV/, d.detail),
    limit: pctIn(/> ([\d.]+)% limit/, d.detail),
    scale: scale ? Number(scale[1]) : null,
    detail: d.detail,
  };
}

function columns(t: number, names: readonly string[], state: ReadonlyMap<string, NodeState>): TreeState {
  const get = (n: string) => state.get(n);
  return {
    t,
    budget: names.map((n) => get(n)?.budget ?? 0),
    spent: names.map((n) => get(n)?.spent ?? 0),
    reserved: names.map((n) => get(n)?.reserved ?? 0),
    available: names.map((n) => get(n)?.available ?? 0),
    revoked: names.map((n) => get(n)?.revoked ?? false),
    present: names.map((n) => state.has(n)),
  };
}

export interface BuildOptions {
  /** Directory of sealed loop reports (docs/loops). */
  loopsDir: string;
  /** Override the rule (tests only). Must be a research seed. */
  seed?: number;
}

export async function buildFundSnapshot(opts: BuildOptions): Promise<FundSnapshot> {
  const seed = opts.seed ?? pickShowcaseSeed();
  if (!Number.isInteger(seed) || seed < 1 || seed >= ARENA_EVAL_FLOOR) {
    throw new Error(`seed ${seed} is not a research seed (1 ≤ seed < ${ARENA_EVAL_FLOOR})`);
  }
  const world = makeWorld(seed);
  const market = world.market;
  const T = market.ticks.length;
  const centerPolicy = defaultCenterBookPolicy();
  // Same leverage, deployment and stop-loss as the center book: the only
  // difference is whether anything looks across the agents.
  const naivePolicy: NaivePolicy = {
    ...defaultNaivePolicy(),
    leverage: centerPolicy.leverage,
    deploy: centerPolicy.deploy,
    ddStop: centerPolicy.ddStop,
  };

  const spec = world.swarm();
  const observed = await observeBook(market, spec, centerPolicy);
  const naive = await runBook(market, world.swarm(), naivePolicy);
  const center = observed.book;

  const records = trackRecords(center);
  const naiveStop = new Map(naive.decisions.filter((d) => d.kind === "STOP_OUT").map((d) => [d.node, d.t]));
  const agents: FundAgent[] = center.agents.map((a, i) => {
    const r = records[i]!;
    const n = naive.agents[i]!;
    return {
      label: a.label,
      name: a.name,
      pod: a.pod,
      operator: spec.agents[i]?.operator ?? null,
      style: a.style,
      status: a.ladder,
      capital: a.capital.map((c) => Math.round(c)),
      pnl: a.pnl.map((p) => Math.round(p)),
      totalPnl: Math.round(r.pnl),
      sharpe: round(r.sharpe, 3),
      maxDrawdown: round(r.maxDrawdown, 4),
      closestTwin: r.closestTwin ? { agent: r.closestTwin.agent, corr: round(r.closestTwin.corr, 3) } : null,
      baseline: {
        status: n.ladder,
        stoppedAt: naiveStop.get(n.name) ?? null,
        totalPnl: Math.round(n.pnl.reduce((s, x) => s + x, 0)),
      },
    };
  });
  const byName = new Map(agents.map((a) => [a.name, a]));

  const operators = new Map<string, string[]>();
  for (const a of agents) if (a.operator) operators.set(a.operator, [...(operators.get(a.operator) ?? []), a.label]);

  const decisionCounts: Record<string, number> = {};
  for (const d of center.decisions) decisionCounts[d.kind] = (decisionCounts[d.kind] ?? 0) + 1;

  const events = center.tree.events;
  const eventsIn = (t: number) => events.slice(observed.eventStart.get(t) ?? 0, observed.eventStart.get(t + 1) ?? events.length);
  const descendants = (name: string): string[] => [
    name,
    ...center.tree.childrenOf(name).flatMap((c) => descendants(c.name)),
  ];
  const stopOuts: StopOut[] = center.decisions
    .filter((d) => d.kind === "STOP_OUT")
    .map((d) => {
      const agent = byName.get(d.node);
      // A stop-out is one DelegationTree.close (book.ts); close records what
      // it freed on the agent's REVOKE.
      const revoke = eventsIn(d.t).find((e) => e.type === "REVOKE" && e.node === d.node);
      if (revoke?.amount == null) throw new Error(`stop-out of ${d.node} on tick ${d.t} has no REVOKE with the freed amount`);
      const freed = usdc(revoke.amount);
      return { t: d.t, agent: agent?.label ?? d.node, name: d.node, freed, subtree: descendants(d.node), detail: d.detail };
    });

  const decisionTicks = [...new Set([...center.decisions.map((d) => d.t), T - 1])].sort((a, b) => a - b);
  const asOf = tickToUnix(T);
  // The console shows the tree's log without its RESIZE events (the allocator
  // makes hundreds). A filtered log cannot carry the hash chain: its links
  // would name events that are not there and read as tampering. So the view
  // drops the links; the full chain is checked against the live tree inside
  // the run (runBook's audits call verifyAgainstLog), not from this file.
  const view = toSnapshot(center.tree, { asOf, events: events.filter((e) => e.type !== "RESIZE") });
  const tree = { ...view, events: view.events.map(({ hash: _hash, ...e }) => e) };
  const treeNodes = tree.nodes.map((n) => n.name);
  const stateAt = (t: number) => {
    const s = observed.states.get(t);
    if (!s) throw new Error(`no tree state for tick ${t}`);
    return s;
  };

  const crowd = market.config.crowd;
  const root = tree.nodes.find((n) => n.parent === null)!;
  return {
    schema: "fund-snapshot/1",
    simulated: true,
    asOf,
    currency: "USDC",
    world: {
      seed,
      seedRule: SHOWCASE_RULE,
      ticks: T,
      fund: root.name,
      aum: center.startNav,
      stocks: [...market.instruments],
      crowd: { present: world.meta.crowd, instrument: crowd.instrument, startTick: crowd.startTick, crashTick: crowd.crashTick },
      pods: spec.pods.map((p) => p.label),
      operators: [...operators].map(([id, xs]) => ({ id, agents: xs })),
      sharedOperators: world.meta.sharedOperators,
      skilled: world.meta.skilled,
    },
    policy: { center: centerPolicy, baseline: naivePolicy },
    books: {
      center: { nav: center.nav.map((v) => Math.round(v)), summary: summary(center) },
      baseline: { nav: naive.nav.map((v) => Math.round(v)), summary: summary(naive) },
    },
    agents,
    decisions: center.decisions,
    decisionCounts,
    groupCuts: center.decisions.filter((d) => d.kind === "CROWDING_CUT").map((d) => groupCut(d, byName)),
    stopOuts,
    resizes: events.filter((e) => e.type === "RESIZE" && e.result === "OK").length,
    tree,
    treeNodes,
    treeAtGrant: columns(-1, treeNodes, stateAt(-1)),
    treeStates: decisionTicks.map((t) => columns(t, treeNodes, stateAt(t))),
    evidence: { source: "docs/loops/loop-*.json", loops: readEvidence(opts.loopsDir) },
  };
}
