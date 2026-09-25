/**
 * (C) A stop-out closes the agent's whole subtree, and (R) the tree's
 * reservation invariants hold at every tick of a book, checked here from the
 * outside (the `onTick` seam) rather than trusted to the book's own audit.
 * Each test names the guarantee it pins; each fails if that guarantee breaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttenuationError, DelegationTree, pay, type PaymentAdapters } from "@allowance/core";
import { defaultCenterBookPolicy, defaultNaivePolicy, type AllocationPolicy, type LadderState } from "./allocator";
import { applyTargets, BookInvariantError, bookViolations, runBook, sharePpm, tickToUnix, type BookResult, type SwarmSpec } from "./book";
import { generateMarket, genericMarketConfig, type Market } from "./market";
import { MeanReversionStrategy, NoiseStrategy, TrendStrategy, type Strategy, type Weights, type Observation } from "./strategies";

const FUND = "fund.eth";
const AUM = 10_000_000;
const AUM_UNITS = 10_000_000_000000n;
const TURN = 80;
const DOOMED = `doomed.systematic.${FUND}`;

/**
 * The seed-7 generic market with GOLD's path scripted: a steady, low-vol
 * run-up until TURN (the allocator sizes a GOLD holder up), then a 2%-a-day
 * slide (its drawdown ladder must stop it out). Scripting the market rather
 * than the agent keeps every agent here point-in-time: none reads a tick it
 * has not seen.
 */
function scriptedMarket(): Market {
  const m = generateMarket(genericMarketConfig(7));
  m.ticks.forEach((tick, t) => {
    tick.returns.GOLD = t < TURN ? 0.004 + (t % 2 === 0 ? 0.002 : -0.002) : -0.02;
  });
  return m;
}
const market = scriptedMarket();
const T = market.ticks.length;

/** Always long GOLD: sized up on the run-up, stopped out on the slide. */
class LongGold implements Strategy {
  readonly style = "long-gold";
  decide(): Weights {
    return { GOLD: 0.5 };
  }
}

function subSwarm(): SwarmSpec {
  const all = [...market.instruments];
  return {
    principal: "alice",
    fund: FUND,
    aum: AUM,
    pods: [
      { label: "systematic", instruments: all },
      { label: "macro", instruments: all },
    ],
    agents: [
      {
        label: "doomed",
        pod: "systematic",
        instruments: all,
        strategy: new LongGold(),
        subMandates: [
          { label: "exec", share: 0.3 },
          { label: "data", share: 0.02, instruments: ["GOLD"] },
        ],
      },
      {
        label: "trend",
        pod: "systematic",
        instruments: all,
        strategy: new TrendStrategy(30),
        subMandates: [{ label: "exec", share: 0.5 }],
      },
      { label: "meanrev", pod: "macro", instruments: all, strategy: new MeanReversionStrategy(3) },
      { label: "noise", pod: "macro", instruments: all, strategy: new NoiseStrategy(5) },
    ],
  };
}

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

/** The slice rule, restated independently: ppm parts per million of a budget, rounded down. */
const slice = (budget: bigint, ppm: bigint) => (budget * ppm) / 1_000_000n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

interface CloseRecord {
  name: string;
  t: number;
  nodes: number;
  budget: bigint;
  spent: bigint;
  podAvailable: bigint;
  freed: bigint;
  podAvailableAfter: bigint;
}

interface Watch {
  book: BookResult;
  closes: CloseRecord[];
  bareRevokes: string[];
  /** ATTENUATION_REJECTED events this test provoked itself (probing dead nodes). */
  probesRejected: number;
  ticksChecked: number;
  /** Tick × sub-mandate pairs whose slice was checked exactly / as a bound. */
  slicesExact: number;
  slicesBounded: number;
}

/**
 * Run a book whose sub-mandates spend every tick, and check the tree from the
 * outside at the start of every tick (= the end of the previous one):
 *
 *  - reservation: spent + Σ children ≤ budget and available ≥ 0 for every
 *    node; the root never changes;
 *  - sub-mandates are slices: a live one never holds more than its share of
 *    its agent's budget (or what it committed, if more), and holds exactly
 *    that whenever the agent has unreserved authority left;
 *  - a closed subtree can never spend again: once a node is dead its budget
 *    is frozen, it has 0 available, and pay / delegate / resize are refused;
 *  - every stop-out is ONE tree.close (spied) that frees budget − spent, all of
 *    it landing in the pod; no bare revoke is ever used.
 *
 * `spend(sub, available)` is what a live sub-mandate pays each tick.
 */
async function watch(
  policy: AllocationPolicy,
  spec: SwarmSpec = subSwarm(),
  spend: (sub: string, available: bigint) => bigint = (sub) => (sub.startsWith("data.") ? 25_000000n : 100_000000n),
): Promise<Watch> {
  const ppmOf = new Map<string, bigint>();
  for (const a of spec.agents) {
    for (const sm of a.subMandates ?? []) ppmOf.set(`${sm.label}.${a.label}.${a.pod}.${FUND}`, sharePpm(sm.share));
  }
  const closes: CloseRecord[] = [];
  const bareRevokes: string[] = [];
  const frozen = new Map<string, bigint>();
  const w = { probesRejected: 0, ticksChecked: 0, slicesExact: 0, slicesBounded: 0 };
  let now = 0;
  let tick = 0;

  const check = async (tree: DelegationTree, t: number) => {
    w.ticksChecked++;
    assert.equal(tree.requireNode(FUND).mandate.budget, AUM_UNITS, `t=${t}: root authority changed`);
    for (const n of tree.listNodes()) {
      const handedDown = tree.childrenOf(n.name).reduce((s, c) => s + c.mandate.budget, 0n);
      assert.ok(n.mandate.spentDirect + handedDown <= n.mandate.budget, `t=${t}: ${n.name} children + spend exceed its budget`);
      assert.ok(tree.available(n.name) >= 0n, `t=${t}: ${n.name} over-committed`);
    }
    for (const [sub, ppm] of ppmOf) {
      if (tree.isRevokedInChain(sub)) continue;
      const agent = tree.requireNode(sub).parent!;
      const s = tree.requireNode(sub).mandate;
      const committed = s.spentDirect + tree.reserved(sub);
      const want = max(committed, slice(tree.requireNode(agent).mandate.budget, ppm));
      assert.ok(s.budget >= committed, `t=${t}: ${sub} below what it committed`);
      if (tree.available(agent) > 0n) {
        assert.equal(s.budget, want, `t=${t}: ${sub} is not its ${ppm} ppm slice of ${agent}`);
        w.slicesExact++;
      } else {
        assert.ok(s.budget <= want, `t=${t}: ${sub} holds more than its ${ppm} ppm slice of ${agent}`);
        w.slicesBounded++;
      }
    }
    for (const n of tree.listNodes()) {
      if (!tree.isRevokedInChain(n.name)) continue;
      const was = frozen.get(n.name);
      if (was === undefined) frozen.set(n.name, n.mandate.budget);
      else assert.equal(n.mandate.budget, was, `t=${t}: closed ${n.name} budget moved`);
      assert.equal(tree.available(n.name), 0n, `t=${t}: closed ${n.name} still holds authority`);
      const r = await pay(tree, { node: n.name, merchant: "GOLD", amount: 1n }, allowAll, { now });
      assert.equal(r.outcome, "REVOKED", `t=${t}: closed ${n.name} could pay`);
      const refused = (e: unknown) => e instanceof AttenuationError && e.reason === "PARENT_REVOKED";
      const late = { budget: 0n, allowedMerchants: ["GOLD"], expiry: now + 1 };
      assert.throws(() => tree.delegate(n.name, `late${t}`, late), refused, `t=${t}: ${n.name} could delegate`);
      assert.throws(() => tree.resize(n.name, n.mandate.budget + 1n), refused, `t=${t}: ${n.name} could grow`);
      w.probesRejected += 2;
    }
  };

  const book = await runBook(market, spec, policy, {
    onTick: async (t, tree) => {
      now = tickToUnix(t);
      tick = t;
      if (t === 0) {
        const close = tree.close.bind(tree);
        tree.close = (name: string) => {
          const node = tree.requireNode(name);
          const pod = node.parent!;
          // The subtree by name (ENS-style: descendants end in ".<name>"),
          // independent of the tree's own subtree helpers.
          const under = tree.listNodes().filter((n) => n.name === name || n.name.endsWith(`.${name}`));
          const before = {
            nodes: under.length,
            budget: node.mandate.budget,
            spent: under.reduce((s, n) => s + n.mandate.spentDirect, 0n),
            podAvailable: tree.available(pod),
          };
          const freed = close(name);
          closes.push({ name, t: tick, ...before, freed, podAvailableAfter: tree.available(pod) });
          return freed;
        };
        const revoke = tree.revoke.bind(tree);
        tree.revoke = (name: string) => {
          bareRevokes.push(name);
          return revoke(name);
        };
      }
      await check(tree, t);
      for (const sub of ppmOf.keys()) {
        if (tree.isRevokedInChain(sub)) continue;
        const available = tree.available(sub);
        const amount = spend(sub, available);
        if (amount <= 0n || amount > available) continue;
        const r = await pay(tree, { node: sub, merchant: "GOLD", amount }, allowAll, { now });
        assert.equal(r.outcome, "SETTLED", `${sub} could not pay at t=${t}`);
      }
    },
  });
  await check(book.tree, T);
  return { book, closes, bareRevokes, ...w };
}

const withCut = defaultCenterBookPolicy();
const noCut = { ...defaultCenterBookPolicy(), ddCut: undefined, cutFactor: undefined, ddRecover: undefined };
const policies: [string, AllocationPolicy][] = [
  ["center book (default, with the cut rung)", withCut],
  ["center book without a cut rung", noCut],
  ["per-agent guardrails", defaultNaivePolicy()],
];

for (const [label, policy] of policies) {
  test(`${label}: tree invariants hold at every tick, and every stop-out is one close`, async () => {
    const w = await watch(policy);
    const { book, closes } = w;
    assert.equal(w.ticksChecked, T + 1);
    const stopped = book.agents.filter((a) => a.ladder === "stopped").map((a) => a.name);
    assert.ok(stopped.includes(DOOMED), "the doomed agent is stopped out");
    assert.deepEqual(closes.map((c) => c.name).sort(), [...stopped].sort(), "each stopped agent closed exactly once");
    assert.deepEqual(w.bareRevokes, [], "no stop-out is a bare revoke");
    for (const c of closes) {
      assert.equal(c.freed, c.budget - c.spent, `${c.name}: freed authority == budget - spent`);
      assert.equal(c.podAvailableAfter - c.podAvailable, c.freed, `${c.name}: all of it lands in the pod`);
    }
    // The book itself never attempted an invalid move; the only rejections are this test's probes.
    const rejected = book.tree.events.filter((e) => e.result === "ATTENUATION_REJECTED").length;
    assert.equal(rejected, w.probesRejected);
    assert.ok(w.probesRejected >= 100, `dead nodes were probed (${w.probesRejected})`);
    assert.ok(w.slicesExact >= 200, `sub-mandate slices were checked exactly (${w.slicesExact})`);
    // The cut rung fires only when the policy has one, and it resizes the sub-mandates with the agent.
    const cuts = book.decisions.filter((d) => d.kind === "CUT");
    if (policy.kind === "center" && policy.ddCut !== undefined) assert.ok(cuts.some((d) => d.node === DOOMED));
    else assert.deepEqual(cuts, []);
  });
}

test("the doomed agent's stop-out takes back its capital AND both sub-mandates in one operation", async () => {
  const { book, closes } = await watch(defaultCenterBookPolicy());
  const tree = book.tree;
  const c = closes.find((x) => x.name === DOOMED)!;
  assert.ok(c.t > TURN, "stopped on the slide");
  assert.equal(c.nodes, 3, "the agent and its two sub-mandates");
  assert.ok(c.budget - c.spent >= 200_000_000000n, `it was stopped holding real capital (${c.budget - c.spent})`);
  assert.ok(c.spent > 0n, "its sub-mandates had spent something");
  assert.ok(c.freed > 0n);

  // What is left: every node holds exactly what it spent, nothing more.
  for (const n of tree.subtree(DOOMED)) {
    assert.equal(tree.available(n.name), 0n, n.name);
    assert.equal(n.mandate.budget, tree.spentInSubtree(n.name), `${n.name} kept only what it spent`);
  }
  assert.equal(tree.isClosed(DOOMED), true);
  assert.ok(tree.requireNode(`exec.${DOOMED}`).mandate.spentDirect > 0n);
  assert.ok(tree.requireNode(`data.${DOOMED}`).mandate.spentDirect > 0n);

  // One REVOKE, carrying the freed amount, preceded only by the close's own shrinks.
  const revokes = tree.events.filter((e) => e.type === "REVOKE" && e.node === DOOMED);
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0]!.amount, c.freed);
  const at = tree.events.indexOf(revokes[0]!);
  assert.deepEqual(
    tree.events.slice(at - 3, at).map((e) => [e.type, e.node]),
    [
      ["RESIZE", `exec.${DOOMED}`],
      ["RESIZE", `data.${DOOMED}`],
      ["RESIZE", DOOMED],
    ],
  );
  const stop = book.decisions.find((d) => d.kind === "STOP_OUT" && d.node === DOOMED)!;
  assert.match(stop.detail, /mandate closed with its 2 sub-mandates/);

  // A closed agent runs no capital from then on (its budget is only the record of what was spent).
  const agent = book.agents.find((a) => a.name === DOOMED)!;
  assert.ok(tree.requireNode(DOOMED).mandate.budget > 0n);
  assert.ok(agent.capital.slice(c.t + 1).every((x) => x === 0));
  assert.ok(agent.pnl.slice(c.t + 1).every((x) => x === 0));
});

test("sub-mandates are reserved out of the agent's budget when granted, and shares must fit in whole ppm", async () => {
  const book = await runBook(market, subSwarm(), defaultNaivePolicy(), {
    onTick: (t, tree) => {
      if (t !== 0) return;
      const agent = tree.requireNode(DOOMED).mandate.budget;
      assert.equal(tree.requireNode(`exec.${DOOMED}`).mandate.budget, slice(agent, 300_000n));
      assert.equal(tree.requireNode(`data.${DOOMED}`).mandate.budget, slice(agent, 20_000n));
      assert.equal(tree.available(DOOMED), agent - slice(agent, 300_000n) - slice(agent, 20_000n));
      assert.deepEqual(tree.requireNode(`data.${DOOMED}`).mandate.allowedMerchants, ["GOLD"]);
    },
  });
  assert.equal(book.nav.length, T);

  const withShares = (...shares: number[]) => {
    const spec = subSwarm();
    spec.agents[0]!.subMandates = shares.map((share, i) => ({ label: `s${i}`, share }));
    return spec;
  };
  await assert.rejects(runBook(market, withShares(0.7, 0.4), defaultNaivePolicy()), /sum to 1100000 ppm/);
  await assert.rejects(runBook(market, withShares(-0.1), defaultNaivePolicy()), /not in \[0, 1\]/);
  await assert.rejects(runBook(market, withShares(Number.NaN), defaultNaivePolicy()), /not in \[0, 1\]/);
  // Each share rounds UP to 333,334 ppm: the float sum is 1, but the slices would not fit.
  await assert.rejects(runBook(market, withShares(0.3333335, 0.3333335, 0.333333), defaultNaivePolicy()), /sum to 1000001 ppm/);
  // Exactly the whole budget in ppm is allowed, and the agent keeps what rounding leaves.
  const full = await runBook(market, withShares(0.333334, 0.333333, 0.333333), defaultNaivePolicy(), {
    onTick: (t, tree) => {
      if (t !== 0) return;
      assert.ok(tree.available(DOOMED) >= 0n);
      assert.equal(tree.childrenOf(DOOMED).length, 3);
    },
  });
  assert.equal(full.nav.length, T);
});

/** Records the last tick it was asked to decide, and can act on the tree mid-tick. */
class Spy implements Strategy {
  readonly style = "spy";
  lastDecided = -1;
  tree: DelegationTree | null = null;
  constructor(private readonly midTick?: (t: number, tree: DelegationTree) => void) {}
  decide(obs: Observation): Weights {
    this.lastDecided = obs.t;
    if (this.tree) this.midTick?.(obs.t, this.tree);
    return {};
  }
}

function spiedSwarm(spy: Spy): SwarmSpec {
  const spec = subSwarm();
  spec.agents.push({ label: "spy", pod: "macro", instruments: [...market.instruments], strategy: spy });
  return spec;
}

test("no tick trades on a tree that fails the audit: a break from outside is caught before the tick trades", async () => {
  // Someone writes a pod's budget below what it handed to its agents.
  const spy = new Spy();
  await assert.rejects(
    runBook(market, spiedSwarm(spy), defaultCenterBookPolicy(), {
      onTick: (t, tree) => {
        if (t === 40) tree.requireNode(`macro.${FUND}`).mandate.budget = 0n;
      },
    }),
    (e: unknown) =>
      e instanceof BookInvariantError &&
      e.t === 40 &&
      e.at === "start" &&
      e.violations.some((v) => v.startsWith(`OVER_COMMITTED macro.${FUND}`)),
  );
  assert.equal(spy.lastDecided, 39, "no agent was asked to trade on the broken tree");

  // A sub-mandate is revoked without being closed: its budget would sit dead in the agent.
  const spy2 = new Spy();
  await assert.rejects(
    runBook(market, spiedSwarm(spy2), defaultCenterBookPolicy(), {
      onTick: (t, tree) => {
        if (t === 40) tree.revoke(`exec.${DOOMED}`);
      },
    }),
    (e: unknown) =>
      e instanceof BookInvariantError && e.t === 40 && e.at === "start" && e.violations.some((v) => v.startsWith(`NOT_CLOSED exec.${DOOMED}`)),
  );
  assert.equal(spy2.lastDecided, 39);

  // Closing it instead is sound: the book keeps running.
  const ok = await runBook(market, subSwarm(), defaultCenterBookPolicy(), {
    onTick: (t, tree) => {
      if (t === 40) tree.close(`exec.${DOOMED}`);
    },
  });
  assert.equal(ok.nav.length, T);
});

test("a break made during a tick (an agent's sub-mandate revoked mid-tick) is caught at that tick's end", async () => {
  const spy = new Spy((t, tree) => {
    if (t === 40) tree.revoke(`exec.${DOOMED}`);
  });
  await assert.rejects(
    runBook(market, spiedSwarm(spy), defaultNaivePolicy(), {
      onTick: (t, tree) => {
        spy.tree = tree;
      },
    }),
    (e: unknown) =>
      e instanceof BookInvariantError && e.t === 40 && e.at === "end" && e.violations.some((v) => v.startsWith(`NOT_CLOSED exec.${DOOMED}`)),
  );
  assert.equal(spy.lastDecided, 40, "the break happened inside tick 40, and tick 41 never started");
});

test("bookViolations names every broken guarantee, and nothing on a sound tree", () => {
  const build = () => {
    const tree = new DelegationTree();
    tree.fundRoot({ principal: "p", rootName: FUND, mandate: { budget: 1_000n, expiry: 10_000 } });
    tree.delegate(FUND, "pod", { budget: 600n, expiry: 10_000 });
    tree.delegate(`pod.${FUND}`, "a", { budget: 300n, expiry: 10_000 });
    tree.delegate(`pod.${FUND}`, "b", { budget: 200n, expiry: 10_000 });
    tree.delegate(`a.pod.${FUND}`, "exec", { budget: 100n, expiry: 10_000 });
    return tree;
  };
  const root = { name: FUND, budget: 1_000n };
  const A = `a.pod.${FUND}`;
  const B = `b.pod.${FUND}`;
  const agents = (a: LadderState, b: LadderState) => [
    { name: A, ladder: a },
    { name: B, ladder: b },
  ];
  const kinds = (v: string[]) => v.map((x) => x.split(":")[0]);

  const sound = build();
  assert.deepEqual(bookViolations(sound, root, agents("active", "cut")), []);
  sound.close(A);
  assert.deepEqual(bookViolations(sound, root, agents("stopped", "active")), [], "a closed, stopped agent is sound");

  // (R) the root's authority changed.
  const grown = build();
  grown.requireNode(FUND).mandate.budget = 2_000n;
  assert.deepEqual(kinds(bookViolations(grown, root, agents("active", "active"))), [`ROOT_CHANGED ${FUND}`]);

  // (R) over-commitment, via the core audit.
  const over = build();
  over.requireNode(`pod.${FUND}`).mandate.budget = 400n;
  assert.deepEqual(kinds(bookViolations(over, root, agents("active", "active"))), [`OVER_COMMITTED pod.${FUND}`]);

  // (C) a bare revoke strands the authority left under the node.
  const stranded = build();
  stranded.revoke(A);
  assert.deepEqual(kinds(bookViolations(stranded, root, agents("stopped", "active"))), [`NOT_CLOSED ${A}`]);

  // (C) the ladder says stopped but the mandate is live.
  const notRevoked = build();
  assert.deepEqual(kinds(bookViolations(notRevoked, root, agents("stopped", "active"))), [`STOP_NOT_REVOKED ${A}`]);

  // (C) a live agent under a closed node.
  const deadPod = build();
  deadPod.close(`pod.${FUND}`);
  assert.deepEqual(kinds(bookViolations(deadPod, root, agents("stopped", "active"))), [`LIVE_BUT_REVOKED ${B}`]);
});

test("(R) a desk that spent its whole slice pins its agent at what was spent; the book keeps running on a sound tree", async () => {
  // Every agent hands 95% of its budget to an execution desk that spends
  // everything it is given, every tick. Spent authority cannot be taken back,
  // so reallocations and crowding cuts meet floors they must not cross.
  const spec = subSwarm();
  for (const a of spec.agents) a.subMandates = [{ label: "exec", share: 0.95 }];
  const w = await watch(defaultCenterBookPolicy(), spec, (_sub, available) => available);
  assert.equal(w.book.nav.length, T, "the book ran to the end");
  assert.equal(
    w.book.tree.events.filter((e) => e.result === "ATTENUATION_REJECTED").length,
    w.probesRejected,
    "no move of the book's was refused",
  );
  assert.ok(w.slicesBounded > 0, "agents were held at their floors");
  assert.ok(w.slicesExact > 0);
});

test("(R) a grow never reserves authority its parent does not hold: it is clipped, and the desks are cut from what the agent got", async () => {
  const tree = new DelegationTree();
  const E = 10_000;
  tree.fundRoot({ principal: "p", rootName: FUND, mandate: { budget: 1_000n, expiry: E } });
  const P1 = `p1.${FUND}`;
  const P2 = `p2.${FUND}`;
  const A = `a.${P1}`;
  const B = `b.${P1}`;
  const C = `c.${P2}`;
  tree.delegate(FUND, "p1", { budget: 600n, expiry: E });
  tree.delegate(FUND, "p2", { budget: 390n, expiry: E });
  tree.delegate(P1, "a", { budget: 300n, expiry: E });
  tree.delegate(P1, "b", { budget: 300n, expiry: E });
  tree.delegate(P2, "c", { budget: 390n, expiry: E });
  tree.delegate(A, "exec", { budget: 150n, expiry: E });
  tree.delegate(B, "exec", { budget: 150n, expiry: E });
  // a's desk spends its whole slice: that authority is gone for good.
  assert.equal((await pay(tree, { node: `exec.${A}`, merchant: "m", amount: 150n }, allowAll, { now: 1 })).outcome, "SETTLED");
  const budget = (n: string) => tree.requireNode(n).mandate.budget;
  const podOf = new Map([
    [A, P1],
    [B, P1],
    [C, P2],
  ]);
  const subsOf = new Map([
    [A, [{ name: `exec.${A}`, ppm: 500_000n }]],
    [B, [{ name: `exec.${B}`, ppm: 500_000n }]],
  ]);

  // The allocator asks for 100 / 600 / 390. a cannot go below the 150 its desk
  // spent, so only 1000 − 150 − 390 = 460 is left in the fund for b.
  applyTargets(tree, podOf, subsOf, new Map([[A, 100n], [B, 600n], [C, 390n]]));
  assert.deepEqual(tree.events.filter((e) => e.result === "ATTENUATION_REJECTED"), [], "nothing was refused");
  assert.deepEqual(tree.audit(), []);
  assert.equal(tree.available(FUND), 0n, "the fund's whole authority is reserved or spent");
  assert.deepEqual([budget(A), budget(`exec.${A}`)], [150n, 150n], "a is held at what its desk spent");
  assert.equal(budget(B), 460n, "b got what was left, not its 600 target");
  assert.equal(budget(`exec.${B}`), 230n, "b's desk is half of what b got, not half of its target");
  assert.equal(budget(P1), 610n);
  assert.equal(budget(C), 390n);
});
