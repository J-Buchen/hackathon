/**
 * Mirror of the orchestrator's `FundSnapshot` (services/orchestrator/src/fund.ts)
 * — the JSON written by `npm run demo:fund` to public/fund-snapshot.json. Kept
 * as a local copy (like ../types.ts and ../swarm/types.ts) so the web app has no
 * build-time dependency on the workspace packages.
 *
 * Everything in this file describes a VIRTUAL world: simulated prices, agents
 * and operators. Amounts are whole USDC numbers except inside `tree`, which is
 * the core Snapshot (smallest-unit strings).
 */

import type { Snapshot } from "../types";
import { parseSnapshot } from "../snapshot";

export type LadderState = "active" | "cut" | "stopped";

export type DecisionKind =
  | "ALLOCATE"
  | "REALLOCATE"
  | "CUT"
  | "RESTORE"
  | "STOP_OUT"
  | "CROWDING_CUT"
  | "GATE_CLIP";

export interface FundDecision {
  t: number;
  kind: DecisionKind;
  node: string;
  detail: string;
}

export interface BookSummaryView {
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  utility: number;
  stopOuts: number;
}

export interface FundAgent {
  label: string;
  name: string;
  pod: string;
  operator: string | null;
  style: string;
  status: LadderState;
  capital: number[];
  pnl: number[];
  totalPnl: number;
  sharpe: number;
  maxDrawdown: number;
  closestTwin: { agent: string; corr: number } | null;
  baseline: { status: LadderState; stoppedAt: number | null; totalPnl: number };
}

export interface GroupCut {
  t: number;
  kind: "CLONES" | "BOOK" | "OTHER";
  instrument: string | null;
  members: string[];
  pods: string[];
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
  freed: number;
  subtree: string[];
  detail: string;
}

export interface TreeState {
  t: number;
  budget: number[];
  spent: number[];
  reserved: number[];
  available: number[];
  revoked: boolean[];
  present: boolean[];
}

export interface Uplift {
  mean: number;
  lo: number;
  hi: number;
  wins: number;
}

export interface LoopEvidence {
  loop: number;
  title: string | null;
  note: string | null;
  blocks: { A: { from: number; count: number }; B: { from: number; count: number } };
  candidates: number;
  statuses: Record<string, number>;
  merged: Array<{ k: number; angle: string; track: string }>;
  confirmed: boolean;
  blockA: { allocator: Uplift; tiger: Uplift } | null;
  blockB: { allocator: Uplift; tiger: Uplift } | null;
  headVsBaseline: {
    worlds: number;
    utility: number;
    baseline: number;
    uplift: number;
    lo: number;
    hi: number;
    winRate: number;
  } | null;
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
  /** The allocator's parameters. The console reads leverage and the drawdown cut factor. */
  policy: {
    center: { leverage: number; cutFactor: number } & Record<string, number | string>;
    baseline: { leverage: number } & Record<string, number | string>;
  };
  books: {
    center: { nav: number[]; summary: BookSummaryView };
    baseline: { nav: number[]; summary: BookSummaryView };
  };
  agents: FundAgent[];
  decisions: FundDecision[];
  decisionCounts: Record<string, number>;
  groupCuts: GroupCut[];
  stopOuts: StopOut[];
  resizes: number;
  tree: Snapshot;
  treeNodes: string[];
  treeAtGrant: TreeState;
  treeStates: TreeState[];
  evidence: { source: string; loops: LoopEvidence[] };
}

/* -------------------------------------------------------------------------- */
/* Boundary parser                                                             */
/* -------------------------------------------------------------------------- */

export class FundSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundSnapshotError";
  }
}

type Obj = Record<string, unknown>;

function fail(path: string, expected: string, actual: unknown): never {
  const got = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
  throw new FundSnapshotError(`fund-snapshot.json ${path}: expected ${expected}, got ${got}`);
}
function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "object", v);
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "array", v);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "string", v);
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "finite number", v);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "boolean", v);
  return v;
}
function nums(v: unknown, path: string, length?: number): number[] {
  const a = arr(v, path);
  a.forEach((x, i) => num(x, `${path}[${i}]`));
  if (length !== undefined && a.length !== length) {
    throw new FundSnapshotError(`fund-snapshot.json ${path}: expected ${length} entries, got ${a.length}`);
  }
  return a as number[];
}
function strs(v: unknown, path: string): string[] {
  const a = arr(v, path);
  a.forEach((x, i) => str(x, `${path}[${i}]`));
  return a as string[];
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(path, allowed.join(" | "), v);
  return v as T;
}
function numOrNull(v: unknown, path: string): number | null {
  return v === null ? null : num(v, path);
}

const LADDER = ["active", "cut", "stopped"] as const;
const KINDS = ["ALLOCATE", "REALLOCATE", "CUT", "RESTORE", "STOP_OUT", "CROWDING_CUT", "GATE_CLIP"] as const;

function summaryOf(v: unknown, path: string): void {
  const s = obj(v, path);
  for (const k of ["totalReturn", "maxDrawdown", "sharpe", "utility", "stopOuts"]) num(s[k], `${path}.${k}`);
}

function treeState(v: unknown, path: string, nodes: number, ticks: number): void {
  const s = obj(v, path);
  const t = num(s.t, `${path}.t`);
  if (!Number.isInteger(t) || t < -1 || t >= ticks) fail(`${path}.t`, `integer in [-1, ${ticks - 1}]`, t);
  for (const k of ["budget", "spent", "reserved", "available"]) nums(s[k], `${path}.${k}`, nodes);
  for (const k of ["revoked", "present"]) {
    const a = arr(s[k], `${path}.${k}`);
    if (a.length !== nodes) throw new FundSnapshotError(`fund-snapshot.json ${path}.${k}: expected ${nodes} entries, got ${a.length}`);
    a.forEach((x, i) => bool(x, `${path}.${k}[${i}]`));
  }
}

function uplift(v: unknown, path: string): void {
  if (v === null) return;
  const t = obj(v, path);
  for (const track of ["allocator", "tiger"]) {
    const u = obj(t[track], `${path}.${track}`);
    for (const k of ["mean", "lo", "hi", "wins"]) num(u[k], `${path}.${track}.${k}`);
  }
}

/**
 * Validate the untrusted JSON: every field the console dereferences, and that
 * the per-tick series line up (NAV and agent series have `world.ticks` entries,
 * tree states have one column per tree node). Throws `FundSnapshotError` with
 * the JSON path.
 */
export function parseFundSnapshot(raw: unknown): FundSnapshot {
  const s = obj(raw, "root");
  if (s.schema !== "fund-snapshot/1") fail("schema", '"fund-snapshot/1"', s.schema);
  if (s.simulated !== true) fail("simulated", "true (a virtual world)", s.simulated);
  num(s.asOf, "asOf");

  const w = obj(s.world, "world");
  const seed = num(w.seed, "world.seed");
  if (!Number.isInteger(seed) || seed < 1 || seed >= 10_000) fail("world.seed", "research seed in [1, 9999]", seed);
  str(w.seedRule, "world.seedRule");
  const ticks = num(w.ticks, "world.ticks");
  if (!Number.isInteger(ticks) || ticks < 2) fail("world.ticks", "integer ≥ 2", ticks);
  str(w.fund, "world.fund");
  num(w.aum, "world.aum");
  strs(w.stocks, "world.stocks");
  const crowd = obj(w.crowd, "world.crowd");
  bool(crowd.present, "world.crowd.present");
  str(crowd.instrument, "world.crowd.instrument");
  num(crowd.startTick, "world.crowd.startTick");
  num(crowd.crashTick, "world.crowd.crashTick");
  strs(w.pods, "world.pods");
  arr(w.operators, "world.operators").forEach((o, i) => {
    const op = obj(o, `world.operators[${i}]`);
    str(op.id, `world.operators[${i}].id`);
    strs(op.agents, `world.operators[${i}].agents`);
  });

  const policy = obj(s.policy, "policy");
  const center = obj(policy.center, "policy.center");
  num(center.leverage, "policy.center.leverage");
  num(center.cutFactor, "policy.center.cutFactor");
  num(obj(policy.baseline, "policy.baseline").leverage, "policy.baseline.leverage");

  const books = obj(s.books, "books");
  for (const k of ["center", "baseline"]) {
    const b = obj(books[k], `books.${k}`);
    nums(b.nav, `books.${k}.nav`, ticks);
    summaryOf(b.summary, `books.${k}.summary`);
  }

  arr(s.agents, "agents").forEach((v, i) => {
    const p = `agents[${i}]`;
    const a = obj(v, p);
    for (const k of ["label", "name", "pod", "style"]) str(a[k], `${p}.${k}`);
    if (a.operator !== null) str(a.operator, `${p}.operator`);
    oneOf(a.status, `${p}.status`, LADDER);
    nums(a.capital, `${p}.capital`, ticks);
    nums(a.pnl, `${p}.pnl`, ticks);
    for (const k of ["totalPnl", "sharpe", "maxDrawdown"]) num(a[k], `${p}.${k}`);
    if (a.closestTwin !== null) {
      const tw = obj(a.closestTwin, `${p}.closestTwin`);
      str(tw.agent, `${p}.closestTwin.agent`);
      num(tw.corr, `${p}.closestTwin.corr`);
    }
    const b = obj(a.baseline, `${p}.baseline`);
    oneOf(b.status, `${p}.baseline.status`, LADDER);
    numOrNull(b.stoppedAt, `${p}.baseline.stoppedAt`);
    num(b.totalPnl, `${p}.baseline.totalPnl`);
  });

  arr(s.decisions, "decisions").forEach((v, i) => {
    const d = obj(v, `decisions[${i}]`);
    num(d.t, `decisions[${i}].t`);
    oneOf(d.kind, `decisions[${i}].kind`, KINDS);
    str(d.node, `decisions[${i}].node`);
    str(d.detail, `decisions[${i}].detail`);
  });
  obj(s.decisionCounts, "decisionCounts");

  arr(s.groupCuts, "groupCuts").forEach((v, i) => {
    const p = `groupCuts[${i}]`;
    const g = obj(v, p);
    num(g.t, `${p}.t`);
    oneOf(g.kind, `${p}.kind`, ["CLONES", "BOOK", "OTHER"] as const);
    if (g.instrument !== null) str(g.instrument, `${p}.instrument`);
    strs(g.members, `${p}.members`);
    strs(g.pods, `${p}.pods`);
    arr(g.sharedOperators, `${p}.sharedOperators`).forEach((o, j) => {
      const op = obj(o, `${p}.sharedOperators[${j}]`);
      str(op.operator, `${p}.sharedOperators[${j}].operator`);
      strs(op.agents, `${p}.sharedOperators[${j}].agents`);
    });
    for (const k of ["share", "limit", "scale"]) numOrNull(g[k], `${p}.${k}`);
    str(g.detail, `${p}.detail`);
  });

  arr(s.stopOuts, "stopOuts").forEach((v, i) => {
    const p = `stopOuts[${i}]`;
    const so = obj(v, p);
    num(so.t, `${p}.t`);
    for (const k of ["agent", "name", "detail"]) str(so[k], `${p}.${k}`);
    num(so.freed, `${p}.freed`);
    strs(so.subtree, `${p}.subtree`);
  });

  num(s.resizes, "resizes");
  // The end-of-run tree goes through the payment dashboard's own validator.
  const tree = parseSnapshot(s.tree);
  const treeNodes = strs(s.treeNodes, "treeNodes");
  if (treeNodes.length !== tree.nodes.length || treeNodes.some((n, i) => tree.nodes[i]!.name !== n)) {
    throw new FundSnapshotError("fund-snapshot.json treeNodes: must list tree.nodes by name, in order");
  }
  treeState(s.treeAtGrant, "treeAtGrant", treeNodes.length, ticks);
  const states = arr(s.treeStates, "treeStates");
  let last = -2;
  states.forEach((v, i) => {
    treeState(v, `treeStates[${i}]`, treeNodes.length, ticks);
    const t = (v as TreeState).t;
    if (t <= last) throw new FundSnapshotError(`fund-snapshot.json treeStates[${i}].t: ticks must increase`);
    last = t;
  });

  const ev = obj(s.evidence, "evidence");
  str(ev.source, "evidence.source");
  arr(ev.loops, "evidence.loops").forEach((v, i) => {
    const p = `evidence.loops[${i}]`;
    const l = obj(v, p);
    num(l.loop, `${p}.loop`);
    for (const k of ["title", "note"] as const) if (l[k] !== null) str(l[k], `${p}.${k}`);
    const blocks = obj(l.blocks, `${p}.blocks`);
    for (const b of ["A", "B"]) {
      const blk = obj(blocks[b], `${p}.blocks.${b}`);
      num(blk.from, `${p}.blocks.${b}.from`);
      num(blk.count, `${p}.blocks.${b}.count`);
    }
    num(l.candidates, `${p}.candidates`);
    for (const [k, n] of Object.entries(obj(l.statuses, `${p}.statuses`))) num(n, `${p}.statuses.${k}`);
    arr(l.merged, `${p}.merged`).forEach((m, j) => {
      const mm = obj(m, `${p}.merged[${j}]`);
      num(mm.k, `${p}.merged[${j}].k`);
      str(mm.angle, `${p}.merged[${j}].angle`);
      str(mm.track, `${p}.merged[${j}].track`);
    });
    bool(l.confirmed, `${p}.confirmed`);
    uplift(l.blockA, `${p}.blockA`);
    uplift(l.blockB, `${p}.blockB`);
    if (l.headVsBaseline !== null) {
      const h = obj(l.headVsBaseline, `${p}.headVsBaseline`);
      for (const k of ["worlds", "utility", "baseline", "uplift", "lo", "hi", "winRate"]) num(h[k], `${p}.headVsBaseline.${k}`);
    }
  });

  return s as unknown as FundSnapshot;
}
