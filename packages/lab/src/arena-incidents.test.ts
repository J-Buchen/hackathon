/**
 * The operator record on randomized arena worlds (clones under two names run
 * by one operator, herders, a rogue, crowd crashes): every stop-out reaches
 * the book's IncidentSink exactly once, keyed by the agent's operator, and a
 * book that reports to a sink trades bit-for-bit like the book the arena
 * scores (which passes no sink), so the arena's utility cannot move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCenterBookPolicy, defaultNaivePolicy, runBook, type BookResult, type StopOutIncident } from "@allowance/swarm";
import { makeWorld } from "./arena";

const sameBook = (a: BookResult, b: BookResult, what: string) => {
  assert.equal(a.nav.length, b.nav.length);
  a.nav.forEach((x, t) => assert.ok(Object.is(x, b.nav[t]), `${what}: nav at tick ${t}`));
  a.returns.forEach((x, t) => assert.ok(Object.is(x, b.returns[t]), `${what}: return at tick ${t}`));
  a.crowdExposure.forEach((x, t) => assert.ok(Object.is(x, b.crowdExposure[t]), `${what}: crowd exposure at tick ${t}`));
  assert.deepEqual(a.decisions, b.decisions, what);
  assert.deepEqual(a.agents.map((x) => [x.capital, x.pnl, x.ladder]), b.agents.map((x) => [x.capital, x.pnl, x.ladder]), what);
};

let stopOuts = 0;
let sharedOperatorStops = 0;
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`arena world ${seed}: one incident per stop-out, keyed by operator; the book is bit-identical with and without a sink`, async () => {
    const world = makeWorld(seed);
    for (const policy of [defaultCenterBookPolicy(), defaultNaivePolicy()]) {
      const incidents: StopOutIncident[] = [];
      const reported = await runBook(world.market, world.swarm(), policy, { incidents: { record: (i) => void incidents.push(i) } });
      const scored = await runBook(world.market, world.swarm(), policy);
      sameBook(reported, scored, `${policy.kind} world ${seed}`);

      const stops = reported.decisions.filter((d) => d.kind === "STOP_OUT");
      assert.equal(incidents.length, stops.length);
      const byAgent = new Map(reported.agents.map((a) => [a.name, a]));
      stops.forEach((d, k) => {
        const i = incidents[k]!;
        const agent = byAgent.get(d.node)!;
        assert.equal(i.kind, "stop-out");
        assert.equal(i.agent, d.node);
        assert.equal(i.tick, d.t);
        assert.ok(agent.operator, "every arena agent has an operator");
        assert.equal(i.operator, agent.operator);
        assert.equal(agent.ladder, "stopped");
        // After its close the agent runs nothing: what the close freed was all it had.
        assert.equal(agent.capital[d.t + 1] ?? 0, 0);
      });
      assert.equal(new Set(incidents.map((i) => i.agent)).size, incidents.length, "no agent reported twice");
      stopOuts += incidents.length;
      const names = new Map<string, number>();
      for (const a of reported.agents) names.set(a.operator!, (names.get(a.operator!) ?? 0) + 1);
      sharedOperatorStops += incidents.filter((i) => names.get(i.operator!)! > 1).length;
    }
  });
}

test("those worlds stopped agents out, including names of operators running two", () => {
  assert.ok(stopOuts >= 20, `stop-outs: ${stopOuts}`);
  assert.ok(sharedOperatorStops >= 1, `stop-outs of a two-name operator: ${sharedOperatorStops}`);
});
