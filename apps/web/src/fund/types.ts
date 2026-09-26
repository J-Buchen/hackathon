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
  | "OPERATOR_CUT"
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

/** One stop-out filed against an operator: a LOSS on the agent's own record, never misconduct. */
export interface OperatorStopOut {
  /** Full mandate-tree node name. */
  agent: string;
  label: string;
  tick: number;
  /** Whole USDC the close took back. */
  freed: number;
  /** The agent's drawdown when it was stopped out (a fraction). */
  drawdown: number;
}

/**
 * One operator's record after the showcase run: the stop-outs the book filed
 * against it (runBook's IncidentSink → the adapters' StopOutIncidentSink), and
 * whether the adapters' OperatorGrantScreen would refuse it a NEW grant under
 * its default limits. Nothing already granted is taken back; nothing is slashed.
 */
export interface OperatorRecordRow {
  id: string;
  agents: string[];
  stopOuts: OperatorStopOut[];
  /** Misconduct incidents: the book files none (a stop-out is a loss). */
  misconduct: 0;
  wouldRefuseNewGrant: boolean;
  /** OperatorGrantScreen's own words. */
  reason: string;
}

/** The mandate tree checked against a replay of its own event log during the run (DelegationTree.verifyAgainstLog). */
export interface AuditTrail {
  checks: number;
  discrepancies: number;
  events: number;
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

/** The center book's mean max drawdown on a sealed block, before → after the loop, vs guardrails (report `riskSummary`). */
export interface RiskSummary {
  block: string;
  seeds: string;
  centerMaxDDBefore: number;
  centerMaxDDAfter: number;
  guardrailsMaxDD: number;
  /**
   * The center book's mean max drawdown after the change with its returns
   * scaled to the guardrails book's volatility (its drawdown per unit of risk).
   * Null when the loop did not record it. Shown NEXT TO `centerMaxDDAfter`,
   * never instead of it.
   */
  centerMaxDDAtGuardrailsVolAfter: number | null;
  /** Paired change with its 90% interval; null when the loop did not record it. */
  pairedChange: { mean: number; lo: number; hi: number } | null;
  /** Tiger-track loops: the overlay's max drawdown before → after, buy-and-hold's, and the paired change. */
  tiger: { before: number; after: number; buyHold: number; pairedChange: { mean: number; lo: number; hi: number } | null } | null;
  note: string | null;
}

/** A candidate the loop did not merge, with the ledger's one-line reason. */
export interface Rejection {
  title: string;
  reason: string;
}

/** Center book vs per-agent guardrails on a loop's confirmation block (means over its sealed virtual worlds). */
export interface SealedBooks {
  block: "B";
  seeds: { from: number; count: number };
  center: { utility: number; sharpe: number; maxDrawdown: number };
  guardrails: { utility: number; sharpe: number | null; maxDrawdown: number };
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
  /** Block-B uplift re-measured after a post-push correction, vs the commit named in `vs`. */
  correctedB: { uplift: Uplift; vs: string | null } | null;
  /** Block A's re-measured gain after a correction; null when none (absent in older snapshots). */
  correctedA: { uplift: Uplift; vs: string | null } | null;
  riskSummary: RiskSummary | null;
  rejections: Rejection[];
  booksB: SealedBooks | null;
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
  /** null in a snapshot written before the operator record existed. */
  operatorRecord: OperatorRecordRow[] | null;
  operatorRecordLimits: { maxStopOuts: number; maxMisconduct: 0 } | null;
  /** null in a snapshot written before the log replay check was recorded. */
  audit: AuditTrail | null;
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
const KINDS = ["ALLOCATE", "REALLOCATE", "CUT", "RESTORE", "STOP_OUT", "CROWDING_CUT", "OPERATOR_CUT", "GATE_CLIP"] as const;

function summaryOf(v: unknown, path: string): void {
  const s = obj(v, path);
  for (const k of ["totalReturn", "maxDrawdown", "sharpe", "utility", "stopOuts"]) num(s[k], `${path}.${k}`);
}

function treeState(v: unknown, path: string, nodes: number, ticks: number): void {
  const s = obj(v, path);
  const t = num(s.t, `${path}.t`);
  if (!Number.isInteger(t) || t < -1 || t >= ticks) outOfRange(`${path}.t`, `integer in [-1, ${ticks - 1}]`, t);
  for (const k of ["budget", "spent", "reserved", "available"]) nums(s[k], `${path}.${k}`, nodes);
  for (const k of ["revoked", "present"]) {
    const a = arr(s[k], `${path}.${k}`);
    if (a.length !== nodes) throw new FundSnapshotError(`fund-snapshot.json ${path}.${k}: expected ${nodes} entries, got ${a.length}`);
    a.forEach((x, i) => bool(x, `${path}.${k}[${i}]`));
  }
}

function count(v: unknown, path: string): number {
  const x = num(v, path);
  if (!Number.isInteger(x) || x < 0) outOfRange(path, "whole number ≥ 0", x);
  return x;
}

/**
 * The operator record: one row per operator of the world, in the world's
 * order, listing exactly the agents the world gives that operator; the filed
 * stop-outs are exactly the book's stop-outs (each once, under the operator
 * that runs the agent, with the label and amount freed the book reports); and
 * the new-grant answer is the one the stated limit gives (the chip the console
 * shows can never disagree with the count next to it). Absent from snapshots
 * written before it existed: both keys missing read as null (the console then
 * hides the panel with a note); one without the other is refused.
 */
function operatorRecord(s: Obj, ticks: number): void {
  if (s.operatorRecord === undefined && s.operatorRecordLimits === undefined) {
    s.operatorRecord = null;
    s.operatorRecordLimits = null;
    return;
  }
  const lim = obj(s.operatorRecordLimits, "operatorRecordLimits");
  const maxStopOuts = count(lim.maxStopOuts, "operatorRecordLimits.maxStopOuts");
  // The book files stop-outs only, and the adapters' default refuses any misconduct.
  if (lim.maxMisconduct !== 0) {
    if (typeof lim.maxMisconduct === "number") outOfRange("operatorRecordLimits.maxMisconduct", "0", lim.maxMisconduct);
    fail("operatorRecordLimits.maxMisconduct", "0", lim.maxMisconduct);
  }
  const operators = (obj(s.world, "world").operators as Array<{ id: string; agents: string[] }>) ?? [];
  const stops = s.stopOuts as Array<{ t: number; name: string; agent: string; freed: number }>;
  const key = (name: string, t: number) => `${name}@${t}`;
  const rows = arr(s.operatorRecord, "operatorRecord");
  if (rows.length !== operators.length) {
    throw new FundSnapshotError(`fund-snapshot.json operatorRecord: expected one row per world operator (${operators.length}), got ${rows.length}`);
  }
  const filed = new Set<string>();
  rows.forEach((v, i) => {
    const p = `operatorRecord[${i}]`;
    const r = obj(v, p);
    const op = operators[i]!;
    const id = str(r.id, `${p}.id`);
    if (id !== op.id) throw new FundSnapshotError(`fund-snapshot.json ${p}.id: expected ${op.id} (world order), got ${id}`);
    const agents = strs(r.agents, `${p}.agents`);
    if (agents.length !== op.agents.length || agents.some((a, k) => a !== op.agents[k])) {
      throw new FundSnapshotError(`fund-snapshot.json ${p}.agents: expected ${op.agents.join(", ")} (world.operators[${i}]), got ${agents.join(", ")}`);
    }
    arr(r.stopOuts, `${p}.stopOuts`).forEach((x, j) => {
      const q = `${p}.stopOuts[${j}]`;
      const so = obj(x, q);
      const agent = str(so.agent, `${q}.agent`);
      const label = str(so.label, `${q}.label`);
      const tick = count(so.tick, `${q}.tick`);
      if (tick >= ticks) outOfRange(`${q}.tick`, `integer in [0, ${ticks - 1}]`, tick);
      const freed = count(so.freed, `${q}.freed`);
      fraction(so.drawdown, `${q}.drawdown`);
      if (!agents.includes(label)) throw new FundSnapshotError(`fund-snapshot.json ${q}.label: ${label} is not an agent of ${id}`);
      const st = stops.find((st) => st.name === agent && st.t === tick);
      if (!st) throw new FundSnapshotError(`fund-snapshot.json ${q}: no stop-out of ${agent} on tick ${tick} in stopOuts`);
      if (st.agent !== label) throw new FundSnapshotError(`fund-snapshot.json ${q}.label: ${agent} is ${st.agent} in stopOuts, got ${label}`);
      if (freed !== st.freed) throw new FundSnapshotError(`fund-snapshot.json ${q}.freed: stopOuts says ${st.freed}, got ${freed}`);
      const k = key(agent, tick);
      if (filed.has(k)) throw new FundSnapshotError(`fund-snapshot.json ${q}: the stop-out of ${agent} on tick ${tick} is filed twice`);
      filed.add(k);
    });
    if (r.misconduct !== 0) fail(`${p}.misconduct`, "0 (the book files stop-outs only)", r.misconduct);
    const refused = bool(r.wouldRefuseNewGrant, `${p}.wouldRefuseNewGrant`);
    const n = (r.stopOuts as unknown[]).length;
    if (refused !== n > maxStopOuts) {
      throw new FundSnapshotError(`fund-snapshot.json ${p}.wouldRefuseNewGrant: ${refused} with ${n} stop-out(s) and a limit of ${maxStopOuts}`);
    }
    str(r.reason, `${p}.reason`);
  });
  const missing = stops.find((st) => !filed.has(key(st.name, st.t)));
  if (missing) {
    throw new FundSnapshotError(`fund-snapshot.json operatorRecord: the stop-out of ${missing.name} on tick ${missing.t} is not on record`);
  }
}

/**
 * The log replay check: runBook compares the tree with a replay of its own log
 * at the start, the trade and the end of every tick and stops on the first
 * difference, so a finished run has exactly 3 × ticks checks and 0 differences.
 * Absent from snapshots written before it existed: missing reads as null.
 */
function auditTrail(s: Obj, ticks: number): void {
  if (s.audit === undefined) {
    s.audit = null;
    return;
  }
  const a = obj(s.audit, "audit");
  const checks = count(a.checks, "audit.checks");
  if (checks !== 3 * ticks) outOfRange("audit.checks", `${3 * ticks} (start, trade and end of each of ${ticks} ticks)`, checks);
  const diffs = count(a.discrepancies, "audit.discrepancies");
  if (diffs !== 0) outOfRange("audit.discrepancies", "0 (the book stops on the first difference)", diffs);
  const events = count(a.events, "audit.events");
  if (events < 1) outOfRange("audit.events", "whole number ≥ 1", events);
}

function uplift(v: unknown, path: string): void {
  if (v === null) return;
  const t = obj(v, path);
  for (const track of ["allocator", "tiger"]) {
    const u = obj(t[track], `${path}.${track}`);
    for (const k of ["mean", "lo", "hi", "wins"]) num(u[k], `${path}.${track}.${k}`);
  }
}

/** A value of the right type but out of range: the message names the value itself. */
function outOfRange(path: string, expected: string, actual: number): never {
  throw new FundSnapshotError(`fund-snapshot.json ${path}: expected ${expected}, got ${actual}`);
}

/** A drawdown as a fraction: finite and in [0, 1] (never negative; 7.75 would be percent units). */
function fraction(v: unknown, path: string): number {
  const x = num(v, path);
  if (x < 0 || x > 1) outOfRange(path, "number in [0, 1]", x);
  return x;
}

/** An interval: lo ≤ mean ≤ hi. */
function interval(v: unknown, path: string, keys: readonly string[]): void {
  const o = obj(v, path);
  for (const k of keys) num(o[k], `${path}.${k}`);
  const { mean, lo, hi } = o as { mean: number; lo: number; hi: number };
  if (!(lo <= mean && mean <= hi)) {
    throw new FundSnapshotError(`fund-snapshot.json ${path}: expected lo ≤ mean ≤ hi, got ${lo}, ${mean}, ${hi}`);
  }
}

function riskSummary(v: unknown, path: string): void {
  if (v === null) return;
  const r = obj(v, path);
  str(r.block, `${path}.block`);
  str(r.seeds, `${path}.seeds`);
  for (const k of ["centerMaxDDBefore", "centerMaxDDAfter", "guardrailsMaxDD"]) fraction(r[k], `${path}.${k}`);
  // Nullable, and absent from snapshots written before it existed: missing
  // reads as null ("not recorded"), anything else must be a drawdown in [0, 1].
  if (r.centerMaxDDAtGuardrailsVolAfter === undefined) r.centerMaxDDAtGuardrailsVolAfter = null;
  else if (r.centerMaxDDAtGuardrailsVolAfter !== null) fraction(r.centerMaxDDAtGuardrailsVolAfter, `${path}.centerMaxDDAtGuardrailsVolAfter`);
  if (r.pairedChange !== null) interval(r.pairedChange, `${path}.pairedChange`, ["mean", "lo", "hi"]);
  // Absent from snapshots written before tiger-track loops: missing reads as null.
  if (r.tiger === undefined) r.tiger = null;
  else if (r.tiger !== null) {
    const t = obj(r.tiger, `${path}.tiger`);
    for (const k of ["before", "after", "buyHold"]) fraction(t[k], `${path}.tiger.${k}`);
    if (t.pairedChange !== null) interval(t.pairedChange, `${path}.tiger.pairedChange`, ["mean", "lo", "hi"]);
  }
  if (r.note !== null) str(r.note, `${path}.note`);
}

function sealedBooks(v: unknown, path: string): void {
  if (v === null) return;
  const b = obj(v, path);
  if (b.block !== "B") fail(`${path}.block`, '"B"', b.block);
  const seeds = obj(b.seeds, `${path}.seeds`);
  num(seeds.from, `${path}.seeds.from`);
  const count = num(seeds.count, `${path}.seeds.count`);
  if (!Number.isInteger(count) || count < 1) outOfRange(`${path}.seeds.count`, "positive integer", count);
  const c = obj(b.center, `${path}.center`);
  num(c.utility, `${path}.center.utility`);
  num(c.sharpe, `${path}.center.sharpe`);
  fraction(c.maxDrawdown, `${path}.center.maxDrawdown`);
  const g = obj(b.guardrails, `${path}.guardrails`);
  num(g.utility, `${path}.guardrails.utility`);
  numOrNull(g.sharpe, `${path}.guardrails.sharpe`);
  fraction(g.maxDrawdown, `${path}.guardrails.maxDrawdown`);
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
  if (!Number.isInteger(seed) || seed < 1 || seed >= 10_000) outOfRange("world.seed", "research seed in [1, 9999]", seed);
  str(w.seedRule, "world.seedRule");
  const ticks = num(w.ticks, "world.ticks");
  if (!Number.isInteger(ticks) || ticks < 2) outOfRange("world.ticks", "integer ≥ 2", ticks);
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

  operatorRecord(s, ticks);
  auditTrail(s, ticks);

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
    if (l.correctedA === undefined) l.correctedA = null;
    else if (l.correctedA !== null) {
      const c = obj(l.correctedA, `${p}.correctedA`);
      interval(c.uplift, `${p}.correctedA.uplift`, ["mean", "lo", "hi", "wins"]);
      if (c.vs !== null) str(c.vs, `${p}.correctedA.vs`);
    }
    if (l.correctedB !== null) {
      const c = obj(l.correctedB, `${p}.correctedB`);
      interval(c.uplift, `${p}.correctedB.uplift`, ["mean", "lo", "hi", "wins"]);
      if (c.vs !== null) str(c.vs, `${p}.correctedB.vs`);
    }
    riskSummary(l.riskSummary, `${p}.riskSummary`);
    arr(l.rejections, `${p}.rejections`).forEach((r, j) => {
      const rr = obj(r, `${p}.rejections[${j}]`);
      str(rr.title, `${p}.rejections[${j}].title`);
      str(rr.reason, `${p}.rejections[${j}].reason`);
    });
    sealedBooks(l.booksB, `${p}.booksB`);
    if (l.headVsBaseline !== null) {
      const h = obj(l.headVsBaseline, `${p}.headVsBaseline`);
      for (const k of ["worlds", "utility", "baseline", "uplift", "lo", "hi", "winRate"]) num(h[k], `${p}.headVsBaseline.${k}`);
    }
  });

  return s as unknown as FundSnapshot;
}
