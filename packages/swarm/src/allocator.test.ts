import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegationTree } from "@allowance/core";
import {
  allocate,
  capShares,
  CEILING_SLACK,
  cutToCeiling,
  defaultCenterBookPolicy,
  nextCounterpartyCaps,
  nextLadderState,
  scaleLadder,
  scanCrowding,
  type CounterpartyAgent,
} from "./allocator";
import { preTradeCheck } from "./gate";
import {
  annualVol,
  correlation,
  cosineSimilarity,
  currentDrawdown,
  isNewHigh,
  maxDrawdown,
  sharpe,
  volAtHighWater,
} from "./stats";
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

test("allocate: scores use a year of record, so one lucky quarter does not outrank a persistent edge", () => {
  const policy = { ...defaultCenterBookPolicy(), maxAgentShare: 1 };
  assert.equal(policy.recordWindow, 252);
  // n ticks alternating between two returns (mean (up + down) / 2).
  const alt = (n: number, first: number, second: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? first : second));
  // An edge that held for 160 ticks and went flat for the last 90, and an agent
  // flat for 160 ticks whose last 90 happened to be as good as the other's edge.
  const persistent = [...alt(160, 0.006, -0.003), ...alt(90, 0.004, -0.004)];
  const lucky = [...alt(160, -0.004, 0.004), ...alt(90, -0.003, 0.006)];
  const agents = [
    { name: "persistent", unitReturns: persistent, stopped: false, ladderMultiplier: 1 },
    { name: "lucky", unitReturns: lucky, stopped: false, ladderMultiplier: 1 },
  ];
  const share = (out: ReturnType<typeof allocate>, name: string) => out.find((s) => s.name === name)!.share;
  const year = allocate(agents, 1_000_000, policy);
  assert.ok(share(year, "persistent") > 0.6, `the year of record backs the persistent edge (${share(year, "persistent").toFixed(2)})`);
  assert.ok(share(year, "lucky") > 0, "the recent run still counts, as a quarter of the evidence");
  // Judged on a trailing 90-tick window, the same records see only the lucky quarter.
  const trailing = allocate(agents, 1_000_000, { ...policy, recordWindow: 90 });
  assert.equal(share(trailing, "persistent"), 0);
  assert.equal(share(trailing, "lucky"), 1);
});

test("allocate: an agent's share is the same whatever the size of the book it runs (Sharpe, not Sharpe ÷ vol)", () => {
  const policy = { ...defaultCenterBookPolicy(), maxAgentShare: 1 };
  const a = noise(21, 200, 0.001);
  const b = noise(22, 200, 0.0008);
  const c = noise(23, 200, 0.0012);
  const run = (ka: number, kc: number) =>
    allocate(
      [
        { name: "a", unitReturns: a.map((x) => ka * x), stopped: false, ladderMultiplier: 1 },
        { name: "b", unitReturns: b, stopped: false, ladderMultiplier: 1 },
        { name: "c", unitReturns: c.map((x) => kc * x), stopped: false, ladderMultiplier: 1 },
      ],
      1_000_000,
      policy,
    );
  const base = run(1, 1);
  // Agent a runs half the risk and c three times the risk on the same record of decisions.
  const rescaled = run(0.5, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(base[i]!.share - rescaled[i]!.share) < 1e-9, `${base[i]!.name}: same evidence, same share`);
    assert.ok(Math.abs(base[i]!.sharpe - rescaled[i]!.sharpe) < 1e-9);
  }
  assert.ok(Math.abs(rescaled[0]!.vol / base[0]!.vol - 0.5) < 1e-9, "the vol did change");
  assert.ok(base.every((s) => s.share > 0));
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

test("volAtHighWater: the risk run up to the last peak, not the losses since", () => {
  const calm = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.006 : -0.004));
  const before = volAtHighWater(calm, 90);
  assert.ok(before > 0.07 && before < 0.09, `≈8% annual vol, got ${before}`);
  // A crash after the peak does not move the yardstick…
  assert.equal(volAtHighWater([...calm, -0.3], 90), before);
  // …though it would dominate a trailing estimate.
  assert.ok(annualVol([...calm, -0.3]) > 0.5);
  // The window is counted back from the peak (calm's last peak is its 59th tick).
  assert.equal(volAtHighWater([-0.05, 0.05, ...calm], 59), before);
  assert.ok(volAtHighWater([-0.05, 0.05, ...calm], 61) > 0.1, "a wider window reaches the swing");
  // Never above water → no measured risk.
  assert.equal(volAtHighWater([-0.01, -0.02, 0.005], 90), 0);
  assert.equal(volAtHighWater([], 90), 0);
});

test("risk-scaled ladder: a drawdown is judged against the vol the agent runs, between the fixed rungs and a ceiling", () => {
  const rungs = { ddStop: 0.2, ddCut: 0.1, ddRecover: 0.05, ddStopVol: 1.5, volWindow: 90, ddStopMax: 0.4 };
  const swing = (up: number, down: number) => Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? up : -down));
  const loss = [-0.1, -0.1, -0.08]; // a 25.5% drawdown
  // ~22% annual vol: the stop sits at 1.5σ ≈ 33%, under the ceiling.
  const mid = [...swing(0.016, 0.012), ...loss];
  const v = scaleLadder(mid, rungs);
  assert.ok(v.vol > 0.2 && v.vol < 0.25, `≈22% vol, got ${v.vol}`);
  assert.ok(Math.abs(v.ddStop - 1.5 * v.vol) < 1e-12, "stop at 1.5σ");
  assert.ok(Math.abs(v.ddCut! / v.ddStop - 0.5) < 1e-12 && Math.abs(v.ddRecover! / v.ddStop - 0.25) < 1e-12, "rungs keep their proportions");
  assert.equal(nextLadderState("active", mid, rungs), "cut", "cut, not revoked: 25% is 1.1σ for this book");
  assert.equal(nextLadderState("active", mid, { ddStop: 0.2, ddCut: 0.1 }), "stopped", "the fixed stop-loss revokes it");
  // ~48% vol would put 1.5σ at 72%: the ceiling holds the stop at 40%, the other rungs in proportion.
  const wild = [...swing(0.032, 0.028), ...loss];
  const w = scaleLadder(wild, rungs);
  assert.ok(w.vol > 0.45, `≈48% vol, got ${w.vol}`);
  assert.equal(w.scale, 2);
  assert.deepEqual([w.ddStop, w.ddCut, w.ddRecover], [0.4, 0.2, 0.1]);
  assert.equal(nextLadderState("active", wild, rungs), "cut");
  assert.equal(nextLadderState("active", [...wild, -0.1, -0.1], rungs), "stopped", "a 40% drawdown stops even the wildest book");
  // Without an explicit ceiling the default is twice the stop-loss.
  assert.equal(scaleLadder(wild, { ...rungs, ddStopMax: undefined }).ddStop, 0.4);
  // A ceiling at or above 100% could never fire, so it is refused.
  assert.throws(() => scaleLadder(mid, { ...rungs, ddStopMax: 1 }), /below 100%/);
  // Same drawdown on a calm book (~8% vol) is ~3σ: the fixed floor applies and it is stopped.
  const calm = [...swing(0.006, 0.004), ...loss];
  const c = scaleLadder(calm, rungs);
  assert.equal(c.scale, 1);
  assert.deepEqual([c.ddStop, c.ddCut, c.ddRecover], [0.2, 0.1, 0.05]);
  assert.equal(nextLadderState("active", calm, rungs), "stopped");
  // A single crash cannot loosen its own limit: σ is measured up to the peak.
  const crash = [...calm.slice(0, 60), -0.3];
  assert.equal(scaleLadder(crash, rungs).scale, 1);
  assert.equal(nextLadderState("active", crash, rungs), "stopped");
  // σ from a short record can be huge (two lucky days), but the ceiling still binds.
  const lucky = [0.25, 0.02, ...Array.from({ length: 50 }, () => -0.012)];
  assert.equal(scaleLadder(lucky, rungs).scale, 2);
  assert.equal(nextLadderState("active", lucky, rungs), "stopped", "a 45% drawdown is past any ceiling");
  // Off switch and final revocation.
  assert.equal(scaleLadder(wild, { ...rungs, ddStopVol: 0 }).scale, 1);
  assert.equal(nextLadderState("stopped", [0.5], rungs), "stopped");
  // Every agent stays stoppable: across random records of any vol the scaled
  // rungs dominate the fixed ones and the stop never passes the ceiling.
  for (let seed = 1; seed <= 60; seed++) {
    const r = noise(seed, 120, 0.001).map((x) => x * (1 + (seed % 6) * 2));
    const s = scaleLadder(r, rungs);
    assert.ok(s.scale >= 1 && s.scale <= 2 && s.ddStop >= 0.2 && s.ddStop <= 0.4 && s.ddCut! >= 0.1 && s.ddRecover! >= 0.05);
  }
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

/* ------------------------------------------------------------------ */
/* Counterparties: one operator, one credit event                      */
/* ------------------------------------------------------------------ */

test("isNewHigh: only a strict new high-water mark, just earned", () => {
  assert.equal(isNewHigh([]), false);
  assert.equal(isNewHigh([0.01]), true);
  assert.equal(isNewHigh([-0.01]), false);
  assert.equal(isNewHigh([0.1, -0.05, 0.02]), false, "still below the old peak");
  assert.equal(isNewHigh([0.1, -0.05, 0.06]), true);
  assert.equal(isNewHigh([0.1, 0]), false, "flat at the old peak has not earned anything");
});

test("counterparty caps: a stop-out caps the operator's other live names; caps are not stacked, never stop anyone, and lift on a recovery", () => {
  const agents = (over: Record<string, Partial<CounterpartyAgent>> = {}): CounterpartyAgent[] =>
    [
      { name: "x1", operator: "X", ladder: "stopped" as const, unitReturns: [0.01, -0.3] },
      { name: "x2", operator: "X", ladder: "active" as const, unitReturns: [0.02, -0.01] },
      { name: "x3", operator: "X", ladder: "cut" as const, unitReturns: [-0.15] },
      { name: "x0", operator: "X", ladder: "stopped" as const, unitReturns: [-0.4] },
      { name: "y", operator: "Y", ladder: "active" as const, unitReturns: [0.01] },
      { name: "z", ladder: "active" as const, unitReturns: [0.01] },
    ].map((a) => ({ ...a, ...over[a.name] }));

  // x1 is stopped out at t = 10 (x0 was stopped long ago): every other LIVE X name is capped.
  const first = nextCounterpartyCaps(new Map(), agents(), ["x1"], [], 10);
  assert.deepEqual(first.capped, [
    { name: "x2", after: "x1" },
    { name: "x3", after: "x1" },
  ]);
  assert.deepEqual([...first.caps.keys()], ["x2", "x3"], "other operators and unlabelled names are untouched");

  // A cap never lifts on the tick it was set, nor without a recovery.
  const same = nextCounterpartyCaps(first.caps, agents({ x2: { unitReturns: [0.02, -0.01, 0.5] } }), [], ["x3"], 10);
  assert.deepEqual([...same.caps.keys()], ["x2", "x3"]);
  const partial = nextCounterpartyCaps(first.caps, agents({ x2: { unitReturns: [0.02, -0.01, 0.005] } }), [], [], 11);
  assert.deepEqual(partial.lifted, [], "a partial recovery has not re-earned the capital");
  // x2 makes a strict new high; x3's own ladder lifts its cut: each cap lifts on its own record.
  const high = nextCounterpartyCaps(first.caps, agents({ x2: { unitReturns: [0.02, -0.01, 0.02] } }), [], [], 11);
  assert.deepEqual(high.lifted, ["x2"]);
  assert.deepEqual([...high.caps.keys()], ["x3"]);
  const restored = nextCounterpartyCaps(first.caps, agents({ x3: { ladder: "active" } }), [], ["x3"], 11);
  assert.deepEqual(restored.lifted, ["x3"]);

  // A second stop-out of the same operator does not stack a cap on a capped name...
  const again = nextCounterpartyCaps(first.caps, agents({ x3: { ladder: "stopped" } }), ["x3"], [], 12);
  assert.deepEqual(again.capped, [], "x2 is already capped");
  assert.deepEqual(again.caps.get("x2"), { after: "x1", since: 10 });
  assert.ok(!again.caps.has("x3"), "a stopped name leaves the caps");
  // ...but caps a name whose cap had lifted.
  const recapped = nextCounterpartyCaps(high.caps, agents({ x3: { ladder: "stopped" } }), ["x3"], [], 12);
  assert.deepEqual(recapped.capped, [{ name: "x2", after: "x3" }]);
  // An unlabelled name's stop-out caps no one.
  assert.equal(nextCounterpartyCaps(new Map(), agents({ z: { ladder: "stopped" } }), ["z"], [], 5).caps.size, 0);
});

test("cutToCeiling: a cut decided on capital — cutting twice never goes below cutFactor × full size", () => {
  const full = 1_000_000;
  assert.equal(cutToCeiling(full, full, 0.5), 500_000, "a name at full size is cut to the ceiling");
  assert.equal(cutToCeiling(1.08 * full, full, 0.5), 500_000, "from above its full size too");
  assert.equal(cutToCeiling(500_000, full, 0.5), null, "already at the ceiling (e.g. cut by its ladder): no write");
  assert.equal(cutToCeiling(500_000 * (1 + CEILING_SLACK / 2), full, 0.5), null, "a rounding unit above is at it");
  assert.equal(cutToCeiling(200_000, full, 0.5), null, "below it (crowding, a small allocation): left there");
  assert.equal(cutToCeiling(0, 0, 0.5), null);
  // In either order, a ladder cut (capital × cutFactor) and an operator cut end at the ceiling, not cutFactor².
  const operatorFirst = cutToCeiling(full, full, 0.5)!;
  assert.equal(cutToCeiling(operatorFirst, full, 0.5), null);
  const ladderFirst = 0.5 * full;
  assert.equal(cutToCeiling(ladderFirst, full, 0.5), null);
});

test("allocate: a ladder cut and an operator cap are one ceiling — the target takes the smaller multiplier, never the product", () => {
  const policy = { ...defaultCenterBookPolicy(), warmup: 50, maxAgentShare: 1 };
  const r = noise(6, 20);
  const out = allocate(
    [
      { name: "both", unitReturns: r, stopped: false, ladderMultiplier: 0.5, counterpartyMultiplier: 0.5 },
      { name: "ladder", unitReturns: r, stopped: false, ladderMultiplier: 0.5 },
      { name: "operator", unitReturns: r, stopped: false, ladderMultiplier: 1, counterpartyMultiplier: 0.5 },
      { name: "neither", unitReturns: r, stopped: false, ladderMultiplier: 1 },
      { name: "gone", unitReturns: r, stopped: true, ladderMultiplier: 1 },
    ],
    1000,
    policy,
  );
  const by = Object.fromEntries(out.map((s) => [s.name, s]));
  for (const n of ["both", "ladder", "operator", "neither"]) assert.ok(Math.abs(by[n]!.fullTarget - 250) < 1e-9, `${n}: full size`);
  assert.ok(Math.abs(by.both!.target - 125) < 1e-9, `both: ${by.both!.target}, not 62.5`);
  assert.ok(Math.abs(by.ladder!.target - 125) < 1e-9);
  assert.ok(Math.abs(by.operator!.target - 125) < 1e-9);
  assert.ok(Math.abs(by.neither!.target - 250) < 1e-9);
  assert.equal(by.gone!.fullTarget, 0);
});
