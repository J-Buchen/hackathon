/**
 * (R) The reservation binds on randomized arena rosters (clones under two
 * names, herders, a rogue, crowd crashes). Every order is checked from the
 * outside at the moment it is handed over for marking: it is sized on no more
 * than its mandate's available authority (budget − own spend − handed down),
 * its gross notional is at most that × leverage, a closed agent puts on
 * nothing, and what the book marks is exactly that order.
 *
 * With desks that hold a slice of every agent's budget and pay for something
 * every tick, the budget overstates what an agent may trade; without them (the
 * rosters the arena scores), available authority IS the budget for every live
 * agent, which is why sizing from the tree leaves the arena's numbers
 * unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount, pay, type DelegationTree, type PaymentAdapters } from "@allowance/core";
import {
  defaultCenterBookPolicy,
  defaultNaivePolicy,
  orderNotional,
  runBook,
  tickToUnix,
  TRADE_SLACK,
  type AllocationPolicy,
  type SizedOrder,
  type SwarmSpec,
} from "@allowance/swarm";
import { makeWorld, type World } from "./arena";

const usdc = (units: bigint) => Number(formatAmount(units));

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

async function deskSpend(t: number, tree: DelegationTree): Promise<void> {
  for (const n of tree.listNodes()) {
    const desk = n.name.split(".")[0];
    if ((desk !== "exec" && desk !== "data") || tree.isRevokedInChain(n.name)) continue;
    const amount = desk === "exec" ? 500_000000n : 50_000000n;
    if (tree.available(n.name) < amount) continue;
    const r = await pay(tree, { node: n.name, merchant: n.mandate.allowedMerchants![0]!, amount }, allowAll, { now: tickToUnix(t) });
    assert.equal(r.outcome, "SETTLED");
  }
}

/** Run one book, checking every order at the trade; returns how often the budget overstated authority. */
async function check(world: World, spec: SwarmSpec, policy: AllocationPolicy, desks: boolean) {
  const seen: { authority: number; notional: Record<string, number> }[][] = [];
  let overstated = 0;
  let live = 0;
  const book = await runBook(world.market, spec, policy, {
    onTick: desks ? deskSpend : undefined,
    onTrade: (t, tree, orders: readonly SizedOrder[]) => {
      seen.push(
        orders.map((o) => {
          const node = tree.requireNode(o.node);
          const handedDown = tree.childrenOf(o.node).reduce((s, c) => s + c.mandate.budget, 0n);
          const available = usdc(node.mandate.budget - node.mandate.spentDirect - handedDown);
          const gross = Object.values(o.weights).reduce((s, w) => s + Math.abs(o.authority * o.leverage * w), 0);
          if (tree.isRevokedInChain(o.node)) {
            assert.equal(gross, 0, `t=${t}: closed ${o.node} trades`);
            assert.deepEqual(o.weights, {});
          } else {
            live++;
            assert.ok(o.authority <= available, `t=${t}: ${o.node} sized on ${o.authority} > available ${available}`);
            assert.ok(gross <= available * policy.leverage * (1 + TRADE_SLACK), `t=${t}: ${o.node} trades ${gross}`);
            if (usdc(node.mandate.budget) > available + 1) overstated++;
            // Without desks or spend, available authority is the budget: the old size, to the unit.
            if (!desks) assert.equal(o.authority, usdc(node.mandate.budget), `t=${t}: ${o.node}`);
          }
          return { authority: o.authority, notional: orderNotional(o) };
        }),
      );
    },
  });
  const T = world.market.ticks.length;
  assert.equal(seen.length, T);
  for (let t = 0; t < T; t++) {
    book.agents.forEach((a, i) => {
      const s = seen[t]![i]!;
      assert.equal(a.capital[t], s.authority);
      let pnl = 0;
      for (const [k, n] of Object.entries(s.notional)) pnl += n * (world.market.ticks[t]!.returns[k] ?? 0);
      assert.ok(Math.abs(a.pnl[t]! - pnl) <= 1e-9 * Math.max(1, Math.abs(pnl)), `t=${t}: ${a.name} marked ${a.pnl[t]} vs ${pnl}`);
    });
  }
  return { overstated, live, stopped: book.agents.filter((a) => a.ladder === "stopped").length };
}

let overstated = 0;
let stopped = 0;
for (const seed of [7, 8, 9, 10, 11, 12]) {
  test(`arena world ${seed}: every order is within its mandate's available authority × leverage, with and without desks`, async () => {
    const world = makeWorld(seed);
    for (const policy of [defaultCenterBookPolicy(), defaultNaivePolicy()]) {
      const withDesks = world.swarm();
      for (const a of withDesks.agents) {
        a.subMandates = [
          { label: "exec", share: 0.2 },
          { label: "data", share: 0.01, instruments: [a.instruments[0]!] },
        ];
      }
      const d = await check(world, withDesks, policy, true);
      assert.ok(d.overstated > 0.9 * d.live, `desks reserve a slice of every live agent (${d.overstated}/${d.live})`);
      overstated += d.overstated;
      stopped += d.stopped;
      await check(world, world.swarm(), policy, false);
    }
  });
}

test("those worlds had budgets overstating authority, and closed agents", () => {
  assert.ok(overstated >= 10_000, `live orders whose budget overstated their authority: ${overstated}`);
  assert.ok(stopped >= 30, `stop-outs: ${stopped}`);
});
