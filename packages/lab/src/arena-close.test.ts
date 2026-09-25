/**
 * The book's tree guarantees on randomized arena rosters (clones under two
 * names, herders, a rogue, crowd crashes), with every agent holding desks that
 * pay for something every tick. The book audits its own tree before and after
 * every tick and throws on any break, so each run finishing is itself the
 * check that reservation and close invariants held throughout; on top of that:
 * every stop-out is exactly one close of the stopped agent, it leaves nothing
 * unspent under it, and the book never makes a move the tree refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pay, type PaymentAdapters } from "@allowance/core";
import { defaultCenterBookPolicy, defaultNaivePolicy, runBook, tickToUnix } from "@allowance/swarm";
import { makeWorld } from "./arena";

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

let stopOuts = 0;
for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`arena world ${seed}: with spending desks, every stop-out is one close and the tree stays sound`, async () => {
    const world = makeWorld(seed);
    for (const policy of [defaultCenterBookPolicy(), defaultNaivePolicy()]) {
      const spec = world.swarm();
      for (const a of spec.agents) {
        a.subMandates = [
          { label: "exec", share: 0.2 },
          { label: "data", share: 0.01, instruments: [a.instruments[0]!] },
        ];
      }
      const closed: string[] = [];
      const book = await runBook(world.market, spec, policy, {
        onTick: async (t, tree) => {
          if (t === 0) {
            const close = tree.close.bind(tree);
            tree.close = (name: string) => {
              closed.push(name);
              return close(name);
            };
          }
          for (const n of tree.listNodes()) {
            const desk = n.name.split(".")[0];
            if ((desk !== "exec" && desk !== "data") || tree.isRevokedInChain(n.name)) continue;
            const amount = desk === "exec" ? 500_000000n : 50_000000n;
            if (tree.available(n.name) < amount) continue;
            const r = await pay(tree, { node: n.name, merchant: n.mandate.allowedMerchants![0]!, amount }, allowAll, { now: tickToUnix(t) });
            assert.equal(r.outcome, "SETTLED");
          }
        },
      });
      const tree = book.tree;
      assert.equal(book.nav.length, world.market.ticks.length);
      assert.deepEqual(tree.events.filter((e) => e.result === "ATTENUATION_REJECTED"), []);
      assert.deepEqual(tree.audit(), []);
      const stopped = book.agents.filter((a) => a.ladder === "stopped").map((a) => a.name);
      assert.deepEqual([...closed].sort(), [...stopped].sort(), "each stopped agent was closed exactly once");
      for (const name of stopped) {
        assert.ok(tree.isClosed(name), `${name} is closed`);
        assert.equal(tree.subtree(name).length, 3, `${name} was closed with both desks`);
      }
      assert.ok(tree.listNodes().some((n) => n.name.startsWith("exec.") && n.mandate.spentDirect > 0n), "desks spent");
      stopOuts += stopped.length;
    }
  });
}

test("those worlds did stop agents out, holding desks", () => {
  assert.ok(stopOuts >= 20, `stop-outs across the worlds: ${stopOuts}`);
});
