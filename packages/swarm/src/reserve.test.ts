/**
 * (R) The reservation is the binding risk limit. Every agent's notional is
 * sized from its mandate's AVAILABLE authority in the tree (budget − its own
 * spend − what it handed down) × leverage, never from a number the book keeps,
 * and every order is audited against the tree before it is marked.
 *
 * The scenario these tests run is one where the book's own capital number for
 * an agent (its budget) overstates what the agent may trade, while the tree
 * is sound: the agent has handed slices of its budget to desks, pays a vendor
 * out of its own mandate, and is handed an outside sub-mandate mid-run. Sized
 * from its budget (as the book did before), it would trade authority that is
 * reserved for someone else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegationTree, formatAmount, pay, type PaymentAdapters } from "@allowance/core";
import { defaultCenterBookPolicy, defaultNaivePolicy, type AllocationPolicy } from "./allocator";
import { BookInvariantError, runBook, tickToUnix, TRADE_SLACK, tradeViolations, type SwarmSpec } from "./book";
import { grossNotional, orderNotional, orderPnl, sizeOrder, type SizedOrder } from "./gate";
import { generateMarket, genericMarketConfig, type Market } from "./market";
import { HerdStrategy, MeanReversionStrategy, NoiseStrategy, TrendStrategy, type Strategy, type Weights } from "./strategies";

const FUND = "fund.eth";
const usdc = (units: bigint) => Number(formatAmount(units));
const U = 1_000000n; // one USDC in units

/** Always-yes payment ports: these tests are about authority, not the adapters. */
const allowAll: PaymentAdapters = {
  identity: { verify: async () => ({ ok: true }) },
  screening: { screen: async () => ({ approved: true }) },
  settlement: {
    settle: async (req) => ({
      settled: true,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut: req.amount,
    }),
  },
};

/* ------------------------------------------------------------------ */
/* Unit: the gate sizes from the tree                                 */
/* ------------------------------------------------------------------ */

const E = 10_000;
/** fund 1000 → pod 600 → a 300 (desk 100, spent 20 itself) and b 200. */
async function smallTree() {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: FUND, mandate: { budget: 1_000n * U, allowedMerchants: ["X", "Y", "Z"], expiry: E } });
  tree.delegate(FUND, "pod", { budget: 600n * U, allowedMerchants: ["X", "Y", "Z"], expiry: E });
  const POD = `pod.${FUND}`;
  tree.delegate(POD, "a", { budget: 300n * U, allowedMerchants: ["X", "Y"], expiry: E });
  tree.delegate(POD, "b", { budget: 200n * U, allowedMerchants: ["X", "Y"], expiry: E });
  const A = `a.${POD}`;
  const B = `b.${POD}`;
  tree.delegate(A, "desk", { budget: 100n * U, allowedMerchants: ["X"], expiry: E });
  assert.equal((await pay(tree, { node: A, merchant: "X", amount: 20n * U }, allowAll, { now: 1 })).outcome, "SETTLED");
  return { tree, POD, A, B };
}

test("sizeOrder: notional is the AVAILABLE authority × leverage — a desk's slice and the agent's own spend are not trading capital", async () => {
  const { tree, POD, A, B } = await smallTree();
  const w: Weights = { X: 0.5, Y: -0.5 };
  const o = sizeOrder(tree, A, w, { leverage: 2, now: 1 });
  // Budget 300, spent 20, handed down 100: 180 is what a may still put at risk.
  assert.equal(o.authority, 180);
  assert.deepEqual(orderNotional(o), { X: 180, Y: -180 });
  assert.equal(grossNotional(o), 360, "= available × leverage, not budget × leverage (600)");
  assert.ok(Math.abs(orderPnl(o, { X: 0.01, Y: -0.02 }) - 180 * 2 * (0.5 * 0.01 + 0.5 * 0.02)) < 1e-12);
  w.X = 5;
  assert.equal(o.weights.X, 0.5, "the order holds its own copy of the weights");
  // A sibling with nothing handed down trades its whole budget.
  assert.equal(sizeOrder(tree, B, { X: 1 }, { leverage: 2, now: 1 }).authority, 200);

  // Dead mandates are sized at zero with no weights: expired…
  assert.deepEqual(sizeOrder(tree, A, { X: 1 }, { leverage: 2, now: E + 1 }), { node: A, authority: 0, leverage: 2, weights: {} });
  // …closed…
  tree.close(A);
  assert.deepEqual(sizeOrder(tree, A, { X: 1 }, { leverage: 2, now: 1 }), { node: A, authority: 0, leverage: 2, weights: {} });
  assert.equal(sizeOrder(tree, B, { X: 1 }, { leverage: 2, now: 1 }).authority, 200);
  // …or under a closed ancestor.
  tree.close(POD);
  assert.equal(sizeOrder(tree, B, { X: 1 }, { leverage: 2, now: 1 }).authority, 0);
});

test("tradeViolations: an order sized from any number but the tree's available authority is named, and nothing else is", async () => {
  const { tree, A, B } = await smallTree();
  const opts = { leverage: 2, now: 1 };
  const a = sizeOrder(tree, A, { X: 0.5, Y: -0.5 }, opts);
  const b = sizeOrder(tree, B, { X: 1 }, opts);
  assert.deepEqual(tradeViolations(tree, [a, b], opts), [], "orders sized from the tree are sound");

  // a sized from its BUDGET (the book's own capital number before this change): named, b is not.
  assert.deepEqual(tradeViolations(tree, [{ ...a, authority: 300 }, b], opts), [
    `OVER_RESERVATION ${A}: gross notional 600.00 > available 180.00 × leverage 2`,
  ]);
  // Inflated by 1.5× for one agent, or run at more than the policy's leverage.
  assert.deepEqual(
    tradeViolations(tree, [a, { ...b, authority: 300 }], opts).map((v) => v.split(":")[0]),
    [`OVER_RESERVATION ${B}`],
  );
  assert.deepEqual(
    tradeViolations(tree, [{ ...a, leverage: 3 }, b], opts).map((v) => v.split(":")[0]),
    [`OVER_RESERVATION ${A}`],
  );
  // The bound is tight: exactly at it passes, past the slack fails.
  assert.deepEqual(tradeViolations(tree, [{ ...a, weights: { X: 1 } }], opts), []);
  assert.deepEqual(tradeViolations(tree, [{ ...a, weights: { X: 1 + 10 * TRADE_SLACK } }], opts).length, 1);
  // Off the allowlist, non-finite, or not a node at all.
  assert.deepEqual(tradeViolations(tree, [{ ...a, weights: { Z: 0.1 } }], opts), [`OFF_MANDATE ${A}: holds Z`]);
  assert.deepEqual(
    tradeViolations(tree, [{ ...a, authority: Number.NaN }], opts).map((v) => v.split(":")[0]),
    [`NOT_FINITE ${A}`],
  );
  assert.deepEqual(tradeViolations(tree, [{ ...a, node: `ghost.${FUND}` }], opts), [`UNKNOWN_NODE ghost.${FUND}: no such mandate`]);

  // A closed agent trades nothing: any notional at all is named…
  tree.close(A);
  assert.deepEqual(
    tradeViolations(tree, [{ ...a, authority: 1 }, b], opts).map((v) => v.split(":")[0]),
    [`DEAD_TRADES ${A}`],
  );
  // …weights on zero authority put nothing on, and the re-sized order is empty.
  assert.deepEqual(tradeViolations(tree, [{ ...a, authority: 0 }], opts), []);
  assert.deepEqual(tradeViolations(tree, [sizeOrder(tree, A, { X: 1 }, opts), b], opts), []);
  // An expired mandate is dead too.
  assert.deepEqual(
    tradeViolations(tree, [b], { ...opts, now: E + 1 }).map((v) => v.split(":")[0]),
    [`DEAD_TRADES ${B}`],
  );
});

/* ------------------------------------------------------------------ */
/* The book: a budget that overstates the agent's authority           */
/* ------------------------------------------------------------------ */

const TURN = 80;
/** The seed-7 generic market, with GOLD scripted to run up until TURN and then slide (a stop-out). */
function scriptedMarket(): Market {
  const m = generateMarket(genericMarketConfig(7));
  m.ticks.forEach((tick, t) => {
    tick.returns.GOLD = t < TURN ? 0.004 + (t % 2 === 0 ? 0.002 : -0.002) : -0.02;
  });
  return m;
}
const market = scriptedMarket();
const T = market.ticks.length;

class LongGold implements Strategy {
  readonly style = "long-gold";
  decide(): Weights {
    return { GOLD: 0.5 };
  }
}

const DESKED = `desked.systematic.${FUND}`;
const DOOMED = `doomed.systematic.${FUND}`;
const PLAIN = `plain.macro.${FUND}`;
const GRANT = 50;

function spec(): SwarmSpec {
  const all = [...market.instruments];
  return {
    principal: "alice",
    fund: FUND,
    aum: 10_000_000,
    pods: [
      { label: "systematic", instruments: all },
      { label: "macro", instruments: all },
    ],
    agents: [
      {
        label: "desked",
        pod: "systematic",
        instruments: all,
        strategy: new TrendStrategy(30),
        subMandates: [
          { label: "exec", share: 0.3 },
          { label: "data", share: 0.02, instruments: ["GOLD"] },
        ],
      },
      { label: "doomed", pod: "systematic", instruments: all, strategy: new LongGold(), subMandates: [{ label: "exec", share: 0.25 }] },
      { label: "plain", pod: "macro", instruments: all, strategy: new MeanReversionStrategy(3) },
      { label: "herd-a", pod: "macro", instruments: all, strategy: new HerdStrategy(20) },
      { label: "herd-b", pod: "systematic", instruments: all, strategy: new HerdStrategy(25) },
      { label: "noise", pod: "macro", instruments: all, strategy: new NoiseStrategy(5) },
    ],
  };
}

/**
 * What happens to the tree outside the book, every tick: the desks pay for
 * execution and data, the desked agent pays a vendor out of its own mandate,
 * and at GRANT its operator hands a vendor a quarter of what it has left (a
 * sub-mandate the book does not manage). All of it goes through the tree's
 * own API, so the tree stays sound; only the agent's budget stops being what
 * it may trade.
 */
async function outside(t: number, tree: DelegationTree): Promise<void> {
  const now = tickToUnix(t);
  const spend = async (node: string, amount: bigint) => {
    if (tree.isRevokedInChain(node) || tree.available(node) < amount) return;
    const r = await pay(tree, { node, merchant: "GOLD", amount }, allowAll, { now });
    assert.equal(r.outcome, "SETTLED");
  };
  for (const n of tree.listNodes()) {
    if (n.name.startsWith("exec.")) await spend(n.name, 5_000n * U);
    if (n.name.startsWith("data.")) await spend(n.name, 1_000n * U);
  }
  await spend(DESKED, 1_000n * U);
  if (t === GRANT) {
    tree.delegate(DESKED, "vendor", { budget: tree.available(DESKED) / 4n, allowedMerchants: ["GOLD"], expiry: tickToUnix(T + 30) });
  }
}

interface Seen {
  authority: number;
  notional: Weights;
  dead: boolean;
}

/**
 * Run the scenario and check every order from the outside at the moment it is
 * handed over for marking, restating the bound independently of the book: an
 * order is sized on no more than available = budget − spent − Σ children's
 * budgets, its gross notional is at most available × leverage, and a dead
 * mandate puts on nothing. Also counts how often the budget overstated the
 * available authority, and how often sizing from it would have broken the
 * notional bound.
 */
async function watchTrades(policy: AllocationPolicy) {
  const seen: Seen[][] = [];
  let overstated = 0;
  let breaches = 0;
  let worst = 0;
  const book = await runBook(market, spec(), policy, {
    onTick: outside,
    onTrade: (t, tree, orders) => {
      assert.equal(t, seen.length);
      const row: Seen[] = [];
      for (const o of orders) {
        const node = tree.requireNode(o.node);
        const handedDown = tree.childrenOf(o.node).reduce((s, c) => s + c.mandate.budget, 0n);
        const available = node.mandate.budget - node.mandate.spentDirect - handedDown;
        const dead = tree.isRevokedInChain(o.node);
        const weightGross = Object.values(o.weights).reduce((s, w) => s + Math.abs(w), 0);
        const gross = Object.values(o.weights).reduce((s, w) => s + Math.abs(o.authority * o.leverage * w), 0);
        assert.equal(o.leverage, policy.leverage, `t=${t}: ${o.node} runs the policy's leverage`);
        if (dead) {
          assert.deepEqual(o.weights, {}, `t=${t}: closed ${o.node} holds a book`);
          assert.equal(o.authority, 0, `t=${t}: closed ${o.node} holds authority`);
        } else {
          assert.ok(o.authority <= usdc(available), `t=${t}: ${o.node} sized on ${o.authority} > available ${usdc(available)}`);
          const limit = usdc(available) * policy.leverage;
          assert.ok(gross <= limit * (1 + TRADE_SLACK), `t=${t}: ${o.node} trades ${gross} > available × leverage ${limit}`);
          if (node.mandate.budget > available + U) overstated++;
          const byBudget = usdc(node.mandate.budget) * policy.leverage * weightGross;
          if (byBudget > limit * (1 + 1e-6)) {
            breaches++;
            worst = Math.max(worst, byBudget - limit);
          }
        }
        row.push({ authority: o.authority, notional: orderNotional(o), dead });
      }
      seen.push(row);
    },
  });
  return { book, seen, overstated, breaches, worst };
}

const policies: [string, AllocationPolicy][] = [
  ["center book", defaultCenterBookPolicy()],
  ["center book without a cut rung", { ...defaultCenterBookPolicy(), ddCut: undefined, cutFactor: undefined, ddRecover: undefined }],
  ["per-agent guardrails", defaultNaivePolicy()],
];

for (const [label, policy] of policies) {
  test(`${label}: no agent ever trades more than its available authority × leverage, though its budget says more; a closed agent trades nothing`, async () => {
    const { book, seen, overstated, breaches, worst } = await watchTrades(policy);
    assert.equal(seen.length, T, "every tick's orders were handed over");
    const tree = book.tree;

    // The scenario bites: the book's capital number (the budget) overstated
    // what agents may trade, often, and sizing from it would have put real
    // money beyond the reservation.
    assert.ok(overstated >= 300, `live orders whose budget overstated their available authority: ${overstated}`);
    assert.ok(breaches >= 200, `…of which budget-sizing would breach available × leverage: ${breaches}`);
    assert.ok(worst >= 500_000, `by up to ${worst.toFixed(0)} USDC of notional`);
    assert.ok(tree.requireNode(DESKED).mandate.spentDirect > 0n, "the agent paid out of its own mandate");
    assert.ok(tree.getNode(`vendor.${DESKED}`), "an outside sub-mandate was granted");

    // What is marked is exactly what was audited: capital = the order's
    // authority, PnL = Σ notional × return, NAV = Σ PnL.
    let nav = book.startNav;
    for (let t = 0; t < T; t++) {
      let tickPnl = 0;
      book.agents.forEach((a, i) => {
        const s = seen[t]![i]!;
        assert.equal(a.capital[t], s.authority, `t=${t}: ${a.name} ran the audited authority`);
        let pnl = 0;
        for (const [k, n] of Object.entries(s.notional)) pnl += n * (market.ticks[t]!.returns[k] ?? 0);
        assert.ok(Math.abs(a.pnl[t]! - pnl) <= 1e-9 * Math.max(1, Math.abs(pnl)), `t=${t}: ${a.name} marked ${a.pnl[t]} vs audited ${pnl}`);
        tickPnl += a.pnl[t]!;
      });
      nav += tickPnl;
      assert.ok(Math.abs(book.nav[t]! - nav) <= 1e-6, `t=${t}: NAV is the sum of the marked orders`);
    }

    // The stop-out: from the tick after its close, the doomed agent's orders are empty.
    const stop = book.decisions.find((d) => d.kind === "STOP_OUT" && d.node === DOOMED);
    assert.ok(stop, "the doomed agent is stopped out");
    const i = book.agents.findIndex((a) => a.name === DOOMED);
    for (let t = stop.t + 1; t < T; t++) {
      assert.equal(seen[t]![i]!.dead, true);
      assert.deepEqual(seen[t]![i]!.notional, {});
      assert.equal(book.agents[i]!.pnl[t], 0);
    }
    assert.ok(stop.t + 1 < T - 50, "and there were many ticks after it");
  });
}

/* ------------------------------------------------------------------ */
/* The audit: a corrupted size never reaches the mark                 */
/* ------------------------------------------------------------------ */

/**
 * Run the scenario with `tamper` applied to the orders at one tick, and
 * return what the book threw. The tree is checked sound (the core audit) at
 * the moment of tampering: only the order's number is wrong.
 */
async function tampered(
  policy: AllocationPolicy,
  tamper: (t: number, tree: DelegationTree, orders: SizedOrder[]) => boolean,
): Promise<{ error: unknown; at: number | null }> {
  let at: number | null = null;
  try {
    await runBook(market, spec(), policy, {
      onTick: outside,
      onTrade: (t, tree, orders) => {
        if (at !== null) return;
        if (tamper(t, tree, orders as SizedOrder[])) {
          assert.deepEqual(tree.audit(), [], "the tree itself is sound");
          at = t;
        }
      },
    });
  } catch (error) {
    return { error, at };
  }
  return { error: null, at };
}

const index = (name: string) => spec().agents.findIndex((a) => `${a.label}.${a.pod}.${FUND}` === name);

test("a book capital number inflated for one agent (the tree untouched) stops the book at the trade, naming that agent", async () => {
  for (const [, policy] of policies) {
    // The desked agent sized from its budget, as the book sized every agent before.
    const fromBudget = await tampered(policy, (t, tree, orders) => {
      if (t !== 60) return false;
      orders[index(DESKED)]!.authority = usdc(tree.requireNode(DESKED).mandate.budget);
      return true;
    });
    assert.equal(fromBudget.at, 60);
    assert.ok(fromBudget.error instanceof BookInvariantError, String(fromBudget.error));
    assert.equal(fromBudget.error.t, 60);
    assert.equal(fromBudget.error.at, "trade");
    assert.deepEqual(fromBudget.error.violations.map((v) => v.split(":")[0]), [`OVER_RESERVATION ${DESKED}`]);

    // An agent with nothing handed down, inflated 1.5×.
    const inflated = await tampered(policy, (t, _tree, orders) => {
      const o = orders[index(PLAIN)]!;
      if (t < 40 || grossNotional(o) === 0) return false;
      o.authority *= 1.5;
      return true;
    });
    assert.ok(inflated.error instanceof BookInvariantError);
    assert.equal(inflated.error.t, inflated.at);
    assert.deepEqual(inflated.error.violations.map((v) => v.split(":")[0]), [`OVER_RESERVATION ${PLAIN}`]);

    // A closed agent handed its old book back.
    const revived = await tampered(policy, (_t, tree, orders) => {
      if (!tree.isRevokedInChain(DOOMED)) return false;
      orders[index(DOOMED)]!.authority = 1_000_000;
      orders[index(DOOMED)]!.weights = { GOLD: 0.5 };
      return true;
    });
    assert.ok(revived.error instanceof BookInvariantError);
    assert.ok(revived.at !== null && revived.at > TURN);
    assert.deepEqual(revived.error.violations.map((v) => v.split(":")[0]), [`DEAD_TRADES ${DOOMED}`]);

    // One agent's order dropped.
    const dropped = await tampered(policy, (t, _tree, orders) => {
      if (t !== 10) return false;
      orders.pop();
      return true;
    });
    assert.ok(dropped.error instanceof BookInvariantError);
    assert.match(dropped.error.violations[0]!, /^ORDERS_MISMATCH/);

    // Control: a hook that only looks runs the book to the end.
    const untouched = await tampered(policy, () => false);
    assert.equal(untouched.error, null);
  }
});

test("orders are sized after the crowding cuts: a crowd-cut agent trades its cut authority on the very tick it is cut", async () => {
  const policy = defaultCenterBookPolicy();
  // Available authority once the tick's outside spending is done (before the
  // book acts), and the authority each order was sized on.
  const before = new Map<string, number>();
  const sized = new Map<string, number>();
  const key = (t: number, node: string) => `${t} ${node}`;
  const book = await runBook(market, spec(), policy, {
    onTick: async (t, tree) => {
      await outside(t, tree);
      for (const n of tree.listNodes()) before.set(key(t, n.name), usdc(tree.available(n.name)));
    },
    onTrade: (t, _tree, orders) => {
      for (const o of orders) sized.set(key(t, o.node), o.authority);
    },
  });
  const rebalances = (t: number) => t >= policy.warmup && (t - policy.warmup) % policy.rebalanceEvery === 0;
  const cuts = book.decisions.filter((d) => d.kind === "CROWDING_CUT" && !rebalances(d.t));
  assert.ok(cuts.length >= 5, `crowding cuts on ticks without a reallocation: ${cuts.length}`);
  for (const d of cuts) {
    for (const name of d.node.split(", ")) {
      const was = before.get(key(d.t, name))!;
      const now = sized.get(key(d.t, name))!;
      assert.ok(now < was, `t=${d.t}: ${name} traded ${now}, not the ${was} it held before the cut`);
    }
  }
});

test("the book decides on the tree's numbers: every REALLOCATE starts from the budget the tree held, and every CUT halves it in the tree", async () => {
  const policy = defaultCenterBookPolicy();
  const key = (t: number, node: string) => `${t} ${node}`;
  // Budgets once the tick's outside activity is done (before the book acts), and at the trade.
  const atTick = new Map<string, number>();
  const atTrade = new Map<string, number>();
  const book = await runBook(market, spec(), policy, {
    onTick: async (t, tree) => {
      await outside(t, tree);
      for (const n of tree.listNodes()) atTick.set(key(t, n.name), usdc(n.mandate.budget));
    },
    onTrade: (t, tree, orders) => {
      for (const o of orders) atTrade.set(key(t, o.node), usdc(tree.requireNode(o.node).mandate.budget));
    },
  });

  const moves = book.decisions.filter((d) => d.kind === "REALLOCATE");
  assert.equal(new Set(moves.map((d) => d.node)).size, book.agents.length, "every agent was reallocated");
  for (const d of moves) {
    const from = Number(/^(\d+) → /.exec(d.detail)![1]);
    const held = atTick.get(key(d.t, d.node))!;
    assert.ok(Math.abs(from - held) <= 0.5, `t=${d.t}: ${d.node} reallocated from ${from}, but the tree held ${held}`);
  }

  // An agent with no sub-mandates has no floor: its cut budget is exactly
  // cutFactor × what the tree held at the trade.
  let checked = 0;
  for (const d of book.decisions.filter((x) => x.kind === "CUT" && x.t + 1 < T)) {
    if (book.tree.childrenOf(d.node).length > 0) continue;
    const before = atTrade.get(key(d.t, d.node))!;
    const after = atTick.get(key(d.t + 1, d.node))!;
    assert.ok(Math.abs(after - before * policy.cutFactor!) <= 1e-6, `t=${d.t}: ${d.node} cut from ${before} to ${after}`);
    checked++;
  }
  assert.ok(checked >= 2, `cuts checked: ${checked}`);
});

test("the trade audit reads the tree as it stands at the trade: a cut made after sizing stops the stale order; a bare revoke there is caught at the tick's end", async () => {
  // An outside risk officer halves an agent through the tree's own API after
  // its order was sized: the tree is sound, the order now exceeds it.
  const halved = await tampered(defaultCenterBookPolicy(), (t, tree, orders) => {
    if (t < 40 || grossNotional(orders[index(PLAIN)]!) === 0) return false;
    tree.resize(PLAIN, tree.requireNode(PLAIN).mandate.budget / 2n);
    return true;
  });
  assert.ok(halved.error instanceof BookInvariantError);
  assert.equal(halved.error.at, "trade");
  assert.deepEqual(halved.error.violations.map((v) => v.split(":")[0]), [`OVER_RESERVATION ${PLAIN}`]);

  // A desk revoked without being closed at the trade (its agent's order is
  // still within its reservation) is a mid-tick break of the tree, caught at
  // that tick's end like any other.
  let at = -1;
  await assert.rejects(
    runBook(market, spec(), defaultNaivePolicy(), {
      onTick: outside,
      onTrade: (t, tree) => {
        if (t !== 40) return;
        tree.revoke(`exec.${DESKED}`);
        at = t;
      },
    }),
    (e: unknown) =>
      e instanceof BookInvariantError && e.t === 40 && e.at === "end" && e.violations.some((v) => v.startsWith(`NOT_CLOSED exec.${DESKED}`)),
  );
  assert.equal(at, 40);
});

/* ------------------------------------------------------------------ */
/* The tree against its own history (replay)                          */
/* ------------------------------------------------------------------ */

const HERD_A = `herd-a.macro.${FUND}`;

test("a direct write that keeps every invariant (budget moved between two agents of one pod) stops the book at the next audit", async () => {
  for (const [, policy] of policies) {
    let wrote = -1;
    await assert.rejects(
      runBook(market, spec(), policy, {
        onTick: async (t, tree) => {
          await outside(t, tree);
          if (t !== 40) return;
          // Bypass the API: take a slice of herd-a's unspent budget and hand it to plain.
          const slice = tree.available(HERD_A) / 4n;
          assert.ok(slice > 0n);
          tree.requireNode(HERD_A).mandate.budget -= slice;
          tree.requireNode(PLAIN).mandate.budget += slice;
          // Everything the core audit reads is still sound: the pod hands down
          // what it did, nobody is over-committed, the root holds the AUM.
          assert.deepEqual(tree.audit(), []);
          wrote = t;
        },
      }),
      (e: unknown) =>
        e instanceof BookInvariantError &&
        e.t === 40 &&
        e.at === "start" &&
        e.violations.length === 2 &&
        e.violations.some((v) => v.startsWith(`UNLOGGED_WRITE ${PLAIN}: the budget`)) &&
        e.violations.some((v) => v.startsWith(`UNLOGGED_WRITE ${HERD_A}: the budget`)),
    );
    assert.equal(wrote, 40);
  }
});

test("the trade check replays the log too: a budget written directly and then put back through resize() stops the order", async () => {
  const restored = await tampered(defaultCenterBookPolicy(), (t, tree) => {
    if (t !== 40) return false;
    const node = tree.requireNode(PLAIN);
    const budget = node.mandate.budget;
    node.mandate.budget = budget * 2n; // the review's write…
    tree.resize(PLAIN, budget); // …undone through the API: the tree's state is what it was
    return true;
  });
  assert.equal(restored.at, 40);
  assert.ok(restored.error instanceof BookInvariantError, String(restored.error));
  assert.equal(restored.error.t, 40);
  assert.equal(restored.error.at, "trade");
  assert.equal(restored.error.violations.length, 1);
  assert.match(restored.error.violations[0]!, new RegExp(`^UNLOGGED_WRITE ${PLAIN.replaceAll(".", "\\.")}: seq \\d+ \\(RESIZE / OK`));
  assert.match(restored.error.violations[0]!, /resized from a budget of \d+, but the log had left it at \d+/);
});

test("a whole book (payments, an outside sub-mandate, reallocations, stop-out closes) replays exactly from its event log", async () => {
  for (const [, policy] of policies) {
    const book = await runBook(market, spec(), policy, { onTick: outside });
    assert.ok(book.decisions.some((d) => d.kind === "STOP_OUT"), "a close is in the log");
    const types = new Set(book.tree.events.map((e) => `${e.type}/${e.result}`));
    for (const k of ["FUND/OK", "DELEGATE/OK", "RESIZE/OK", "PAYMENT/SETTLED", "REVOKE/REVOKED"]) assert.ok(types.has(k), k);
    assert.deepEqual(book.tree.verifyAgainstLog({ fromScratch: true }), []);
    const rebuilt = DelegationTree.replay(book.tree.events);
    assert.deepEqual(rebuilt.listNodes(), book.tree.listNodes());
    assert.deepEqual(rebuilt.principal, book.tree.principal);
  }
});
