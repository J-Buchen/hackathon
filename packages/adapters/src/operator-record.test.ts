/**
 * The operator record, end to end: a fund book's stop-outs are filed in the
 * adapters' IncidentLedger (through the book's IncidentSink port), keyed by
 * operator, and a NEW hire (AgentHire screening) or a NEW grant (a mandate in
 * a fund's tree) for an operator over its stop-out limit is refused, while
 * other operators are not. Nothing is sent to AgentHire's dispute or slash
 * routes. Offline: a fake fetch stands in for AgentHire.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DelegationTree } from "@allowance/core";
import {
  defaultCenterBookPolicy,
  defaultNaivePolicy,
  generateMarket,
  genericMarketConfig,
  NoiseStrategy,
  runBook,
  TrendStrategy,
  type IncidentSink,
  type Market,
  type Strategy,
  type SwarmSpec,
  type Weights,
} from "@allowance/swarm";

import {
  AgentHireClient,
  AgentHireScreeningService,
  DEFAULT_MAX_OPERATOR_STOP_OUTS,
  IncidentLedger,
  JsonFileIncidentStore,
  OperatorGrantScreen,
  OperatorRegistry,
  STOP_OUT_KIND,
  StopOutIncidentSink,
  agentHireMerchant,
  operatorRecordLimits,
  operatorRecordRefusal,
  type FetchLike,
} from "./index";

/* ------------------------------------------------------------------ */
/* A minimal AgentHire: agents, reputation, stake                      */
/* ------------------------------------------------------------------ */

const SHARED = "0xa34a8dcb86249dac8d611cfdd0713e672ba72143"; // runs agents 15 and 27
const CRAWLTECH = "0x1ce3b4044124714daa6a68b95441963679eea6ec"; // runs agent 5
const AUDITOR = "0xf5aff70e7d78473ea14f7110af047fd144f638e4"; // runs agent 7
const WALLETS = new Map<number, string>([
  [15, SHARED],
  [27, SHARED],
  [5, CRAWLTECH],
  [7, AUDITOR],
]);

function fakeAgentHire() {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/agents\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      const w = WALLETS.get(id);
      return w ? json({ id, name: `agent-${id}`, deployer_wallet: w, use_case: "x", current_price: 0.1 }) : json({ error: "agent not found" }, 404);
    }
    if (/^\/api\/agents\/\d+\/reputation$/.test(path)) return json({ score: 510, tier: 1, incidentCount: 0, simulated: true });
    if (/^\/api\/agents\/\d+\/stake$/.test(path)) return json({ stakedUSDC: "150000000", incidentCount: 0, banned: false, simulated: true });
    return json({ error: `unexpected ${path}` }, 404);
  };
  return { calls, client: new AgentHireClient("http://127.0.0.1:5055", fetch) };
}

const hire = (agentId: number) => ({ node: "buyer.eth", merchant: agentHireMerchant(agentId), amount: 1n });

/* ------------------------------------------------------------------ */
/* A book with doomed agents                                          */
/* ------------------------------------------------------------------ */

const TURN = 80;
function scriptedMarket(): Market {
  const m = generateMarket(genericMarketConfig(7));
  m.ticks.forEach((tick, t) => {
    tick.returns.GOLD = t < TURN ? 0.004 + (t % 2 === 0 ? 0.002 : -0.002) : -0.02;
  });
  return m;
}
const market = scriptedMarket();

class LongGold implements Strategy {
  readonly style = "long-gold";
  constructor(private readonly w: number) {}
  decide(): Weights {
    return { GOLD: this.w };
  }
}

/** Two GOLD holders run by `shared` (under different names), one by `other`; two survivors run by `clean`. */
function spec(ops: { shared: string; other: string; clean: string }): SwarmSpec {
  const all = [...market.instruments];
  return {
    principal: "alice",
    fund: "fund.eth",
    aum: 10_000_000,
    pods: [
      { label: "systematic", instruments: all },
      { label: "macro", instruments: all },
    ],
    agents: [
      { label: "testsmith", pod: "systematic", operator: ops.shared, instruments: all, strategy: new LongGold(0.5), subMandates: [{ label: "exec", share: 0.3 }] },
      { label: "stacktracer", pod: "macro", operator: ops.shared, instruments: all, strategy: new LongGold(0.45) },
      { label: "crawler", pod: "macro", operator: ops.other, instruments: all, strategy: new LongGold(0.55) },
      { label: "trend", pod: "systematic", operator: ops.clean, instruments: all, strategy: new TrendStrategy(30) },
      { label: "noise", pod: "macro", operator: ops.clean, instruments: all, strategy: new NoiseStrategy(5) },
    ],
  };
}

/** Operators keyed as in production: AgentSpec.operator is the operator's World ID nullifier. */
async function operatorsOf(client: AgentHireClient) {
  const registry = new OperatorRegistry();
  const shared = (await registry.bindFromAgentHire(client, 15)).worldIdNullifier;
  const other = (await registry.bindFromAgentHire(client, 5)).worldIdNullifier;
  const clean = (await registry.bindFromAgentHire(client, 7)).worldIdNullifier;
  return { registry, shared, other, clean };
}

for (const [what, policy] of [
  ["center book", defaultCenterBookPolicy()],
  ["per-agent guardrails", defaultNaivePolicy()],
] as const) {
  test(`${what}: each stop-out is filed once as a "stop-out" incident against its operator; no dispute, no slash`, async () => {
    const { calls, client } = fakeAgentHire();
    const ops = await operatorsOf(client);
    const ledger = new IncidentLedger();
    const sink = new StopOutIncidentSink({ ledger });
    const port: IncidentSink = sink; // the adapters' sink IS the book's port
    const book = await runBook(market, spec(ops), policy, { incidents: port });

    const stops = book.decisions.filter((d) => d.kind === "STOP_OUT");
    assert.equal(stops.length, 3);
    assert.equal(ledger.list().length, stops.length, "exactly one incident per stop-out");
    assert.deepEqual(sink.filed, ledger.list());
    const operatorOf = new Map(book.agents.map((a) => [a.name, a.operator!]));
    stops.forEach((d, k) => {
      const i = ledger.list()[k]!;
      assert.equal(i.kind, STOP_OUT_KIND);
      assert.equal(i.kind, "stop-out");
      assert.equal(i.operator, operatorOf.get(d.node), "keyed by the agent's operator");
      assert.equal(i.agent, d.node);
      assert.equal(i.node, d.node);
      assert.equal(i.tick, d.t);
      assert.ok(typeof i.freed === "number" && i.freed >= 0);
      assert.match(d.detail, new RegExp(`${i.freed!.toFixed(0)} USDC handed back`), "the freed amount is the close's");
      assert.match(i.reason, /a loss, not misconduct; nothing slashed/);
      assert.equal(i.agentHireReport, undefined, "never sent to AgentHire");
    });
    assert.equal(ledger.countForOperator(ops.shared), 2, "two names, one operator: two incidents on one record");
    assert.equal(ledger.countForOperator(ops.other), 1);
    assert.equal(ledger.countForOperator(ops.clean), 0);
    assert.equal(calls.filter((c) => c.includes("dispute") || c.includes("slash")).length, 0);
  });
}

test("screening refuses a NEW hire for an operator over its stop-out threshold, and not other operators", async () => {
  const { client } = fakeAgentHire();
  const ops = await operatorsOf(client);
  const ledger = new IncidentLedger();
  await runBook(market, spec(ops), defaultCenterBookPolicy(), { incidents: new StopOutIncidentSink({ ledger }) });
  assert.deepEqual([ledger.countForOperator(ops.shared), ledger.countForOperator(ops.other)], [2, 1]);

  const screen = (maxOperatorStopOuts?: number) =>
    new AgentHireScreeningService({
      client,
      operators: new OperatorRegistry(),
      incidents: ledger,
      ...(maxOperatorStopOuts === undefined ? {} : { maxOperatorStopOuts }),
    });

  // Threshold 1: the shared operator (2 stop-outs) is refused, on BOTH its names,
  // including agent 27, which was never in the book under that name.
  const strict = screen(1);
  for (const id of [15, 27]) {
    const r = await strict.screen(hire(id));
    assert.equal(r.approved, false, `agent ${id}`);
    assert.match(r.reason!, new RegExp(`^screening: operator ${SHARED} .* has 2 fund stop-out\\(s\\) \\(.*testsmith.*stacktracer.*\\) > 1 allowed`));
  }
  assert.equal((await strict.screen(hire(5))).approved, true, "one stop-out is within a threshold of 1");
  assert.equal((await strict.screen(hire(7))).approved, true, "an operator never stopped out");

  // Threshold 0: any stop-out refuses; the clean operator still passes.
  const zero = screen(0);
  assert.equal((await zero.screen(hire(5))).approved, false);
  assert.equal((await zero.screen(hire(27))).approved, false);
  assert.equal((await zero.screen(hire(7))).approved, true);

  // The default (2) accepts two; stop-outs never count against the misconduct limit (default 0).
  assert.equal(DEFAULT_MAX_OPERATOR_STOP_OUTS, 2);
  const lenient = screen();
  assert.equal((await lenient.screen(hire(27))).approved, true, (await lenient.screen(hire(27))).reason);
  assert.equal((await lenient.screen(hire(5))).approved, true);
});

test("misconduct and stop-outs are counted apart", () => {
  const base = { agentId: 0, operator: "op", deployerWallet: "", reason: "r", at: 0 };
  const stop = (n: number) => ({ ...base, id: `S${n}`, kind: STOP_OUT_KIND, agent: `a${n}` });
  const overspend = { ...base, id: "O1", kind: "mandate_overspend", agentId: 5 };
  assert.equal(operatorRecordRefusal([stop(1), stop(2)]), null, "two stop-outs: within the defaults");
  assert.match(operatorRecordRefusal([stop(1), stop(2), stop(3)])!, /has 3 fund stop-out\(s\) \(a1, a2, a3\) > 2 allowed/);
  assert.match(operatorRecordRefusal([overspend])!, /has 1 Allowance incident\(s\) \(agent 5\) > 0 allowed/);
  assert.equal(operatorRecordRefusal([overspend, stop(1)], { maxIncidents: 1, maxStopOuts: 1 }), null);
  assert.equal(operatorRecordRefusal([stop(1), stop(2)], { maxStopOuts: Infinity }), null);
  for (const bad of [-1, 0.5, Number.NaN]) {
    assert.throws(() => operatorRecordLimits({ maxStopOuts: bad }), RangeError);
    assert.throws(() => new OperatorGrantScreen({ incidents: new IncidentLedger(), maxStopOuts: bad }), RangeError);
  }
});

test("a NEW grant in a fund's tree is refused for an operator over the threshold: no node, nothing reserved", async () => {
  const ledger = new IncidentLedger();
  await runBook(market, spec({ shared: "op-shared", other: "op-other", clean: "op-clean" }), defaultCenterBookPolicy(), {
    incidents: new StopOutIncidentSink({ ledger }),
  });
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "bob", rootName: "fund2.eth", mandate: { budget: 1_000_000_000000n, expiry: 4_000_000_000 } });
  const screen = new OperatorGrantScreen({ incidents: ledger, maxStopOuts: 1 });
  const mandate = { budget: 100_000_000000n, expiry: 4_000_000_000 };
  const before = { nodes: tree.listNodes().length, available: tree.available("fund2.eth") };

  const refused = await screen.grant(tree, "fund2.eth", "newname", mandate, "op-shared");
  assert.equal(refused.granted, false);
  assert.match(refused.screening.reason!, /operator op-shared has 2 fund stop-out\(s\) .* > 1 allowed/);
  assert.equal(tree.listNodes().length, before.nodes, "no node created");
  assert.equal(tree.available("fund2.eth"), before.available, "nothing reserved");

  for (const op of ["op-other", "op-clean", "op-never-seen"]) {
    const ok = await screen.grant(tree, "fund2.eth", `pm-${op}`, mandate, op);
    assert.equal(ok.granted, true, `${op}: ${ok.screening.reason}`);
  }
  assert.equal(tree.available("fund2.eth"), before.available - 3n * mandate.budget);
  assert.equal((await screen.screen("")).approved, false, "no operator named: refused");
});

test("stop-outs filed by one process screen out the operator in another (JsonFileIncidentStore)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowance-stopouts-"));
  try {
    const file = join(dir, "incidents.json");
    const { client } = fakeAgentHire();
    const ops = await operatorsOf(client);
    await runBook(market, spec(ops), defaultNaivePolicy(), {
      incidents: new StopOutIncidentSink({ ledger: new IncidentLedger(new JsonFileIncidentStore(file)) }),
    });
    // "Another process": a fresh ledger on the same file, a fresh registry.
    const later = new IncidentLedger(new JsonFileIncidentStore(file));
    const screening = new AgentHireScreeningService({ client, operators: new OperatorRegistry(), incidents: later, maxOperatorStopOuts: 1 });
    assert.equal((await screening.screen(hire(27))).approved, false);
    assert.equal((await screening.screen(hire(5))).approved, true);
    assert.equal(later.list().length, 3);
    assert.ok(later.list().every((i) => i.kind === "stop-out" && typeof i.tick === "number" && typeof i.freed === "number" && i.agent));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the sink refuses to guess an operator, and files under a binding when one is given", async () => {
  const { client } = fakeAgentHire();
  const ops = await operatorsOf(client);
  const anon = spec(ops);
  delete anon.agents[2]!.operator; // the crawler: no operator
  await assert.rejects(
    runBook(market, anon, defaultCenterBookPolicy(), { incidents: new StopOutIncidentSink({ ledger: new IncidentLedger() }) }),
    /crawler\.macro\.fund\.eth was stopped out at tick \d+ but has no operator/,
  );

  // With a binding: the AgentHire agent id and wallet come from the registry.
  const ids = new Map([["testsmith", 15], ["stacktracer", 27], ["crawler", 5], ["trend", 7], ["noise", 7]]);
  const ledger = new IncidentLedger();
  await runBook(market, anon, defaultCenterBookPolicy(), {
    incidents: new StopOutIncidentSink({
      ledger,
      bindingOf: (i) => ops.registry.bindFromAgentHire(client, ids.get(i.label)!),
    }),
  });
  const crawler = ledger.list().find((i) => i.agent?.startsWith("crawler."))!;
  assert.deepEqual([crawler.agentId, crawler.deployerWallet, crawler.operator], [5, CRAWLTECH, ops.other]);
  assert.deepEqual(ledger.list().filter((i) => i.operator === ops.shared).map((i) => i.agentId).sort(), [15, 27]);
});
