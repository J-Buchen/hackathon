/**
 * (G) An operator's cap never compounds with a name's own ladder and never
 * weakens it. This holds however many names the operator runs, and in
 * whatever order its names are stopped, cut, restored, capped, lifted and
 * capped again. Per name, at every tick, while its mandate is live:
 *
 *     min(L, cutFactor × fullSize)  ≤  budget  ≤  L
 *
 * L is what the name holds under its OWN rules alone: the same book with its
 * operator label removed, where no crowding limit binds. (A crowding cut is
 * solved on what the names actually hold. It lands on the own size as the same
 * absolute level, which arena-operator-sizing.test.ts checks with crowding on.)
 * The lower bound is the stricter of its own rules and ONE operator cap, so
 * the two never compound. The upper bound is its own rules, so an operator
 * label never leaves a name more than its own ladder allows. The book keeps
 * the two numbers apart (`OperatorSizing`: own size and ceiling), and the name
 * holds the smaller.
 *
 * Four checks, from the algebra to the book:
 *  1. the sizing algebra, one case per known failure of an earlier design;
 *  2. a property test of the pure pieces the book composes
 *     (`nextCounterpartyCaps`, `nextSizing`) over random event sequences with
 *     1–5 names per operator, against an independent reference model. The
 *     same harness finds counterexamples in loop 3's rule and in loop 4's
 *     rejected rule, so it can fail;
 *  3. the loop-4 review's counterexample (three names, a lift, then a re-cap)
 *     and two more paths, on a scripted book, against the same book without
 *     labels;
 *  4. random scripted books (1–5 names per operator, random records, many
 *     reallocations), against the same books without labels, tick by tick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutToCeiling,
  defaultCenterBookPolicy,
  nextCounterpartyCaps,
  nextSizing,
  sizedBudget,
  type CenterBookPolicy,
  type CounterpartyAgent,
  type CounterpartyCap,
  type LadderState,
  type OperatorSizing,
  type SizingEvent,
} from "./allocator";
import { runBook, type AgentResult, type BookResult, type SwarmSpec } from "./book";
import { generateMarket, type Market } from "./market";
import { gaussian, mulberry32 } from "./rng";
import type { Strategy, Weights } from "./strategies";

const CF = 0.5;
const BAND = 0.1;
const P = { cutFactor: CF, rebalanceBand: BAND };

/* ------------------------------------------------------------------ */
/* 1. The algebra, case by case                                       */
/* ------------------------------------------------------------------ */

test("sizing: every rule moves only its own number, and the name holds the smaller", () => {
  const full = 1000;
  const step = (s: OperatorSizing, ...events: SizingEvent[]) =>
    events.reduce((x, e) => nextSizing(x, e, P), s);
  const fresh: OperatorSizing = { own: full, ceiling: null };

  // A cap sets a ceiling and leaves the own size alone.
  const capped = step(fresh, { kind: "cap", fullSize: full });
  assert.deepEqual(capped, { own: 1000, ceiling: 500 });
  assert.equal(sizedBudget(capped), 500);

  // Its own ladder cuts its own size: at the ceiling already, not cut again (never 250).
  assert.equal(sizedBudget(step(capped, { kind: "ladderCut" })), 500);

  // Loop 4's counterexample: capped, lifted (no event: held until the next
  // reallocation), capped again, then cut by its own ladder. 500, not 250.
  const recut = step(capped, { kind: "cap", fullSize: full }, { kind: "ladderCut" });
  assert.deepEqual(recut, { own: 500, ceiling: 500 });

  // Lifted, then cut by its own ladder with no re-cap: 500, not 250 (loop 3's compounding).
  assert.equal(sizedBudget(step(capped, { kind: "ladderCut" })), 500);

  // Cut and restored by its own ladder (still at half size), capped, then cut
  // again: its own ladder alone takes it to 250, and so does the book (loop 3
  // left it at 500, twice what its ladder allows).
  const bounced = step(fresh, { kind: "ladderCut" }, { kind: "cap", fullSize: full });
  assert.equal(sizedBudget(bounced), 500, "the cap does not cut it again");
  assert.equal(sizedBudget(step(bounced, { kind: "ladderCut" })), 250);

  // Crowding-cut to 400, then capped: it holds 400. Its own ladder then cuts it to 200.
  const crowded = step(fresh, { kind: "crowdCut", to: 400 }, { kind: "cap", fullSize: full });
  assert.equal(sizedBudget(crowded), 400);
  assert.equal(sizedBudget(step(crowded, { kind: "ladderCut" })), 200);

  // A crowding cut under the cap is an absolute level: it holds exactly that.
  assert.deepEqual(step(capped, { kind: "crowdCut", to: 300 }), { own: 300, ceiling: 500 });

  // A reallocation while capped: the own size moves under the band, the
  // ceiling follows the new full size exactly.
  assert.deepEqual(step(capped, { kind: "reallocate", target: 1050, fullSize: 1050, capped: true }), { own: 1000, ceiling: 525 });
  assert.deepEqual(step(capped, { kind: "reallocate", target: 1200, fullSize: 1200, capped: true }), { own: 1200, ceiling: 600 });
  // Once the cap has lifted, the next reallocation drops the ceiling: back to its own size.
  const released = step(capped, { kind: "reallocate", target: 1050, fullSize: 1050, capped: false });
  assert.deepEqual(released, { own: 1000, ceiling: null });
  assert.equal(sizedBudget(released), 1000);

  // Stopped: nothing.
  assert.deepEqual(step(capped, { kind: "stop" }), { own: 0, ceiling: null });
});

/* ------------------------------------------------------------------ */
/* 2. Property test over random event sequences                       */
/* ------------------------------------------------------------------ */

/** One sizing rule under test: what a name holds, moved by the book's events. */
interface Rule {
  budget(name: string): number;
  /** The own size the rule keeps, if it keeps one (checked against the reference). */
  own?(name: string): number;
  reallocate(name: string, e: { target: number; fullSize: number; capped: boolean }): void;
  /** `capped`: the operator's cap is in force at the ladder step (the book's `operatorCaps`). */
  ladderCut(name: string, e: { fullSize: number; capped: boolean }): void;
  crowdCut(name: string, to: number): void;
  cap(name: string, fullSize: number): void;
  lift(name: string): void;
  stop(name: string): void;
}

const bandMove = (current: number, target: number) =>
  current === 0 ? target > 0 : Math.abs(target - current) / current >= BAND;

/** The book's rule: `nextSizing`, on every event. */
function sizingRule(start: ReadonlyMap<string, number>): Rule {
  const s = new Map<string, OperatorSizing>([...start].map(([n, b]) => [n, { own: b, ceiling: null }]));
  const move = (n: string, e: SizingEvent) => s.set(n, nextSizing(s.get(n)!, e, P));
  return {
    budget: (n) => sizedBudget(s.get(n)!),
    own: (n) => s.get(n)!.own,
    reallocate: (n, e) => move(n, { kind: "reallocate", ...e }),
    ladderCut: (n) => move(n, { kind: "ladderCut" }),
    crowdCut: (n, to) => move(n, { kind: "crowdCut", to }),
    cap: (n, fullSize) => move(n, { kind: "cap", fullSize }),
    lift: () => {},
    stop: (n) => move(n, { kind: "stop" }),
  };
}

/** Loop 3's rule (2ed5107): one number, cut on capital to the ceiling. */
function loop3Rule(start: ReadonlyMap<string, number>): Rule {
  const b = new Map(start);
  return {
    budget: (n) => b.get(n)!,
    reallocate: (n, e) => {
      const target = e.capped ? Math.min(e.target, CF * e.fullSize) : e.target;
      if (bandMove(b.get(n)!, target)) b.set(n, target);
    },
    ladderCut: (n, e) => {
      if (!e.capped) return void b.set(n, b.get(n)! * CF);
      const to = cutToCeiling(b.get(n)!, e.fullSize, CF);
      if (to !== null) b.set(n, to);
    },
    crowdCut: (n, to) => void b.set(n, to),
    cap: (n, fullSize) => {
      const to = cutToCeiling(b.get(n)!, fullSize, CF);
      if (to !== null) b.set(n, to);
    },
    lift: () => {},
    stop: (n) => void b.set(n, 0),
  };
}

/**
 * Loop 4's rejected rule: an "uncapped budget" kept only while the cap is in
 * force, seeded from the budget when capped, and dropped when the cap lifts.
 */
function loop4Rule(start: ReadonlyMap<string, number>): Rule {
  const b = new Map(start);
  const uncapped = new Map<string, number>();
  return {
    budget: (n) => b.get(n)!,
    reallocate: (n, e) => {
      const u = uncapped.get(n);
      if (u !== undefined && bandMove(u, e.target)) uncapped.set(n, e.target);
      const target = e.capped ? Math.min(e.target, CF * e.fullSize) : e.target;
      if (bandMove(b.get(n)!, target)) b.set(n, target);
    },
    ladderCut: (n, e) => {
      const u = uncapped.get(n);
      if (!e.capped || u === undefined) return void b.set(n, b.get(n)! * CF);
      const to = cutToCeiling(b.get(n)!, Math.min(e.fullSize, u), CF);
      uncapped.set(n, u * CF);
      if (to !== null) b.set(n, to);
    },
    crowdCut: (n, to) => {
      const u = uncapped.get(n);
      if (u !== undefined) uncapped.set(n, u * (to / b.get(n)!));
      b.set(n, to);
    },
    cap: (n, fullSize) => {
      uncapped.set(n, b.get(n)!);
      const to = cutToCeiling(b.get(n)!, fullSize, CF);
      if (to !== null) b.set(n, to);
    },
    lift: (n) => void uncapped.delete(n),
    stop: (n) => {
      b.set(n, 0);
      uncapped.delete(n);
    },
  };
}

interface Violation {
  seed: number;
  t: number;
  name: string;
  kind: "ABOVE_OWN" | "BELOW_ONE_CAP" | "CAP_NOT_BINDING" | "GREW_BETWEEN_REALLOCATIONS" | "OWN_MOVED";
  budget: number;
  own: number;
  ceiling: number;
}

interface Coverage {
  operatorsBySize: number[];
  caps: number;
  recapsAfterLift: number;
  recapsWhileHeld: number;
  ladderCutsWhileHeld: number;
  ladderCutsAfterLift: number;
  crowdCutsWhileHeld: number;
  reallocationsWhileCapped: number;
  releases: number;
  bindsBelowOwn: number;
}

const TICKS = 80;
const WARMUP = 6;
const EVERY = 5;
const isReallocation = (t: number) => t >= WARMUP && (t - WARMUP) % EVERY === 0;

/**
 * Random event sequences on 1–3 operators with 1–5 names each (the first
 * operator's size cycles through 1..5 with the seed), plus unlabelled names.
 * Every tick, in the book's order: a reallocation (on schedule), crowding
 * cuts, each name's own ladder (stop, cut, restore, or a new high), then the
 * operator bookkeeping (`nextCounterpartyCaps`, as the book calls it). The
 * reference L is an independent model of the name's own rules alone; the
 * rule under test is checked against it after every tick.
 */
function simulate(seed: number, make: (start: ReadonlyMap<string, number>) => Rule, cover?: Coverage): Violation[] {
  const u = mulberry32(seed);
  const unif = (lo: number, hi: number) => lo + (hi - lo) * u();
  const sizes = [1 + (seed % 5), 1 + Math.floor(u() * 5), 1 + Math.floor(u() * 5)].slice(0, 1 + Math.floor(u() * 3));
  const names: { name: string; operator?: string }[] = [];
  sizes.forEach((k, o) => {
    if (cover) cover.operatorsBySize[k]!++;
    for (let i = 0; i < k; i++) names.push({ name: `op${o}-n${i}`, operator: `op${o}` });
  });
  for (let i = 0; i < 1 + Math.floor(u() * 2); i++) names.push({ name: `anon-${i}` });

  const start = 1000;
  const rule = make(new Map(names.map((n) => [n.name, start])));
  // The reference: the name's own rules alone, and nothing else.
  const L = new Map(names.map((n) => [n.name, start]));
  const full = new Map(names.map((n) => [n.name, start]));
  const crowdCap = new Map<string, number>();
  const ladder = new Map<string, LadderState>(names.map((n) => [n.name, "active"]));
  const records = new Map<string, number[]>(names.map((n) => [n.name, []]));
  const equity = new Map(names.map((n) => [n.name, { e: 1, peak: 1 }]));
  let caps: ReadonlyMap<string, CounterpartyCap> = new Map();
  // Coverage bookkeeping: when each name was last lifted, capped, reallocated.
  const liftedAt = new Map<string, number>();
  const cappedCount = new Map<string, number>();
  let lastRealloc = -1;
  const out: Violation[] = [];

  for (let t = 0; t < TICKS; t++) {
    const live = names.filter((n) => ladder.get(n.name) !== "stopped");
    const before = new Map(live.map((n) => [n.name, rule.budget(n.name)]));

    // Reallocation: new full sizes; the own target is the ladder's cut and any crowding cap.
    if (isReallocation(t)) {
      const previous = lastRealloc;
      lastRealloc = t;
      for (const { name } of live) {
        if (crowdCap.has(name) && u() < 0.3) crowdCap.delete(name); // its book changed
        const f = start * unif(0.5, 1.6);
        full.set(name, f);
        const target = Math.min(f * (ladder.get(name) === "cut" ? CF : 1), crowdCap.get(name) ?? Infinity);
        if (bandMove(L.get(name)!, target)) L.set(name, target);
        const capped = caps.has(name);
        if (cover && capped) cover.reallocationsWhileCapped++;
        if (cover && !capped && (liftedAt.get(name) ?? -Infinity) > previous) cover.releases++;
        rule.reallocate(name, { target, fullSize: f, capped });
      }
    }

    // Crowding: a cut to an absolute level, solved on what the name holds.
    for (const { name } of live) {
      if (u() >= 0.05) continue;
      const to = rule.budget(name) * unif(0.3, 0.95);
      crowdCap.set(name, Math.min(crowdCap.get(name) ?? Infinity, to));
      L.set(name, Math.min(L.get(name)!, to));
      if (cover && caps.has(name)) cover.crowdCutsWhileHeld++;
      rule.crowdCut(name, to);
    }

    // Each name's own ladder, and its record (for the new-high lift).
    const stoppedNow: string[] = [];
    const restoredNow: string[] = [];
    for (const { name } of live) {
      const q = equity.get(name)!;
      const newHigh = u() < 0.15;
      const r = newHigh ? (q.peak / q.e) * 1.01 - 1 : -0.001 * u();
      q.e *= 1 + r;
      q.peak = Math.max(q.peak, q.e);
      records.get(name)!.push(r);
      const state = ladder.get(name)!;
      const x = u();
      let next: LadderState = state;
      if (x < 0.03) next = "stopped";
      else if (state === "active" && !newHigh && x < 0.15) next = "cut";
      else if (state === "cut" && (newHigh || x < 0.3)) next = "active";
      if (next === state) continue;
      ladder.set(name, next);
      if (next === "stopped") {
        stoppedNow.push(name);
        L.set(name, 0);
        rule.stop(name);
      } else if (next === "cut") {
        L.set(name, L.get(name)! * CF);
        if (cover && caps.has(name)) cover.ladderCutsWhileHeld++;
        if (cover && !caps.has(name) && (liftedAt.get(name) ?? -Infinity) > lastRealloc) cover.ladderCutsAfterLift++;
        rule.ladderCut(name, { fullSize: full.get(name)!, capped: caps.has(name) });
      } else {
        restoredNow.push(name);
      }
    }

    // The operator bookkeeping the book runs after every ladder has moved.
    const agents: CounterpartyAgent[] = names.map((n) => ({
      name: n.name,
      ...(n.operator === undefined ? {} : { operator: n.operator }),
      ladder: ladder.get(n.name)!,
      unitReturns: records.get(n.name)!,
    }));
    const update = nextCounterpartyCaps(caps, agents, stoppedNow, restoredNow, t);
    for (const name of update.lifted) {
      liftedAt.set(name, t);
      rule.lift(name);
    }
    for (const { name } of update.capped) {
      if (cover) {
        cover.caps++;
        if (cappedCount.has(name) && liftedAt.has(name)) cover.recapsAfterLift++;
        if (cappedCount.has(name) && (liftedAt.get(name) ?? -Infinity) > lastRealloc) cover.recapsWhileHeld++;
      }
      cappedCount.set(name, (cappedCount.get(name) ?? 0) + 1);
      rule.cap(name, full.get(name)!);
    }
    caps = update.caps;

    // The invariant, after the tick.
    for (const { name } of names.filter((n) => ladder.get(n.name) !== "stopped")) {
      const b = rule.budget(name);
      const own = L.get(name)!;
      const ceiling = CF * full.get(name)!;
      const eps = 1e-9 * Math.max(1, own);
      const v = (kind: Violation["kind"]) => out.push({ seed, t, name, kind, budget: b, own, ceiling });
      if (b > own + eps) v("ABOVE_OWN");
      if (b < Math.min(own, ceiling) - eps) v("BELOW_ONE_CAP");
      if (caps.has(name) && b > ceiling + eps) v("CAP_NOT_BINDING");
      if (!isReallocation(t) && b > before.get(name)! + eps) v("GREW_BETWEEN_REALLOCATIONS");
      if (rule.own !== undefined && Math.abs(rule.own(name) - own) > eps) v("OWN_MOVED");
      if (cover && b < own - eps) cover.bindsBelowOwn++;
    }
  }
  return out;
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

test("property: over random event sequences with 1–5 names per operator, min(own, one cap) ≤ budget ≤ own, always", () => {
  const cover: Coverage = {
    operatorsBySize: [0, 0, 0, 0, 0, 0],
    caps: 0,
    recapsAfterLift: 0,
    recapsWhileHeld: 0,
    ladderCutsWhileHeld: 0,
    ladderCutsAfterLift: 0,
    crowdCutsWhileHeld: 0,
    reallocationsWhileCapped: 0,
    releases: 0,
    bindsBelowOwn: 0,
  };
  // Includes OWN_MOVED: the book's own size IS the reference's own-rules
  // budget after every tick, so no operator event (cap, re-cap, lift) moved it.
  const violations = SEEDS.flatMap((seed) => simulate(seed, sizingRule, cover));
  assert.deepEqual(violations.slice(0, 5), [], `${violations.length} violations`);
  // The sequences exercised every path the invariant has to survive.
  for (let k = 1; k <= 5; k++) assert.ok(cover.operatorsBySize[k]! >= 20, `operators with ${k} names: ${JSON.stringify(cover)}`);
  for (const [k, v] of Object.entries(cover)) if (typeof v === "number") assert.ok(v >= 20, `${k}: ${JSON.stringify(cover)}`);
});

test("property: the same harness finds loop 3's and loop 4's failures (it can fail)", () => {
  const found = (make: (s: ReadonlyMap<string, number>) => Rule) => {
    const vs = SEEDS.flatMap((seed) => simulate(seed, make));
    return { below: vs.filter((v) => v.kind === "BELOW_ONE_CAP"), above: vs.filter((v) => v.kind === "ABOVE_OWN") };
  };
  const l3 = found(loop3Rule);
  assert.ok(l3.below.length > 0, "loop 3 compounds a lifted cap with a ladder cut");
  assert.ok(l3.above.length > 0, "loop 3 leaves a capped name more than its own ladder allows");
  const l4 = found(loop4Rule);
  assert.ok(l4.below.length > 0, "loop 4 compounds a re-cap with a ladder cut");
  // Down to cutFactor² × full size (the review's 25%), where one cap or the ladder alone leaves cutFactor.
  assert.ok(
    l4.below.some((v) => v.budget <= CF * v.ceiling * (1 + 1e-9) && v.own >= v.ceiling),
    JSON.stringify(l4.below[0]),
  );
});

/* ------------------------------------------------------------------ */
/* Books, against the same books with the operator labels removed     */
/* ------------------------------------------------------------------ */

const FUND = "fund.eth";

/** Holds one instrument, long 0.5 at leverage 2: its record IS the instrument's return. */
class Hold implements Strategy {
  readonly style = "hold";
  constructor(private readonly instrument: string) {}
  decide(): Weights {
    return { [this.instrument]: 0.5 };
  }
}

interface Roster {
  label: string;
  operator?: string;
  script: (t: number) => number;
}

const podOf = (i: number) => (i % 2 === 0 ? "alpha" : "beta");

function scriptedMarket(roster: readonly Roster[], ticks: number, seed: number): Market {
  const instruments = roster.map((r) => r.label.toUpperCase());
  const m = generateMarket({
    seed,
    ticks,
    instruments,
    factorVol: 0.008,
    idioVol: 0.01,
    // No crowd in this market.
    crowd: { instrument: instruments[0]!, startTick: 1e6, crashTick: 1e6 + 1, inflowDrift: 0, crashSize: 0, contagion: 0 },
  });
  for (const tick of m.ticks) roster.forEach((r, i) => (tick.returns[instruments[i]!] = r.script(tick.t)));
  return m;
}

function spec(roster: readonly Roster[], labelled: boolean): SwarmSpec {
  const instruments = roster.map((r) => r.label.toUpperCase());
  return {
    principal: "alice",
    fund: FUND,
    aum: 10_000_000,
    pods: [
      { label: "alpha", instruments },
      { label: "beta", instruments },
    ],
    agents: roster.map((r, i) => ({
      label: r.label,
      pod: podOf(i),
      ...(labelled && r.operator !== undefined ? { operator: r.operator } : {}),
      instruments,
      strategy: new Hold(instruments[i]!),
    })),
  };
}

/**
 * Check a labelled book against the same book without labels, tick by tick,
 * for every live name: its own size IS the unlabelled budget (to the
 * micro-USDC), and its budget sits in [min(that, cutFactor × full size),
 * that]. The two books must agree on every full size (checked): the
 * allocator sees the same records, and the books are built so that it
 * deploys the same capital.
 */
function checkAgainstBlind(lab: BookResult, blind: BookResult, what: string, cf: number): { ticks: number; binding: number } {
  let ticks = 0;
  let binding = 0;
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(y));
  for (const a of lab.agents) {
    const b: AgentResult = blind.agents.find((x) => x.label === a.label)!;
    assert.deepEqual(a.unitReturns, b.unitReturns, `${what} ${a.label}: records never depend on capital`);
    assert.equal(a.ladder, b.ladder, `${what} ${a.label}: operator labels move no ladder`);
    for (let t = 0; t < a.capital.length; t++) {
      assert.equal(a.fullSize[t], b.fullSize[t], `${what} ${a.label} t=${t}: the allocator gave the same full size`);
      const own = b.capital[t]!;
      const got = a.capital[t]!;
      if (own === 0 && got === 0) continue;
      ticks++;
      assert.ok(near(a.ownSize[t]!, own), `${what} ${a.label} t=${t}: own size ${a.ownSize[t]} vs ${own} without labels`);
      assert.ok(got <= own + 1e-6, `${what} ${a.label} t=${t}: ${got} is above what its own rules give it (${own})`);
      const oneCap = cf * a.fullSize[t]!;
      assert.ok(got >= Math.min(own, oneCap) - 1e-6, `${what} ${a.label} t=${t}: ${got} is below min(own ${own}, one cap ${oneCap})`);
      if (got < own - 1e-6) binding++;
    }
  }
  return { ticks, binding };
}

/* ------------------------------------------------------------------ */
/* 3. The loop-4 review's counterexample, on a book                   */
/* ------------------------------------------------------------------ */

/** base ± amp, alternating: a low-vol record, so every rung is at its fixed floor. */
const alt = (t: number, base: number, amp: number) => base + (t % 2 === 0 ? amp : -amp);
const loser = (at: number) => (t: number) => (t < at ? alt(t, 0.003, 0.002) : t === at ? -0.25 : -0.02);
/** Capped at 12 (by a sibling), a new high at 15 (the cap lifts), a dip at 20, cut by its own ladder at 22. */
const liftThenCut = (t: number) =>
  t < 12 ? alt(t, 0.003, 0.002) : t === 12 ? -0.01 : t === 15 ? 0.02 : t === 20 ? -0.005 : t === 22 ? -0.11 : 0;

const SCRIPTED: Roster[] = [
  // mallory runs three names: two losers, stopped at 12 and 20. x is capped
  // at 12, lifted at 15, capped AGAIN at 20 and cut by its own ladder at 22.
  { label: "m1", operator: "mallory", script: loser(12) },
  { label: "m2", operator: "mallory", script: loser(20) },
  { label: "x", operator: "mallory", script: liftThenCut },
  // trent: y is capped at 12, lifted at 15 and cut by its own ladder at 22, with no re-cap.
  { label: "t1", operator: "trent", script: loser(12) },
  { label: "y", operator: "trent", script: liftThenCut },
  // ursula: w is cut at 5 and restored at 6 (still at half size), capped at
  // 12, and cut by its own ladder again at 22.
  { label: "u1", operator: "ursula", script: loser(12) },
  {
    label: "w",
    operator: "ursula",
    script: (t) => (t <= 4 ? alt(t, 0.01, 0.002) : t === 5 ? -0.12 : t === 6 ? 0.08 : t === 22 ? -0.08 : 0.001),
  },
  { label: "bystander", script: (t) => alt(t, 0.002, 0.001) },
];

test("book: capped, lifted, capped again, then cut by its own ladder — the same as without labels (loop 4's counterexample)", async () => {
  // Every event lands before the first reallocation (t = 30), so every full
  // size is the equal initial allocation.
  const T = 30;
  const policy = defaultCenterBookPolicy();
  const cf = policy.cutFactor!;
  const market = scriptedMarket(SCRIPTED, T, 5);
  const nameOf = (label: string) => `${label}.${podOf(SCRIPTED.findIndex((r) => r.label === label))}.${FUND}`;
  const run = async (labelled: boolean) => {
    // Agent budgets (USDC) at the start of each tick, and after the last.
    const at: Map<string, number>[] = [];
    const snap = (tree: BookResult["tree"]) =>
      new Map(SCRIPTED.map((r) => [r.label, Number(tree.requireNode(nameOf(r.label)).mandate.budget) / 1e6]));
    const book = await runBook(market, spec(SCRIPTED, labelled), policy, { onTick: (t, tree) => void (at[t] = snap(tree)) });
    at.push(snap(book.tree));
    return { book, at };
  };
  const lab = await run(true);
  const blind = await run(false);
  const perAgent = (10_000_000 * policy.deploy) / SCRIPTED.length;
  /** Budget at the end of tick t. */
  const end = (r: typeof lab, t: number, label: string) => r.at[t + 1]!.get(label)!;
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-6, `${what}: ${a} vs ${b}`);
  const moves = (kind: string) => lab.book.decisions.filter((d) => d.kind === kind).map((d) => `${d.t} ${d.node.split(".")[0]}`);

  // The script plays out.
  assert.deepEqual(moves("STOP_OUT"), ["12 m1", "12 t1", "12 u1", "20 m2"]);
  assert.deepEqual(moves("CUT"), ["5 w", "22 x", "22 y", "22 w"]);
  assert.deepEqual(moves("OPERATOR_CUT"), ["12 m2", "12 x", "12 y", "12 w", "20 x"]);
  // m2 is still making new highs when capped (its cap lifts at once); x and y lift at 15.
  assert.deepEqual(moves("OPERATOR_RESTORE"), ["13 m2", "15 x", "15 y"]);
  assert.deepEqual(moves("REALLOCATE"), [], "no reallocation before t = 30");

  // x (the review's case): capped, lifted, capped again, then cut by its own
  // ladder. It holds cutFactor × its full size, as it does without labels,
  // not cutFactor² (loop 4's candidate: 25%).
  near(end(lab, 20, "x"), cf * perAgent, "x capped again at 20");
  near(end(lab, 22, "x"), cf * perAgent, "x after its own ladder cut");
  near(end(blind, 22, "x"), cf * perAgent, "x without labels");
  assert.match(lab.book.decisions.find((d) => d.t === 22 && d.kind === "CUT" && d.node === nameOf("x"))!.detail, /not cut again/);
  // y: lifted and not yet re-sized, then cut by its own ladder: cutFactor, not cutFactor² (loop 3).
  near(end(lab, 22, "y"), cf * perAgent, "y after its own ladder cut");
  near(end(blind, 22, "y"), cf * perAgent, "y without labels");
  // w: its own ladder cut it twice (at 5 and 22), and the cap in between cut
  // nothing. It holds cutFactor², as it does without labels (loop 3 left it
  // at cutFactor: twice what its own ladder allows).
  near(end(lab, 12, "w"), cf * perAgent, "w was not cut by the cap");
  near(end(lab, 22, "w"), cf * cf * perAgent, "w cut again by its own ladder");
  near(end(blind, 22, "w"), cf * cf * perAgent, "w without labels");

  // Every name (a closed one holds 0 in both), at the start of every tick and
  // at the end: min(without labels, one cap) ≤ budget ≤ without labels.
  for (let t = 0; t <= T; t++) {
    for (const { label } of SCRIPTED) {
      const without = blind.at[t]!.get(label)!;
      const got = lab.at[t]!.get(label)!;
      assert.ok(got <= without + 1e-6, `${label} at t=${t}: ${got} above ${without}`);
      assert.ok(got >= Math.min(without, cf * perAgent) - 1e-6, `${label} at t=${t}: ${got} below min(${without}, ${cf * perAgent})`);
    }
  }
  // And as the book records it: own size = the budget without labels, every tick.
  assert.ok(checkAgainstBlind(lab.book, blind.book, "scripted", cf).binding > 0, "the cap binds somewhere");
});

/* ------------------------------------------------------------------ */
/* 4. Random books against the same books without labels              */
/* ------------------------------------------------------------------ */

/**
 * A random book: 3 operators running 1–5 names each (the first operator's
 * count cycles through 1..5 with the seed), 1–2 unlabelled names, and an
 * anchor. Each name's record is a regime-switching script (rallies, slides,
 * flat spells, gaps down, rebounds), so names are cut, restored, stopped and
 * make new highs, and are capped, lifted and capped again, in every order.
 * Crowding is out of reach (each name holds its own instrument, and the crowd
 * and book limits are lifted) and the anchor's first-day gain keeps NAV above
 * AUM in both books, so the allocator deploys the same capital with and
 * without labels. The two books then differ ONLY by the operator labels: the
 * unlabelled book IS each name's own rules alone.
 */
function randomBook(seed: number): { roster: Roster[]; market: Market } {
  const u = mulberry32(seed * 7919 + 1);
  const z = gaussian(u);
  const sizes = [1 + (seed % 5), 1 + Math.floor(u() * 5), 1 + Math.floor(u() * 5)];
  const T = 140;
  const script = (): ((t: number) => number) => {
    const vol = 0.5 + 1.5 * u();
    const path: number[] = [];
    let regime = u() < 0.5 ? "up" : "flat";
    for (let t = 0; t < T; t++) {
      if (u() < 0.08) regime = ["up", "flat", "down"][Math.floor(u() * 3)]!;
      let r = regime === "up" ? 0.004 : regime === "down" ? -0.006 : 0;
      r += 0.003 * vol * z();
      if (u() < 0.03) r -= 0.06 + 0.19 * u();
      else if (u() < 0.04) r += 0.03 + 0.07 * u();
      path.push(Math.max(r, -0.9));
    }
    return (t) => path[t]!;
  };
  const roster: Roster[] = [];
  sizes.forEach((k, o) => {
    for (let i = 0; i < k; i++) roster.push({ label: `o${o}n${i}`, operator: `op-${o}`, script: script() });
  });
  for (let i = 0; i < 1 + Math.floor(u() * 2); i++) roster.push({ label: `anon${i}`, script: script() });
  roster.push({ label: "anchor", script: (t) => (t === 0 ? 20 : 0.0005 + 0.0005 * Math.sin(t)) });
  return { roster, market: scriptedMarket(roster, T, seed) };
}

test("books: random records, 1–5 names per operator — own size = the book without labels, min(own, one cap) ≤ budget ≤ own, every tick", async () => {
  const policy: CenterBookPolicy = { ...defaultCenterBookPolicy(), crowdMaxShare: 100, bookMaxShare: 100 };
  const cf = policy.cutFactor!;
  const cover = {
    books: 0,
    ticks: 0,
    binding: 0,
    recapsAfterLift: 0,
    recapsBeforeResize: 0,
    cutsBeforeResize: 0,
    cutsWhileHeld: 0,
    heldReallocations: 0,
    releases: 0,
    bySize: [0, 0, 0, 0, 0, 0],
  };
  const ladderMoves = (b: BookResult) =>
    b.decisions.filter((d) => ["CUT", "RESTORE", "STOP_OUT"].includes(d.kind)).map((d) => `${d.t} ${d.kind} ${d.node}`);
  for (let seed = 1; seed <= 40; seed++) {
    const { roster, market } = randomBook(seed);
    const lab = await runBook(market, spec(roster, true), policy);
    const blind = await runBook(market, spec(roster, false), policy);
    const seen = checkAgainstBlind(lab, blind, `seed ${seed}`, cf);
    assert.deepEqual(ladderMoves(lab), ladderMoves(blind), `seed ${seed}: the labels move no ladder`);
    cover.books++;
    cover.ticks += seen.ticks;
    cover.binding += seen.binding;
    for (const op of new Set(roster.flatMap((r) => (r.operator === undefined ? [] : [r.operator])))) {
      cover.bySize[roster.filter((r) => r.operator === op).length]!++;
    }
    // Which paths this book exercised, from its decision log.
    const log = lab.decisions;
    const capsOf = new Map<string, number[]>();
    for (const d of log) if (d.kind === "OPERATOR_CUT") capsOf.set(d.node, [...(capsOf.get(d.node) ?? []), d.t]);
    for (const [node, ts] of capsOf) {
      if (ts.length > 1 && log.some((d) => d.kind === "OPERATOR_RESTORE" && d.node === node && d.t > ts[0]!)) cover.recapsAfterLift++;
    }
    cover.cutsWhileHeld += log.filter((d) => d.kind === "CUT" && /under its operator's ceiling/.test(d.detail)).length;
    cover.heldReallocations += log.filter((d) => d.kind === "REALLOCATE" && /under its operator's cap/.test(d.detail)).length;
    cover.releases += log.filter((d) => d.kind === "REALLOCATE" && /cap has lifted/.test(d.detail)).length;
    // The two paths that broke loops 3 and 4: after a lift and before the next
    // reallocation re-sizes the name, a re-cap, or a cut by its own ladder.
    for (const lift of log.filter((d) => d.kind === "OPERATOR_RESTORE")) {
      let next = lift.t + 1;
      while (next < policy.warmup || (next - policy.warmup) % policy.rebalanceEvery !== 0) next++;
      const within = (kind: string) => log.some((d) => d.kind === kind && d.node === lift.node && d.t > lift.t && d.t < next);
      if (within("OPERATOR_CUT")) cover.recapsBeforeResize++;
      if (within("CUT")) cover.cutsBeforeResize++;
    }
  }
  for (let k = 1; k <= 5; k++) assert.ok(cover.bySize[k]! >= 5, `operators with ${k} names: ${JSON.stringify(cover)}`);
  const paths = ["binding", "recapsAfterLift", "recapsBeforeResize", "cutsBeforeResize", "cutsWhileHeld", "heldReallocations", "releases"] as const;
  for (const key of paths) {
    assert.ok(cover[key] >= 5, `${key}: ${JSON.stringify(cover)}`);
  }
});
