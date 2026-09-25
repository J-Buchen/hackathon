import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCenterBookPolicy, defaultNaivePolicy } from "./allocator";
import { runBook, type SwarmSpec } from "./book";
import { generateMarket, genericMarketConfig } from "./market";
import { summarize } from "./evaluate";
import { HerdStrategy, NoiseStrategy, RogueStrategy, TrendStrategy, MeanReversionStrategy } from "./strategies";

// A thesis-free swarm on the generic market: three herd agents in three pods
// that follow a viral signal into MEME, plus ordinary agents around them.
function genericSwarm(): SwarmSpec {
  const all = ["ETH", "BTC", "SOL", "GOLD", "UST10Y", "EURUSD", "MEME"];
  const crypto = ["ETH", "BTC", "SOL", "MEME"];
  return {
    principal: "alice",
    fund: "fund.eth",
    aum: 10_000_000,
    pods: [
      { label: "systematic", instruments: all },
      { label: "macro", instruments: ["GOLD", "UST10Y", "EURUSD", "MEME"] },
      { label: "digital", instruments: crypto },
    ],
    agents: [
      { label: "trend", pod: "systematic", instruments: all, strategy: new TrendStrategy(30) },
      { label: "herd-a", pod: "systematic", instruments: all, strategy: new HerdStrategy(25) },
      { label: "meanrev", pod: "macro", instruments: ["GOLD", "UST10Y", "EURUSD", "MEME"], strategy: new MeanReversionStrategy(3) },
      { label: "herd-b", pod: "macro", instruments: ["GOLD", "UST10Y", "EURUSD", "MEME"], strategy: new HerdStrategy(20) },
      { label: "noise", pod: "digital", instruments: crypto, strategy: new NoiseStrategy(5) },
      { label: "herd-c", pod: "digital", instruments: crypto, strategy: new HerdStrategy(15) },
      { label: "rogue", pod: "digital", instruments: crypto, strategy: new RogueStrategy("GOLD") },
    ],
  };
}

const market = generateMarket(genericMarketConfig(7));

test("the mandate tree stays valid through every reallocation, cut and stop-out", async () => {
  const book = await runBook(market, genericSwarm(), defaultCenterBookPolicy());
  const tree = book.tree;
  for (const n of tree.listNodes()) {
    assert.ok(tree.available(n.name) >= 0n, `${n.name} over-committed`);
  }
  const root = tree.requireNode("fund.eth");
  assert.equal(root.mandate.budget, 10_000_000_000000n, "root authority never grows");
  for (const a of book.agents) {
    const node = tree.requireNode(a.name);
    if (a.ladder === "stopped") {
      assert.equal(node.mandate.revoked, true, `${a.label} stopped but not revoked`);
      assert.equal(node.mandate.budget, 0n, `${a.label} stopped but still holds budget`);
    } else {
      assert.equal(node.mandate.revoked, false);
    }
  }
  // Every allocator write is in the audited event log.
  assert.ok(tree.events.some((e) => e.type === "RESIZE" && e.result === "OK"));
  assert.ok(!tree.events.some((e) => e.result === "ATTENUATION_REJECTED"), "allocator never attempts an invalid move");
});

test("the rogue agent is clipped by the gate, and the clip is logged once", async () => {
  const book = await runBook(market, genericSwarm(), defaultNaivePolicy());
  const rogue = book.agents.find((a) => a.label === "rogue")!;
  assert.ok(rogue.gateViolations > 100);
  assert.equal(book.decisions.filter((d) => d.kind === "GATE_CLIP" && d.node === rogue.name).length, 1);
});

test("runs are deterministic", async () => {
  const a = await runBook(market, genericSwarm(), defaultCenterBookPolicy());
  const b = await runBook(market, genericSwarm(), defaultCenterBookPolicy());
  assert.deepEqual(a.nav, b.nav);
});

test("clones across pods are caught as a crowd; per-agent guardrails never see them", async () => {
  const naive = await runBook(market, genericSwarm(), defaultNaivePolicy());
  const center = await runBook(market, genericSwarm(), defaultCenterBookPolicy());
  assert.equal(naive.decisions.filter((d) => d.kind === "CROWDING_CUT").length, 0);
  const { startTick, crashTick } = market.config.crowd;
  const crowd = center.decisions.find(
    (d) => d.kind === "CROWDING_CUT" && d.detail.includes("one trade in MEME") && d.t >= startTick,
  );
  assert.ok(crowd, "center book flags the herd piling into MEME");
  assert.ok(crowd!.t < crashTick, "…before the unwind");
  assert.ok(crowd!.t - startTick <= 10, `…within days of the crowd forming (day ${crowd!.t})`);

  const n = summarize(naive, market);
  const c = summarize(center, market);
  assert.ok(c.peakCrowdExposure < n.peakCrowdExposure);
  assert.ok(c.crashWindowReturn > n.crashWindowReturn, `unwind: center ${c.crashWindowReturn} vs naive ${n.crashWindowReturn}`);
});
