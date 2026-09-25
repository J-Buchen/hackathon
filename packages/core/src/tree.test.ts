import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DelegationTree,
  UnknownNodeError,
  childName,
  parentNameOf,
  leftLabel,
} from "./tree";
import { AttenuationError } from "./attenuation";
import { pay, type PaymentAdapters } from "./payment";

const FAR = 4_000_000_000;

function seed(): DelegationTree {
  const tree = new DelegationTree();
  tree.fundRoot({
    principal: "alice",
    rootName: "alice.eth",
    mandate: { budget: 100_000000n, expiry: FAR },
  });
  return tree;
}

test("name helpers", () => {
  assert.equal(leftLabel("scraper.researcher.alice.eth"), "scraper");
  assert.equal(parentNameOf("scraper.researcher.alice.eth"), "researcher.alice.eth");
  assert.equal(parentNameOf("eth"), null);
  assert.equal(childName("alice.eth", "researcher"), "researcher.alice.eth");
});

test("delegation reserves budget and reduces parent available", () => {
  const tree = seed();
  assert.equal(tree.available("alice.eth"), 100_000000n);

  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });

  assert.equal(tree.reserved("alice.eth"), 30_000000n);
  assert.equal(tree.available("alice.eth"), 70_000000n);
  assert.equal(tree.available("researcher.alice.eth"), 30_000000n);
});

test("nested delegation and ancestor walk", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });
  tree.delegate("researcher.alice.eth", "scraper", {
    budget: 10_000000n,
    allowedMerchants: ["arxiv"],
    expiry: FAR,
  });

  const ancestors = tree.ancestors("scraper.researcher.alice.eth").map((a) => a.name);
  assert.deepEqual(ancestors, ["researcher.alice.eth", "alice.eth"]);
  assert.equal(tree.available("researcher.alice.eth"), 20_000000n);
});

test("over-budget delegation throws AttenuationError and logs a rejection event", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });

  assert.throws(
    () =>
      tree.delegate("researcher.alice.eth", "greedy", {
        budget: 999_000000n,
        allowedMerchants: ["arxiv"],
        expiry: FAR,
      }),
    (err: unknown) =>
      err instanceof AttenuationError && err.reason === "BUDGET_EXCEEDS_AVAILABLE",
  );

  const last = tree.events[tree.events.length - 1];
  assert.equal(last?.result, "ATTENUATION_REJECTED");
});

test("revoke marks the chain as revoked for descendants", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", { budget: 30_000000n, expiry: FAR });
  tree.delegate("researcher.alice.eth", "scraper", { budget: 10_000000n, expiry: FAR });

  assert.equal(tree.isRevokedInChain("scraper.researcher.alice.eth"), false);
  tree.revoke("researcher.alice.eth");
  assert.equal(tree.isRevokedInChain("researcher.alice.eth"), true);
  assert.equal(tree.isRevokedInChain("scraper.researcher.alice.eth"), true);
});

test("expiry-in-chain detection", () => {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "alice", rootName: "alice.eth", mandate: { budget: 100_000000n, expiry: 2000 } });
  tree.delegate("alice.eth", "researcher", { budget: 10_000000n, expiry: 1500 });

  assert.equal(tree.isExpiredInChain("researcher.alice.eth", 1000), false);
  assert.equal(tree.isExpiredInChain("researcher.alice.eth", 1600), true); // child expired
  assert.equal(tree.isExpiredInChain("alice.eth", 2500), true); // root expired
});

/* ---------------------------------------------------------------- */
/* resize — the allocator's lever                                   */
/* ---------------------------------------------------------------- */

test("resize shrink frees parent available and records RESIZE/OK", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.resize("pod.alice.eth", 10_000000n);
  assert.equal(tree.requireNode("pod.alice.eth").mandate.budget, 10_000000n);
  assert.equal(tree.available("alice.eth"), 90_000000n);
  const last = tree.events.at(-1)!;
  assert.equal(last.type, "RESIZE");
  assert.equal(last.result, "OK");
});

test("resize grow draws from parent available, and is capped by it", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.resize("pod.alice.eth", 100_000000n); // +60 = exactly root's available
  assert.equal(tree.available("alice.eth"), 0n);
  assert.throws(
    () => tree.resize("pod.alice.eth", 100_000001n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "BUDGET_EXCEEDS_AVAILABLE",
  );
  assert.equal(tree.events.at(-1)!.result, "ATTENUATION_REJECTED");
});

test("resize cannot cut below what a node already delegated or spent", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.delegate("pod.alice.eth", "agent", { budget: 25_000000n, expiry: FAR });
  assert.throws(
    () => tree.resize("pod.alice.eth", 24_000000n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "BELOW_COMMITTED",
  );
  tree.resize("pod.alice.eth", 25_000000n); // exactly committed is fine
  assert.equal(tree.available("pod.alice.eth"), 0n);
});

test("resize: root can only shrink; revoked subtrees cannot be resized", () => {
  const tree = seed();
  assert.throws(() => tree.resize("alice.eth", 101_000000n), AttenuationError);
  tree.resize("alice.eth", 50_000000n);
  tree.delegate("alice.eth", "pod", { budget: 10_000000n, expiry: FAR });
  tree.delegate("pod.alice.eth", "agent", { budget: 5_000000n, expiry: FAR });
  tree.revoke("pod.alice.eth");
  assert.throws(
    () => tree.resize("agent.pod.alice.eth", 1_000000n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "PARENT_REVOKED",
  );
});

/* ---------------------------------------------------------------- */
/* close — shrink the subtree to what it spent, then revoke          */
/* ---------------------------------------------------------------- */

/** Always-yes adapters: these tests are about the tree, not the ports. */
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

/**
 * fund.eth (100) -> pm (40) -> scraper (10), plus a sibling pod (20).
 * pm spends 5 itself, scraper spends 3.
 */
async function capitalTree(): Promise<DelegationTree> {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "fund", rootName: "fund.eth", mandate: { budget: 100_000000n, expiry: FAR } });
  tree.delegate("fund.eth", "pm", { budget: 40_000000n, expiry: FAR });
  tree.delegate("pm.fund.eth", "scraper", { budget: 10_000000n, expiry: FAR });
  tree.delegate("fund.eth", "pod", { budget: 20_000000n, expiry: FAR });
  const now = 1_000;
  assert.equal((await pay(tree, { node: "pm.fund.eth", merchant: "venue", amount: 5_000000n }, allowAll, { now })).outcome, "SETTLED");
  assert.equal(
    (await pay(tree, { node: "scraper.pm.fund.eth", merchant: "agenthire:5", amount: 3_000000n }, allowAll, { now })).outcome,
    "SETTLED",
  );
  return tree;
}

test("close returns the freed authority and the parent's available rises by exactly that", async () => {
  const tree = await capitalTree();
  const rootAvailableBefore = tree.available("fund.eth"); // 100 - 40 - 20 = 40
  assert.equal(rootAvailableBefore, 40_000000n);

  const freed = tree.close("pm.fund.eth");

  // pm held 40; its subtree spent 5 (pm) + 3 (scraper) = 8, so 32 comes back.
  assert.equal(typeof freed, "bigint");
  assert.equal(freed, 32_000000n);
  assert.equal(tree.available("fund.eth"), rootAvailableBefore + freed);
  assert.equal(tree.requireNode("scraper.pm.fund.eth").mandate.budget, 3_000000n);
  assert.equal(tree.requireNode("pm.fund.eth").mandate.budget, 8_000000n);
  assert.equal(tree.available("pm.fund.eth"), 0n);
  assert.equal(tree.available("scraper.pm.fund.eth"), 0n);
  // Spend history is untouched; the sibling is untouched.
  assert.equal(tree.requireNode("pm.fund.eth").mandate.spentDirect, 5_000000n);
  assert.equal(tree.requireNode("pod.fund.eth").mandate.budget, 20_000000n);
  assert.equal(tree.requireNode("pod.fund.eth").mandate.revoked, false);
});

test("close records RESIZE deepest-first, then one REVOKE carrying the freed amount", async () => {
  const tree = await capitalTree();
  const from = tree.nextSeq;
  const freed = tree.close("pm.fund.eth");
  const events = tree.events.slice(from);
  assert.deepEqual(
    events.map((e) => [e.type, e.node, e.result, e.amount]),
    [
      ["RESIZE", "scraper.pm.fund.eth", "OK", 3_000000n],
      ["RESIZE", "pm.fund.eth", "OK", 8_000000n],
      ["REVOKE", "pm.fund.eth", "REVOKED", freed],
    ],
  );
});

test("after close, the node and every descendant can no longer pay", async () => {
  const tree = await capitalTree();
  tree.close("pm.fund.eth");
  for (const node of ["pm.fund.eth", "scraper.pm.fund.eth"]) {
    const r = await pay(tree, { node, merchant: "agenthire:5", amount: 1n }, allowAll, { now: 1_000 });
    assert.equal(r.outcome, "REVOKED", node);
  }
  // Delegating new authority under the closed node is refused too.
  assert.throws(
    () => tree.delegate("pm.fund.eth", "late", { budget: 0n, expiry: FAR }),
    (e: unknown) => e instanceof AttenuationError && e.reason === "PARENT_REVOKED",
  );
  // The freed budget is really usable by the parent.
  tree.delegate("fund.eth", "next-pm", { budget: 72_000000n, expiry: FAR });
  assert.equal(tree.available("fund.eth"), 0n);
});

test("close is idempotent: a second close frees 0n and records nothing", async () => {
  const tree = await capitalTree();
  assert.equal(tree.close("pm.fund.eth"), 32_000000n);
  const seq = tree.nextSeq;
  assert.equal(tree.close("pm.fund.eth"), 0n);
  assert.equal(tree.close("scraper.pm.fund.eth"), 0n); // already shrunk, revoked via chain
  assert.equal(tree.nextSeq, seq + 1); // only the scraper's own REVOKE
  assert.equal(tree.events.at(-1)!.type, "REVOKE");
  assert.equal(tree.events.at(-1)!.amount, 0n);
});

test("close on an unknown node throws UnknownNodeError and records nothing", () => {
  const tree = seed();
  const seq = tree.nextSeq;
  assert.throws(() => tree.close("nobody.alice.eth"), UnknownNodeError);
  assert.equal(tree.nextSeq, seq);
});

test("close reclaims budget stranded under an individually revoked descendant", async () => {
  const tree = await capitalTree();
  tree.revoke("scraper.pm.fund.eth"); // revoke alone leaves 7 unspent reserved in pm
  assert.equal(tree.reserved("pm.fund.eth"), 10_000000n);
  assert.throws(() => tree.resize("scraper.pm.fund.eth", 3_000000n), AttenuationError); // resize refuses
  assert.equal(tree.close("pm.fund.eth"), 32_000000n); // close still reclaims it
  assert.equal(tree.requireNode("scraper.pm.fund.eth").mandate.budget, 3_000000n);
});

test("a revoked-but-not-closed node can be closed to reclaim its budget without a second REVOKE", async () => {
  const tree = await capitalTree();
  tree.revoke("pm.fund.eth");
  const before = tree.available("fund.eth");
  const from = tree.nextSeq;
  const freed = tree.close("pm.fund.eth");
  assert.equal(freed, 32_000000n);
  assert.equal(tree.available("fund.eth"), before + freed);
  assert.deepEqual(tree.events.slice(from).map((e) => e.type), ["RESIZE", "RESIZE"]);
});

test("close of an unspent leaf frees its whole budget; close of the root frees to the principal", () => {
  const tree = seed();
  tree.delegate("alice.eth", "idle", { budget: 25_000000n, expiry: FAR });
  assert.equal(tree.close("idle.alice.eth"), 25_000000n);
  assert.equal(tree.requireNode("idle.alice.eth").mandate.budget, 0n);
  assert.equal(tree.available("alice.eth"), 100_000000n);

  assert.equal(tree.close("alice.eth"), 100_000000n);
  assert.equal(tree.requireNode("alice.eth").mandate.budget, 0n);
  assert.equal(tree.requireNode("alice.eth").mandate.revoked, true);
  assert.match(tree.events.at(-1)!.detail, /back to the principal/);
});

test("close never shrinks a parent below what its subtree really spent (after an unserialized overspend)", async () => {
  // r 1000 -> A 500 -> C 100. Two concurrent pay() calls of 100 each from C
  // both pass the budget check (settlement awaits in between), so C spends 200
  // against a budget of 100. SerializedPayer prevents this; close() must still
  // not turn it into extra authority for the root.
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 1000n, expiry: FAR } });
  tree.delegate("r.eth", "a", { budget: 500n, expiry: FAR });
  tree.delegate("a.r.eth", "c", { budget: 100n, expiry: FAR });
  const slow: PaymentAdapters = {
    ...allowAll,
    settlement: {
      settle: async (req) => {
        await new Promise((res) => setTimeout(res, 5));
        return allowAll.settlement.settle(req);
      },
    },
  };
  const both = await Promise.all([
    pay(tree, { node: "c.a.r.eth", merchant: "m", amount: 100n }, slow, { now: 1_000 }),
    pay(tree, { node: "c.a.r.eth", merchant: "m", amount: 100n }, slow, { now: 1_000 }),
  ]);
  assert.deepEqual(both.map((r) => r.outcome), ["SETTLED", "SETTLED"]);
  assert.equal(tree.requireNode("c.a.r.eth").mandate.spentDirect, 200n);

  const freed = tree.close("a.r.eth");
  assert.equal(freed, 300n, "A's subtree spent 200, so 500 - 200 comes back, not 500 - 100");
  assert.equal(tree.requireNode("a.r.eth").mandate.budget, 200n);
  assert.equal(tree.requireNode("c.a.r.eth").mandate.budget, 100n, "never grown");
  assert.equal(tree.available("r.eth"), 800n);
});

test("close frees exactly the unspent part of a deep, partly spent subtree", async () => {
  // r 1000 -> A 500 -> {B 200 -> C 80, D 50}. A spends 50, B 100, C 30; D is
  // revoked on its own after spending 7. Everything unspent comes back.
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 1000n, expiry: FAR } });
  tree.delegate("r.eth", "a", { budget: 500n, expiry: FAR });
  tree.delegate("a.r.eth", "b", { budget: 200n, expiry: FAR });
  tree.delegate("b.a.r.eth", "c", { budget: 80n, expiry: FAR });
  tree.delegate("a.r.eth", "d", { budget: 50n, expiry: FAR });
  for (const [node, amount] of [["a.r.eth", 50n], ["b.a.r.eth", 100n], ["c.b.a.r.eth", 30n], ["d.a.r.eth", 7n]] as const) {
    assert.equal((await pay(tree, { node, merchant: "m", amount }, allowAll, { now: 1_000 })).outcome, "SETTLED");
  }
  tree.revoke("d.a.r.eth");
  const before = tree.available("r.eth");
  const freed = tree.close("a.r.eth");
  assert.equal(freed, 500n - (50n + 100n + 30n + 7n));
  assert.equal(tree.available("r.eth"), before + freed);
  assert.deepEqual(
    ["c.b.a.r.eth", "b.a.r.eth", "d.a.r.eth", "a.r.eth"].map((n) => tree.requireNode(n).mandate.budget),
    [30n, 130n, 7n, 187n],
  );
});

/* ---------------------------------------------------------------- */
/* subtree, isClosed, audit — the invariants callers can check       */
/* ---------------------------------------------------------------- */

test("subtree lists a node and every descendant parents-first; spentInSubtree sums their spend", async () => {
  const tree = await capitalTree();
  assert.deepEqual(tree.subtree("pm.fund.eth").map((n) => n.name), ["pm.fund.eth", "scraper.pm.fund.eth"]);
  assert.deepEqual(tree.subtree("fund.eth").map((n) => n.name), ["fund.eth", "pm.fund.eth", "scraper.pm.fund.eth", "pod.fund.eth"]);
  assert.equal(tree.spentInSubtree("pm.fund.eth"), 8_000000n);
  assert.equal(tree.spentInSubtree("scraper.pm.fund.eth"), 3_000000n);
  assert.equal(tree.spentInSubtree("pod.fund.eth"), 0n);
  assert.throws(() => tree.subtree("nobody.fund.eth"), UnknownNodeError);
});

test("isClosed: a revoke strands unspent authority, a close leaves none", async () => {
  const tree = await capitalTree();
  assert.equal(tree.isClosed("pm.fund.eth"), false, "live");
  tree.revoke("pm.fund.eth");
  assert.equal(tree.isClosed("pm.fund.eth"), false, "revoked, but 32 unspent is stranded under it");
  const stranded = tree.subtree("pm.fund.eth").reduce((s, n) => s + tree.available(n.name), 0n);
  assert.equal(stranded, 32_000000n);
  const freed = tree.close("pm.fund.eth");
  assert.equal(freed, stranded, "close frees exactly what the revoke stranded");
  assert.equal(tree.isClosed("pm.fund.eth"), true);
  assert.equal(tree.isClosed("scraper.pm.fund.eth"), false, "the scraper is dead via its parent, not itself revoked");
  assert.ok(tree.subtree("pm.fund.eth").every((n) => tree.available(n.name) === 0n));
});

test("nothing new is minted inside a closed subtree: a descendant of a closed node cannot delegate", async () => {
  const tree = await capitalTree();
  tree.close("pm.fund.eth");
  const seq = tree.nextSeq;
  // The scraper itself is not revoked, only its parent: still refused, even at zero budget.
  assert.throws(
    () => tree.delegate("scraper.pm.fund.eth", "late", { budget: 0n, expiry: FAR }),
    (e: unknown) => e instanceof AttenuationError && e.reason === "PARENT_REVOKED",
  );
  assert.equal(tree.getNode("late.scraper.pm.fund.eth"), undefined);
  assert.equal(tree.events.at(-1)!.result, "ATTENUATION_REJECTED");
  assert.equal(tree.nextSeq, seq + 1);
});

test("audit: a tree built through the API is sound before and after resizes and closes", async () => {
  const tree = await capitalTree();
  assert.deepEqual(tree.audit(), []);
  tree.resize("pod.fund.eth", 5_000000n);
  tree.close("pm.fund.eth");
  tree.delegate("fund.eth", "next", { budget: tree.available("fund.eth"), expiry: FAR });
  assert.deepEqual(tree.audit(), []);
});

test("audit flags an over-committed node (the reservation invariant: children ≤ parent)", async () => {
  // The unserialized-overspend path: two concurrent pay() calls both pass the
  // budget check, so the child spends 200 against a budget of 100.
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 1000n, expiry: FAR } });
  tree.delegate("r.eth", "c", { budget: 100n, expiry: FAR });
  const slow: PaymentAdapters = {
    ...allowAll,
    settlement: {
      settle: async (req) => {
        await new Promise((res) => setTimeout(res, 5));
        return allowAll.settlement.settle(req);
      },
    },
  };
  await Promise.all([
    pay(tree, { node: "c.r.eth", merchant: "m", amount: 100n }, slow, { now: 1_000 }),
    pay(tree, { node: "c.r.eth", merchant: "m", amount: 100n }, slow, { now: 1_000 }),
  ]);
  const v = tree.audit();
  assert.equal(v.length, 1);
  assert.equal(v[0]!.kind, "OVER_COMMITTED");
  assert.equal(v[0]!.node, "c.r.eth");

  // A caller writing a parent's budget below what it handed down is caught too.
  const t2 = seed();
  t2.delegate("alice.eth", "kid", { budget: 60_000000n, expiry: FAR });
  t2.requireNode("alice.eth").mandate.budget = 50_000000n;
  assert.deepEqual(t2.audit().map((x) => [x.kind, x.node]), [["OVER_COMMITTED", "alice.eth"]]);
});

test("audit flags broadened authority, negative budgets and broken links", () => {
  const tree = seed();
  tree.delegate("alice.eth", "kid", { budget: 10_000000n, allowedMerchants: ["a"], allowedPurposes: ["data"], expiry: FAR - 10 });
  tree.delegate("kid.alice.eth", "grandkid", { budget: 1_000000n, allowedMerchants: ["a"], allowedPurposes: ["data"], expiry: FAR - 10 });
  assert.deepEqual(tree.audit(), []);
  const kid = tree.requireNode("kid.alice.eth");
  const grandkid = tree.requireNode("grandkid.kid.alice.eth");
  grandkid.mandate.allowedMerchants = ["a", "b"];
  grandkid.mandate.allowedPurposes = ["data", "trade"];
  grandkid.mandate.expiry = FAR;
  kid.mandate.budget = -1n;
  const kinds = tree.audit().map((x) => `${x.kind} ${x.node}`);
  assert.ok(kinds.includes("NEGATIVE_BUDGET kid.alice.eth"));
  assert.ok(kinds.includes("OVER_COMMITTED kid.alice.eth"));
  const broadened = tree.audit().find((x) => x.kind === "NOT_ATTENUATED")!;
  assert.equal(broadened.node, "grandkid.kid.alice.eth");
  assert.match(broadened.message, /merchants, purposes, expiry broaden parent "kid.alice.eth"/);

  const orphan = seed();
  const n = orphan.delegate("alice.eth", "kid", { budget: 1n, expiry: FAR });
  n.parent = "ghost.eth";
  assert.ok(orphan.audit().some((x) => x.kind === "BROKEN_LINK" && x.node === "kid.alice.eth"));
});
