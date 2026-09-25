/**
 * (G) One operator, one counterparty: a stop-out of one of an operator's names
 * caps its other live names as a group, in one tree plan, at cutFactor of
 * their FULL SIZE. Checked on a scripted market where every agent's record is
 * written tick by tick, so each case the guarantee must survive happens on a
 * known tick:
 *
 *  - a name the ladder cut and restored, still holding half its capital when
 *    its operator's other name is stopped (loop 2's failure: halved again);
 *  - a name the ladder holds cut through the event and the next reallocation
 *    (the two cuts must not multiply);
 *  - a name capped while healthy that its own ladder then cuts (not again);
 *  - a second stop-out of the same operator while names are still capped;
 *  - lifting on a new high, and with the name's own ladder lifting its cut.
 *
 * Together they fail if the cap re-cuts a name already at the ceiling (or
 * decides that on ladder state), multiplies the ladder's and the operator's
 * factors at a reallocation, lets the ladder's own cut halve a capped name
 * again, ignores the cap at a reallocation, never lifts it on the name's own
 * recovery, splits the group into several plans, revokes a name, or moves
 * anyone's ladder (each was run as a mutation against them).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCenterBookPolicy, ladderStep, type LadderState } from "./allocator";
import { runBook, type BookResult, type SwarmSpec } from "./book";
import { generateMarket, type Market } from "./market";
import { isNewHigh } from "./stats";
import type { Strategy, Weights } from "./strategies";

const FUND = "fund.eth";
const policy = defaultCenterBookPolicy();
const CF = policy.cutFactor!;
const T = 50;

/** base ± amp, alternating: a low-vol record, so every rung is at its fixed floor. */
const alt = (t: number, base: number, amp: number) => base + (t % 2 === 0 ? amp : -amp);

/**
 * Each agent holds one instrument, long 0.5 at leverage 2: its record IS the
 * instrument's return, scripted here. Scripting the market (not the agents)
 * keeps every agent point-in-time.
 */
const SCRIPTS: Record<string, (t: number) => number> = {
  // mallory's loser: stopped out at t = 20 (the first credit event).
  L: (t) => (t < 20 ? alt(t, 0.003, 0.002) : t === 20 ? -0.25 : -0.02),
  // mallory's healthy name: at its high at t = 20, flat until a new high at t = 34.
  F: (t) => (t <= 20 ? alt(t, 0.003, 0.002) : t < 34 ? 0 : t === 34 ? 0.005 : alt(t, 0.003, 0.002)),
  // Cut by its ladder at t = 5, restored at t = 6: still at half capital at t = 20.
  BO: (t) => (t <= 4 ? alt(t, 0.01, 0.002) : t === 5 ? -0.12 : t === 6 ? 0.08 : 0.001),
  // Cut by its ladder at t = 15 and held there; stopped at t = 40 (the second event).
  HC: (t) => (t <= 14 ? alt(t, 0.02, 0.002) : t === 15 ? -0.12 : t < 40 ? 0.001 : t === 40 ? -0.15 : -0.01),
  // Cut at t = 10, still cut at t = 20; its own ladder restores it at t = 26.
  RC: (t) => (t <= 9 ? alt(t, 0.01, 0.002) : t === 10 ? -0.11 : t < 26 ? 0 : t === 26 ? 0.07 : 0.001),
  // Healthy at t = 20 (capped), then cut by its own ladder at t = 25 while capped.
  CC: (t) => (t <= 20 ? alt(t, 0.01, 0.002) : t < 25 ? 0 : t === 25 ? -0.11 : 0),
  // op-s runs one name: stopped at t = 12, caps no one.
  SO: (t) => (t < 12 ? alt(t, 0.003, 0.002) : t === 12 ? -0.25 : 0),
  // No operator: stopped at t = 25, caps no one.
  AN: (t) => (t < 25 ? alt(t, 0.003, 0.002) : t === 25 ? -0.25 : 0),
  // op-b's only name: never touched.
  BY: (t) => alt(t, 0.002, 0.001),
};
const INSTRUMENTS = Object.keys(SCRIPTS);

function scriptedMarket(): Market {
  const m = generateMarket({
    seed: 11,
    ticks: T,
    instruments: INSTRUMENTS,
    factorVol: 0.008,
    idioVol: 0.01,
    // No crowd in this market.
    crowd: { instrument: "BY", startTick: 10_000, crashTick: 10_001, inflowDrift: 0, crashSize: 0, contagion: 0 },
  });
  for (const tick of m.ticks) for (const s of INSTRUMENTS) tick.returns[s] = SCRIPTS[s]!(tick.t);
  return m;
}
const market = scriptedMarket();

class Hold implements Strategy {
  readonly style = "hold";
  constructor(private readonly instrument: string) {}
  decide(): Weights {
    return { [this.instrument]: 0.5 };
  }
}

const ROSTER: [label: string, instrument: string, pod: string, operator?: string][] = [
  ["loser", "L", "alpha", "mallory"],
  ["full", "F", "alpha", "mallory"],
  ["bounced", "BO", "beta", "mallory"],
  ["heldcut", "HC", "beta", "mallory"],
  ["recovers", "RC", "alpha", "mallory"],
  ["capcut", "CC", "alpha", "mallory"],
  ["solo", "SO", "beta", "op-s"],
  ["anon", "AN", "alpha"],
  ["bystander", "BY", "beta", "op-b"],
];

function swarm(labelled: boolean): SwarmSpec {
  return {
    principal: "alice",
    fund: FUND,
    aum: 10_000_000,
    pods: [
      { label: "alpha", instruments: INSTRUMENTS },
      { label: "beta", instruments: INSTRUMENTS },
    ],
    agents: ROSTER.map(([label, instrument, pod, operator]) => ({
      label,
      pod,
      ...(labelled && operator ? { operator } : {}),
      instruments: INSTRUMENTS,
      strategy: new Hold(instrument),
    })),
  };
}

const nameOf = (label: string) => {
  const [, , pod] = ROSTER.find(([l]) => l === label)!;
  return `${label}.${pod}.${FUND}`;
};

/** Each agent's ladder state after every tick, from ITS OWN record alone: no book, no capital, no siblings. */
function ownLadder(unitReturns: readonly number[]): LadderState[] {
  let state: LadderState = "active";
  return unitReturns.map((_, t) => {
    state = ladderStep(state, unitReturns.slice(0, t + 1), {
      ddStop: policy.ddStop,
      ddCut: policy.ddCut,
      ddRecover: policy.ddRecover,
      ddStopVol: policy.ddStopVol,
      volWindow: policy.window,
      ddStopMax: policy.ddStopMax,
    }).next;
    return state;
  });
}

interface Run {
  book: BookResult;
  /** Agent budgets (USDC) at the start of each tick, before it acts: [t][label]. */
  budgets: Map<string, number>[];
  /** Agents whose mandate is dead at the start of each tick. */
  revoked: Set<string>[];
  /** Tree event count at the start of each tick. */
  seq: number[];
}

async function run(labelled: boolean): Promise<Run> {
  const budgets: Map<string, number>[] = [];
  const revoked: Set<string>[] = [];
  const seq: number[] = [];
  const book = await runBook(market, swarm(labelled), policy, {
    onTick: (t, tree) => {
      seq[t] = tree.events.length;
      budgets[t] = new Map(ROSTER.map(([l]) => [l, Number(tree.requireNode(nameOf(l)).mandate.budget) / 1e6]));
      revoked[t] = new Set(ROSTER.map(([l]) => l).filter((l) => tree.isRevokedInChain(nameOf(l))));
    },
  });
  return { book, budgets, revoked, seq };
}

const labelledRun = run(true);
const blindRun = run(false);
const agent = (r: Run, label: string) => r.book.agents.find((a) => a.label === label)!;
/** Budget at the end of tick t (= the start of t + 1). */
const endOf = (r: Run, t: number, label: string) => r.budgets[t + 1]!.get(label)!;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const decisionsAt = (r: Run, t: number, kind: string) =>
  r.book.decisions.filter((d) => d.t === t && d.kind === kind).map((d) => d.node);

test("the script plays out: each name's ladder moves on the tick its own record says", async () => {
  const { book } = await labelledRun;
  const transitions = (kind: string) => book.decisions.filter((d) => d.kind === kind).map((d) => [d.t, d.node]);
  assert.deepEqual(transitions("STOP_OUT"), [
    [12, nameOf("solo")],
    [20, nameOf("loser")],
    [25, nameOf("anon")],
    [40, nameOf("heldcut")],
  ]);
  assert.deepEqual(transitions("CUT"), [
    [5, nameOf("bounced")],
    [10, nameOf("recovers")],
    [15, nameOf("heldcut")],
    [25, nameOf("capcut")],
  ]);
  assert.deepEqual(transitions("RESTORE"), [
    [6, nameOf("bounced")],
    [26, nameOf("recovers")],
  ]);
  assert.deepEqual(book.decisions.filter((d) => d.kind === "CROWDING_CUT"), [], "no crowding cut muddies the capital checks");
});

test("no stop-out (or any ladder move) is delayed or advanced: every one is the agent's own record replayed alone", async () => {
  const lab = await labelledRun;
  const blind = await blindRun;
  const moves = (b: BookResult) =>
    b.decisions.filter((d) => d.kind === "STOP_OUT" || d.kind === "CUT" || d.kind === "RESTORE").map((d) => `${d.t} ${d.kind} ${d.node}`);
  assert.deepEqual(moves(lab.book), moves(blind.book), "operator labels move no ladder");
  const own: string[] = [];
  for (const a of lab.book.agents) {
    assert.deepEqual(a.unitReturns, agent(blind, a.label).unitReturns, "records never depend on capital");
    const states = ownLadder(a.unitReturns);
    states.forEach((s, t) => {
      const prev = t === 0 ? "active" : states[t - 1]!;
      if (s === prev) return;
      own.push(`${t} ${s === "stopped" ? "STOP_OUT" : s === "cut" ? "CUT" : "RESTORE"} ${a.name}`);
    });
    assert.equal(a.ladder, states.at(-1), `${a.label}: final ladder state is its own`);
  }
  const byTick = (xs: string[]) => [...xs].sort((x, y) => Number(x.split(" ")[0]) - Number(y.split(" ")[0]) || x.localeCompare(y));
  assert.deepEqual(byTick(moves(lab.book)), byTick(own));
});

test("revoked iff stopped by its own record, at every tick: an operator cap never revokes anyone", async () => {
  for (const r of [await labelledRun, await blindRun]) {
    const stopAt = new Map(
      r.book.agents.map((a) => [a.label, ownLadder(a.unitReturns).indexOf("stopped")] as const).filter(([, t]) => t >= 0),
    );
    for (let t = 0; t < T; t++) {
      const expected = [...stopAt].filter(([, s]) => s < t).map(([l]) => l).sort();
      assert.deepEqual([...r.revoked[t]!].sort(), expected, `t=${t}`);
    }
    for (const a of r.book.agents) {
      assert.equal(r.book.tree.isRevokedInChain(a.name), a.ladder === "stopped", `${a.label} at the end`);
    }
  }
});

test("first credit event: the operator's other names are capped as a group, cut on capital, in one tree plan", async () => {
  const lab = await labelledRun;
  const blind = await blindRun;
  // Dormant until the credit event: the two books are the same book.
  assert.deepEqual(lab.book.nav.slice(0, 20), blind.book.nav.slice(0, 20));
  assert.deepEqual(lab.budgets.slice(0, 21), blind.budgets.slice(0, 21));
  // Before the first reallocation the full size is the equal initial allocation.
  const perAgent = (10_000_000 * policy.deploy) / ROSTER.length;
  const capped = ["full", "bounced", "heldcut", "recovers", "capcut"];
  for (const l of capped) assert.equal(agent(lab, l).fullSize[20], perAgent);
  assert.equal(agent(lab, "solo").fullSize[20], 0, "a closed mandate has no full size");

  assert.deepEqual(decisionsAt(lab, 20, "OPERATOR_CUT"), capped.map(nameOf), "every other live mallory name, in both pods");
  assert.deepEqual(decisionsAt(lab, 12, "OPERATOR_CUT"), [], "solo's operator runs no other name");
  assert.deepEqual(decisionsAt(lab, 25, "OPERATOR_CUT"), [], "anon has no operator");

  // Healthy names at full size are cut to cutFactor of it...
  for (const l of ["full", "capcut"]) near(endOf(lab, 20, l), CF * perAgent, `${l} capped`);
  // ...names already at the ceiling are NOT cut again: the one its ladder cut and
  // restored (still at half capital), and the two its ladder holds cut.
  for (const l of ["bounced", "heldcut", "recovers"]) {
    near(endOf(lab, 19, l), CF * perAgent, `${l} was already at the cut size`);
    assert.equal(endOf(lab, 20, l), endOf(lab, 19, l), `${l} halved again`);
    assert.equal(endOf(lab, 20, l), endOf(blind, 20, l));
  }
  for (const l of ["solo", "anon", "bystander"]) assert.equal(endOf(lab, 20, l), endOf(blind, 20, l), `${l} untouched`);
  const detail = (l: string) => lab.book.decisions.find((d) => d.t === 20 && d.kind === "OPERATOR_CUT" && d.node === nameOf(l))!.detail;
  assert.match(detail("bounced"), /not cut again/);
  assert.match(detail("full"), /→/);

  // ONE plan: after the loser's close (its REVOKE), the tick's remaining tree
  // writes are exactly the capped names that needed a cut, then the pods.
  const events = lab.book.tree.events.slice(lab.seq[20], lab.seq[21]);
  const revoke = events.findIndex((e) => e.type === "REVOKE" && e.node === nameOf("loser"));
  const after = events.slice(revoke + 1);
  assert.deepEqual(
    after.slice(0, 2).map((e) => [e.type, e.result, e.node]),
    ["full", "capcut"].map((l) => ["RESIZE", "OK", nameOf(l)]),
  );
  assert.ok(after.length > 2);
  for (const e of after.slice(2)) {
    assert.equal(e.type, "RESIZE");
    assert.equal(lab.book.tree.requireNode(e.node).parent, FUND, `${e.node}: only pods follow the group`);
  }
});

test("a ladder cut on a name its operator already capped does not cut it again", async () => {
  const lab = await labelledRun;
  const blind = await blindRun;
  const cut = lab.book.decisions.find((d) => d.t === 25 && d.kind === "CUT" && d.node === nameOf("capcut"))!;
  assert.match(cut.detail, /not cut again/);
  assert.equal(endOf(lab, 25, "capcut"), endOf(lab, 24, "capcut"), "capcut halved again by its own ladder");
  // Unlabelled, the same record is cut by the ladder as usual.
  near(endOf(blind, 25, "capcut"), CF * endOf(blind, 24, "capcut"), "blind ladder cut");
});

test("at a reallocation, capped names are sized at cutFactor of full size — once, even when their ladder also cuts them", async () => {
  const lab = await labelledRun;
  const band = policy.rebalanceBand;
  const t = policy.warmup; // the first reallocation
  for (const l of ["full", "bounced", "heldcut", "capcut"]) {
    const a = agent(lab, l);
    assert.ok(a.fullSize[t]! > 0, `${l} has a full size to be capped at`);
    const ratio = a.capital[t]! / (CF * a.fullSize[t]!);
    // Within the rebalance band of cutFactor × full size (never cutFactor²).
    assert.ok(ratio > 1 - band - 1e-9 && ratio < 1 / (1 - band) + 1e-9, `${l} at t=${t}: ${ratio.toFixed(3)} × the cap`);
  }
  // Both the ladder and the operator cap hold heldcut and capcut, and both were moved at t = 30.
  for (const l of ["heldcut", "capcut"]) {
    assert.ok(decisionsAt(lab, t, "REALLOCATE").includes(nameOf(l)), `${l} was resized at t=${t}`);
    near(agent(lab, l).capital[t]!, CF * agent(lab, l).fullSize[t]!, `${l}: cutFactor once`);
  }
  // recovers' own ladder lifted its cut at t = 26, and the cap with it: full size at t = 30.
  assert.deepEqual(decisionsAt(lab, 26, "OPERATOR_RESTORE"), [nameOf("recovers")]);
  const rc = agent(lab, "recovers");
  assert.ok(Math.abs(rc.capital[t]! / rc.fullSize[t]! - 1) < band, `recovers back at full size: ${rc.capital[t]} vs ${rc.fullSize[t]}`);
});

test("a cap lifts on the name's first new high on its own record, and not before", async () => {
  const lab = await labelledRun;
  const full = agent(lab, "full");
  assert.deepEqual(
    lab.book.decisions.filter((d) => d.kind === "OPERATOR_RESTORE" && d.node === full.name && d.t < 40).map((d) => d.t),
    [34],
  );
  for (let t = 21; t < 34; t++) assert.ok(!isNewHigh(full.unitReturns.slice(0, t + 1)), `no new high at t=${t}`);
  assert.ok(isNewHigh(full.unitReturns.slice(0, 35)));
  const ratio = full.capital[35]! / full.fullSize[35]!;
  assert.ok(Math.abs(ratio - 1) < policy.rebalanceBand, `full size again at the next reallocation: ${ratio}`);
});

test("second credit event: names still capped are left alone; lifted ones are capped again", async () => {
  const lab = await labelledRun;
  assert.deepEqual(decisionsAt(lab, 40, "OPERATOR_CUT"), ["full", "recovers"].map(nameOf));
  for (const l of ["full", "recovers"]) near(endOf(lab, 40, l), CF * agent(lab, l).fullSize[40]!, `${l} capped again`);
  const events = lab.book.tree.events.slice(lab.seq[40], lab.seq[41]);
  const revoke = events.findIndex((e) => e.type === "REVOKE" && e.node === nameOf("heldcut"));
  assert.deepEqual(
    events.slice(revoke + 1, revoke + 3).map((e) => [e.type, e.node]),
    ["full", "recovers"].map((l) => ["RESIZE", nameOf(l)]),
  );
  // bounced and capcut, still capped since t = 20, are not written by the event:
  // an earlier operator cap is not compounded.
  for (const l of ["bounced", "capcut"]) {
    assert.ok(!events.slice(revoke + 1).some((e) => e.node === nameOf(l)), `${l} cut again`);
    const a = agent(lab, l);
    assert.ok(endOf(lab, 40, l) >= CF * a.fullSize[40]! * (1 - policy.rebalanceBand), `${l} below the cap`);
  }
});

test("the tree stays sound through every group cut", async () => {
  const { book } = await labelledRun;
  assert.deepEqual(book.tree.audit(), []);
  assert.ok(!book.tree.events.some((e) => e.result === "ATTENUATION_REJECTED"));
  assert.equal(book.tree.requireNode(FUND).mandate.budget, 10_000_000_000000n);
});
