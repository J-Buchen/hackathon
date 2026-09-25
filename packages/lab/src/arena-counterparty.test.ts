/**
 * (G) on randomized arena rosters: every world on research seeds 1–40 where
 * one operator runs two names. Each is run twice on the same market — with
 * the operator labels, and blind (labels stripped) — and checked tick by tick:
 *
 *  - every ladder move (CUT, RESTORE, STOP_OUT) is the agent's own record
 *    replayed alone, the same with and without labels: no stop-out is ever
 *    delayed or brought forward by an operator;
 *  - revoked iff stopped: at the start of every tick, the dead mandates are
 *    exactly the agents whose own record has stopped them out (an operator cap
 *    never revokes anyone), and the same at the end;
 *  - every operator cut follows a stop-out of another name of the same
 *    operator on that tick, and at the first one in each world every name
 *    ends the tick at min(what it holds without labels, cutFactor × full
 *    size): a name already at or below the ceiling is not cut again;
 *  - at every reallocation while a name is capped, it runs no more than
 *    cutFactor × its full size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CEILING_SLACK, defaultCenterBookPolicy, ladderStep, runBook, type BookResult, type LadderState } from "@allowance/swarm";
import { makeWorld } from "./arena";

// Research seeds only (< ARENA_EVAL_FLOOR).
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const policy = defaultCenterBookPolicy();
const CF = policy.cutFactor!;

interface Watched {
  book: BookResult;
  /** Dead agent mandates at the start of each tick. */
  revoked: string[][];
  /** Agent budgets (USDC) at the start of each tick. */
  budgets: Map<string, number>[];
}

async function watched(world: ReturnType<typeof makeWorld>, labelled: boolean): Promise<Watched> {
  const spec = world.swarm();
  if (!labelled) for (const a of spec.agents) delete a.operator;
  const names = spec.agents.map((a) => `${a.label}.${a.pod}.${spec.fund}`);
  const revoked: string[][] = [];
  const budgets: Map<string, number>[] = [];
  const book = await runBook(world.market, spec, policy, {
    onTick: (t, tree) => {
      revoked[t] = names.filter((n) => tree.isRevokedInChain(n));
      budgets[t] = new Map(names.map((n) => [n, Number(tree.requireNode(n).mandate.budget) / 1e6]));
    },
  });
  // The end of the last tick, as if a tick followed it.
  revoked.push(names.filter((n) => book.tree.isRevokedInChain(n)));
  budgets.push(new Map(names.map((n) => [n, Number(book.tree.requireNode(n).mandate.budget) / 1e6])));
  return { book, revoked, budgets };
}

/** The ladder moves of one record, replayed alone: `${t} ${kind}` per transition. */
function ownMoves(unitReturns: readonly number[]): { moves: string[]; stopAt: number } {
  let state: LadderState = "active";
  const moves: string[] = [];
  let stopAt = Infinity;
  unitReturns.forEach((_, t) => {
    const next = ladderStep(state, unitReturns.slice(0, t + 1), {
      ddStop: policy.ddStop,
      ddCut: policy.ddCut,
      ddRecover: policy.ddRecover,
      ddStopVol: policy.ddStopVol,
      volWindow: policy.window,
      ddStopMax: policy.ddStopMax,
    }).next;
    if (next !== state) moves.push(`${t} ${next === "stopped" ? "STOP_OUT" : next === "cut" ? "CUT" : "RESTORE"}`);
    if (next === "stopped" && stopAt === Infinity) stopAt = t;
    state = next;
  });
  return { moves, stopAt };
}

const ladderMoves = (b: BookResult, name: string) =>
  b.decisions.filter((d) => d.node === name && (d.kind === "CUT" || d.kind === "RESTORE" || d.kind === "STOP_OUT")).map((d) => `${d.t} ${d.kind}`);

test("arena: operators are cut as a group, on capital, and never revoke or move anyone's own ladder", async () => {
  const seen = { worlds: 0, groupCuts: 0, notCutAgain: 0, firstEventChecks: 0, reallocChecks: 0, ticks: 0 };
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (world.meta.sharedOperators === 0) continue;
    seen.worlds++;
    const lab = await watched(world, true);
    const blind = await watched(world, false);
    const T = lab.book.nav.length;

    // Own ladders, and revoked iff stopped at every tick, in both runs.
    const stopAt = new Map<string, number>();
    for (const a of lab.book.agents) {
      const own = ownMoves(a.unitReturns);
      assert.deepEqual(ladderMoves(lab.book, a.name), own.moves, `seed ${seed} ${a.label}: ladder moved by the book`);
      assert.deepEqual(ladderMoves(blind.book, a.name), own.moves, `seed ${seed} ${a.label}: blind ladder`);
      stopAt.set(a.name, own.stopAt);
    }
    for (const r of [lab, blind]) {
      for (let t = 0; t <= T; t++) {
        seen.ticks++;
        const expected = [...stopAt].filter(([, s]) => s < t).map(([n]) => n).sort();
        assert.deepEqual([...r.revoked[t]!].sort(), expected, `seed ${seed} t=${t}: revoked iff stopped by its own record`);
      }
      assert.deepEqual(r.book.tree.audit(), []);
      assert.ok(!r.book.tree.events.some((e) => e.result === "ATTENUATION_REJECTED"));
    }

    // Every operator cut follows a same-tick stop-out of a sibling.
    const agentOf = new Map(lab.book.agents.map((a) => [a.name, a]));
    const cuts = lab.book.decisions.filter((d) => d.kind === "OPERATOR_CUT");
    for (const cut of cuts) {
      seen.groupCuts++;
      const me = agentOf.get(cut.node)!;
      assert.ok(me.operator !== undefined);
      const cause = lab.book.agents.find((a) => a.name !== me.name && a.operator === me.operator && stopAt.get(a.name) === cut.t);
      assert.ok(cause, `seed ${seed}: ${me.label} capped at ${cut.t} without a stopped sibling`);
      assert.ok(stopAt.get(me.name)! > cut.t, `seed ${seed}: ${me.label} capped when its own record had stopped it`);
      if (/not cut again/.test(cut.detail)) seen.notCutAgain++;
    }

    // The first credit event, exactly: the two runs are one book until then.
    if (cuts.length > 0) {
      const t1 = cuts[0]!.t;
      for (let t = 0; t <= t1; t++) assert.deepEqual(lab.budgets[t], blind.budgets[t], `seed ${seed} t=${t}: dormant until the event`);
      const capped = new Set(cuts.filter((d) => d.t === t1).map((d) => d.node));
      for (const a of lab.book.agents) {
        const without = blind.budgets[t1 + 1]!.get(a.name)!;
        const got = lab.budgets[t1 + 1]!.get(a.name)!;
        if (!capped.has(a.name)) {
          assert.equal(got, without, `seed ${seed} ${a.label}: not capped, not touched`);
          continue;
        }
        seen.firstEventChecks++;
        const ceiling = CF * a.fullSize[t1]!;
        if (without <= ceiling * (1 + CEILING_SLACK)) assert.equal(got, without, `seed ${seed} ${a.label}: at the ceiling already, cut again`);
        else assert.ok(Math.abs(got - ceiling) <= 1e-6, `seed ${seed} ${a.label}: ${got} vs ceiling ${ceiling}`);
      }
    }

    // At every reallocation while capped, the cap binds: the name never runs
    // more than cutFactor × its full size (beyond the rebalance band). (That it
    // runs exactly that — once, not cutFactor² when its ladder also cuts it —
    // is pinned on a scripted book in swarm's counterparty.test.ts: here every
    // capped name that crosses a reallocation also carries a crowding cap.)
    for (const cut of cuts) {
      const me = agentOf.get(cut.node)!;
      const lift = lab.book.decisions.find((d) => d.kind === "OPERATOR_RESTORE" && d.node === me.name && d.t > cut.t)?.t ?? T;
      const end = Math.min(lift, stopAt.get(me.name)!, T - 1);
      for (let t = cut.t + 1; t <= end; t++) {
        if (t < policy.warmup || (t - policy.warmup) % policy.rebalanceEvery !== 0) continue;
        seen.reallocChecks++;
        const cap = CF * me.fullSize[t]!;
        assert.ok(me.capital[t]! <= cap / (1 - policy.rebalanceBand) + 1e-6, `seed ${seed} ${me.label} t=${t}: ${me.capital[t]} vs cap ${cap}`);
      }
    }
  }
  assert.ok(seen.worlds >= 20, `worlds with shared operators: ${seen.worlds}`);
  assert.ok(seen.groupCuts > 0 && seen.firstEventChecks > 0 && seen.reallocChecks > 0, JSON.stringify(seen));
  assert.ok(seen.notCutAgain > 0, `some sibling was already at the ceiling: ${JSON.stringify(seen)}`);
});
