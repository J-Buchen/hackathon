/**
 * The operator record: every stop-out is reported, once, to the book's
 * `IncidentSink`, keyed by the stopped agent's operator, with the agent, the
 * tick, and exactly what the close freed; and reporting changes nothing the
 * book does. Each test fails if its guarantee breaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCenterBookPolicy, defaultNaivePolicy, type AllocationPolicy } from "./allocator";
import { runBook, STOP_OUT_INCIDENT_KIND, tickToUnix, type BookResult, type StopOutIncident, type SwarmSpec } from "./book";
import { generateMarket, genericMarketConfig, type Market } from "./market";
import { NoiseStrategy, TrendStrategy, type Strategy, type Weights } from "./strategies";

const FUND = "fund.eth";
const TURN = 80;

/** Seed-7 generic market with GOLD scripted: a calm run-up, then a 2%-a-day slide. */
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
  constructor(private readonly w = 0.5) {}
  decide(): Weights {
    return { GOLD: this.w };
  }
}

/**
 * Four GOLD holders (all doomed on the slide): two names of operator "op-a",
 * one of "op-b", one with no operator; one of op-a's holds sub-mandates, so
 * its close frees their budgets too. Two survivors of other operators.
 */
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
        label: "gold-a1",
        pod: "systematic",
        operator: "op-a",
        instruments: all,
        strategy: new LongGold(0.5),
        subMandates: [
          { label: "exec", share: 0.3 },
          { label: "data", share: 0.02, instruments: ["GOLD"] },
        ],
      },
      { label: "gold-a2", pod: "macro", operator: "op-a", instruments: all, strategy: new LongGold(0.45) },
      { label: "gold-b", pod: "macro", operator: "op-b", instruments: all, strategy: new LongGold(0.55) },
      { label: "gold-anon", pod: "systematic", instruments: all, strategy: new LongGold(0.4) },
      { label: "trend", pod: "systematic", operator: "op-c", instruments: all, strategy: new TrendStrategy(30) },
      { label: "noise", pod: "macro", operator: "op-d", instruments: all, strategy: new NoiseStrategy(5) },
    ],
  };
}

interface Run {
  book: BookResult;
  incidents: StopOutIncident[];
  /** Every tree.close the book made: node, tick, and what it returned. */
  closes: { name: string; t: number; freed: bigint }[];
}

async function run(policy: AllocationPolicy, withSink = true): Promise<Run> {
  const incidents: StopOutIncident[] = [];
  const closes: Run["closes"] = [];
  let now = -1;
  const book = await runBook(market, spec(), policy, {
    ...(withSink ? { incidents: { record: (i: StopOutIncident) => void incidents.push(i) } } : {}),
    onTick: (t, tree) => {
      now = t;
      if (t === 0) {
        const close = tree.close.bind(tree);
        tree.close = (name: string) => {
          const freed = close(name);
          closes.push({ name, t: now, freed });
          return freed;
        };
      }
    },
  });
  return { book, incidents, closes };
}

const policies: [string, AllocationPolicy][] = [
  ["center book", defaultCenterBookPolicy()],
  ["per-agent guardrails", defaultNaivePolicy()],
];

for (const [what, policy] of policies) {
  test(`${what}: every STOP_OUT is exactly one "stop-out" incident keyed by operator, with the agent, tick and freed amount`, async () => {
    const { book, incidents, closes } = await run(policy);
    const stops = book.decisions.filter((d) => d.kind === "STOP_OUT");
    assert.equal(stops.length, 4, "the four GOLD holders were stopped out");
    assert.equal(incidents.length, stops.length, "one incident per stop-out");
    assert.equal(closes.length, stops.length, "one close per stop-out");
    const operatorOf = new Map(book.agents.map((a) => [a.name, a.operator]));
    const labelOf = new Map(book.agents.map((a) => [a.name, a.label]));
    stops.forEach((d, k) => {
      const i = incidents[k]!;
      assert.equal(i.kind, STOP_OUT_INCIDENT_KIND);
      assert.equal(i.kind, "stop-out");
      assert.equal(i.agent, d.node);
      assert.equal(i.label, labelOf.get(d.node));
      assert.equal(i.tick, d.t);
      assert.equal(i.at, tickToUnix(d.t));
      assert.equal(i.operator, operatorOf.get(d.node));
      assert.equal("operator" in i, operatorOf.get(d.node) !== undefined, "no operator is reported as absent, not guessed");
      assert.equal(i.reason, d.detail);
      // What the close returned, exactly, and nothing else.
      const c = closes[k]!;
      assert.deepEqual([c.name, c.t], [d.node, d.t]);
      assert.equal(i.freedUnits, c.freed);
      assert.equal(i.freed, Number(c.freed) / 1e6);
      assert.ok(i.drawdown >= i.ddStop, `stopped at ${i.drawdown} ≥ its stop ${i.ddStop}`);
    });
    // Keyed by operator: op-a's two names give op-a two incidents.
    const byOp = new Map<string, string[]>();
    for (const i of incidents) byOp.set(i.operator ?? "(none)", [...(byOp.get(i.operator ?? "(none)") ?? []), i.label]);
    assert.deepEqual([...byOp.get("op-a")!].sort(), ["gold-a1", "gold-a2"]);
    assert.deepEqual(byOp.get("op-b"), ["gold-b"]);
    assert.deepEqual(byOp.get("(none)"), ["gold-anon"]);
    assert.equal(byOp.has("op-c") || byOp.has("op-d"), false, "operators never stopped out have no incident");
    // The agent with sub-mandates: the close freed their budgets as well.
    const a1 = incidents.find((i) => i.label === "gold-a1")!;
    assert.ok(a1.freed > 0);
    assert.equal(book.tree.subtree(a1.agent).length, 3);
  });

  test(`${what}: reporting to a sink changes nothing the book does (bit-identical)`, async () => {
    const withSink = await run(policy, true);
    const without = await run(policy, false);
    assert.equal(without.incidents.length, 0);
    assert.ok(withSink.incidents.length > 0);
    assert.equal(withSink.book.nav.length, without.book.nav.length);
    withSink.book.nav.forEach((x, t) => assert.ok(Object.is(x, without.book.nav[t]), `nav at ${t}`));
    withSink.book.returns.forEach((x, t) => assert.ok(Object.is(x, without.book.returns[t]), `return at ${t}`));
    assert.deepEqual(withSink.book.decisions, without.book.decisions);
    assert.deepEqual(
      withSink.book.agents.map((a) => [a.capital, a.pnl, a.ladder]),
      without.book.agents.map((a) => [a.capital, a.pnl, a.ladder]),
    );
    assert.deepEqual(withSink.book.tree.events, without.book.tree.events);
  });
}

test("the book awaits an asynchronous sink, in order, and a sink that throws aborts the run", async () => {
  const seen: string[] = [];
  const book = await runBook(market, spec(), defaultCenterBookPolicy(), {
    incidents: {
      record: async (i) => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`${i.tick}:${i.label}`);
      },
    },
  });
  assert.deepEqual(
    seen,
    book.decisions.filter((d) => d.kind === "STOP_OUT").map((d) => `${d.t}:${book.agents.find((a) => a.name === d.node)!.label}`),
  );
  await assert.rejects(
    runBook(market, spec(), defaultCenterBookPolicy(), {
      incidents: {
        record: () => {
          throw new Error("record unavailable");
        },
      },
    }),
    /record unavailable/,
  );
});
