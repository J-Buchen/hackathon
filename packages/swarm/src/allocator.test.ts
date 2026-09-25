import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegationTree } from "@allowance/core";
import {
  allocate,
  capShares,
  defaultCenterBookPolicy,
  nextLadderState,
  scanCrowding,
} from "./allocator";
import { preTradeCheck } from "./gate";
import { correlation, cosineSimilarity, currentDrawdown, maxDrawdown, sharpe } from "./stats";
import { gaussian, mulberry32 } from "./rng";

const noise = (seed: number, n: number, drift = 0) => {
  const z = gaussian(mulberry32(seed));
  return Array.from({ length: n }, () => drift + 0.01 * z());
};

test("stats: drawdowns, sharpe sign, correlation", () => {
  assert.equal(maxDrawdown([0.1, -0.5, 0.2]), 0.5);
  assert.ok(Math.abs(currentDrawdown([0.1, -0.5, 1.0]) - 0) < 1e-12);
  assert.ok(sharpe(noise(1, 500, 0.002)) > 0);
  assert.ok(sharpe(noise(1, 500, -0.002)) < 0);
  const a = noise(2, 200);
  assert.ok(Math.abs(correlation(a, a) - 1) < 1e-12);
  assert.ok(Math.abs(correlation(a, a.map((x) => -x)) + 1) < 1e-12);
  assert.equal(cosineSimilarity({ X: 1 }, { Y: 1 }), 0);
  assert.ok(Math.abs(cosineSimilarity({ X: 1, Y: -0.5 }, { X: 2, Y: -1 }) - 1) < 1e-12);
});

test("capShares: sums to 1, respects the cap, leaves the rest in cash when everyone is capped", () => {
  const s = capShares([10, 1, 1, 1], 0.4);
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.max(...s) <= 0.4 + 1e-12);
  const all = capShares([1, 1], 0.25);
  assert.deepEqual(all, [0.25, 0.25]);
  assert.deepEqual(capShares([0, -1], 0.5), [0, 0]);
});

test("allocate: clones split one allocation; losers and stopped agents get nothing", () => {
  const policy = { ...defaultCenterBookPolicy(), warmup: 10, maxAgentShare: 1 };
  const edge = noise(3, 120, 0.003);
  const other = noise(4, 120, 0.003);
  const loser = noise(5, 120, -0.003);
  const out = allocate(
    [
      { name: "a", unitReturns: edge, stopped: false, ladderMultiplier: 1 },
      { name: "a-clone", unitReturns: [...edge], stopped: false, ladderMultiplier: 1 },
      { name: "b", unitReturns: other, stopped: false, ladderMultiplier: 1 },
      { name: "loser", unitReturns: loser, stopped: false, ladderMultiplier: 1 },
      { name: "dead", unitReturns: other, stopped: true, ladderMultiplier: 1 },
    ],
    1_000_000,
    policy,
  );
  const by = new Map(out.map((s) => [s.name, s]));
  assert.ok(Math.abs(by.get("a")!.multiplicity - 2) < 0.2, "a is effectively two bets");
  assert.equal(by.get("a")!.target, by.get("a-clone")!.target);
  assert.equal(by.get("loser")!.target, 0);
  assert.equal(by.get("dead")!.target, 0);
  // Two clones together should not get the whole book just by being two.
  assert.ok(by.get("a")!.target + by.get("a-clone")!.target < 0.8 * 1_000_000);
});

test("allocate: equal weight during warmup; ladder and crowd caps shrink targets", () => {
  const policy = { ...defaultCenterBookPolicy(), warmup: 50, maxAgentShare: 1 };
  const r = noise(6, 20);
  const out = allocate(
    [
      { name: "x", unitReturns: r, stopped: false, ladderMultiplier: 0.5 },
      { name: "y", unitReturns: r, stopped: false, ladderMultiplier: 1, crowdCap: 100 },
      { name: "z", unitReturns: r, stopped: false, ladderMultiplier: 1 },
    ],
    900,
    policy,
  );
  const t = Object.fromEntries(out.map((s) => [s.name, s.target]));
  assert.ok(Math.abs(t.z! - 300) < 1e-9);
  assert.ok(Math.abs(t.x! - 150) < 1e-9);
  assert.equal(t.y, 100);
});

test("drawdown ladder: cut → restore → stop, and stop is final", () => {
  const th = { ddCut: 0.1, ddRecover: 0.05, ddStop: 0.2 };
  assert.equal(nextLadderState("active", [-0.12], th), "cut");
  assert.equal(nextLadderState("cut", [-0.12], th), "cut");
  assert.equal(nextLadderState("cut", [-0.12, 0.1], th), "active");
  assert.equal(nextLadderState("cut", [-0.25], th), "stopped");
  assert.equal(nextLadderState("stopped", [0.5], th), "stopped");
  // Naive books have no cut rung.
  assert.equal(nextLadderState("active", [-0.15], { ddStop: 0.2 }), "active");
});

test("crowding: agents in different pods running one trade are cut back to the limit", () => {
  const policy = { crowdSimilarity: 0.8, crowdMaxShare: 0.1, bookMaxShare: 1 };
  const scan = scanCrowding(
    [
      { name: "a.pod1", capital: 1_000_000, weights: { COFFEE: 1 } },
      { name: "b.pod2", capital: 1_000_000, weights: { COFFEE: 0.9, TEA: -0.1 } },
      { name: "c.pod3", capital: 1_000_000, weights: { GOLD: 1 } },
    ],
    10_000_000,
    2,
    policy,
  );
  assert.deepEqual(scan.clusters, [["a.pod1", "b.pod2"]]);
  assert.equal(scan.breaches.length, 1);
  const b = scan.breaches[0]!;
  assert.equal(b.kind, "CLONES");
  assert.equal(b.instrument, "COFFEE");
  // 2M × 2 × 0.95 = 3.8M → must come back to 1M.
  assert.ok(Math.abs(3_800_000 * b.scale - 1_000_000) < 1);
  assert.deepEqual(b.contributors, ["a.pod1", "b.pod2"]);
});

test("crowding: book-level limit catches concentration spread across different-looking agents", () => {
  const scan = scanCrowding(
    [
      { name: "trend", capital: 2_000_000, weights: { COFFEE: 0.5, GOLD: 0.5 } },
      { name: "value", capital: 2_000_000, weights: { COFFEE: 0.5, UST: -0.5 } },
    ],
    10_000_000,
    2,
    { crowdSimilarity: 0.8, crowdMaxShare: 0.1, bookMaxShare: 0.2 },
  );
  assert.equal(scan.clusters.length, 0, "books are not similar");
  const b = scan.breaches.find((x) => x.kind === "BOOK")!;
  assert.equal(b.instrument, "COFFEE");
  assert.ok(Math.abs(b.share - 0.4) < 1e-9);
  assert.ok(Math.abs(b.scale - 0.5) < 1e-9);
});

test("gate: off-mandate dropped, gross clipped, revoked trades nothing", () => {
  const tree = new DelegationTree();
  const FAR = 4_000_000_000;
  tree.fundRoot({ principal: "p", rootName: "fund.eth", mandate: { budget: 100n, allowedMerchants: ["A", "B"], expiry: FAR } });
  tree.delegate("fund.eth", "pm", { budget: 10n, allowedMerchants: ["A"], expiry: FAR });
  const g = preTradeCheck(tree, "pm.fund.eth", { A: 3, B: 1 }, { maxGross: 1, now: 0 });
  assert.deepEqual(g.weights, { A: 1 });
  assert.deepEqual(
    g.violations.map((v) => v.kind),
    ["OFF_MANDATE", "GROSS_LIMIT"],
  );
  tree.revoke("fund.eth");
  const r = preTradeCheck(tree, "pm.fund.eth", { A: 0.5 }, { maxGross: 1, now: 0 });
  assert.deepEqual(r.weights, {});
  assert.deepEqual(r.clipped, { A: 0.5 }, "track record keeps accruing on the clipped book");
});
