import { test } from "node:test";
import assert from "node:assert/strict";
import { COFFEE_THESIS } from "./theses/coffee";
import { BALANCED_STYLE, TigerCubStrategy, parseExpected, pickTrade } from "./tigercub";
import { defaultMarketConfig, defaultSwarm, thesisEvents } from "./swarm";
import { headToHead } from "./evaluate";

test("coffee thesis: every score is 1–5, every trend claim is sourced, every catalyst date parses", () => {
  const t = COFFEE_THESIS;
  assert.match(t.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(t.trend.evidence.length >= 3, "at least three pieces of trend evidence");
  for (const e of t.trend.evidence) {
    assert.ok(e.url && /^https?:\/\//.test(e.url), `trend claim without a source URL: ${e.claim}`);
  }
  assert.ok(t.candidates.length >= 4);
  const tickers = new Set<string>();
  for (const c of t.candidates) {
    assert.ok(!tickers.has(c.ticker), `duplicate ticker ${c.ticker}`);
    tickers.add(c.ticker);
    for (const q of [c.company_q, c.management_q, c.whyNow_q]) {
      assert.ok(Number.isInteger(q.score) && q.score >= 1 && q.score <= 5, `${c.ticker} score out of range`);
      assert.ok(q.evidence.length > 0, `${c.ticker}: an answer with no evidence`);
    }
    assert.ok(c.trendExposure >= 1 && c.trendExposure <= 5);
    assert.ok(c.keyRisk.length > 0, `${c.ticker}: no key risk`);
    for (const cat of c.whyNow_q.catalysts) {
      if (cat.expected !== null) assert.ok(parseExpected(cat.expected), `${c.ticker}: bad date ${cat.expected}`);
    }
  }
});

test("the scorecard's long answers yes to all three questions and has dated catalysts inside the horizon", () => {
  const idea = pickTrade(COFFEE_THESIS, BALANCED_STYLE);
  assert.ok(idea.long, "a long exists");
  assert.deepEqual(idea.long!.failed, []);
  assert.ok(idea.short, "a pair-hedge short exists");
  assert.ok(idea.short!.failed.length > 0);
  const events = thesisEvents(COFFEE_THESIS, 260, true).filter((e) => e.instrument === idea.long!.ticker);
  assert.ok(events.length >= 1, "at least one of the long's catalysts falls inside the simulation");
});

test("three Tiger Cubs in three pods converge on one trade — and only the center book catches it", async () => {
  const spec = defaultSwarm();
  const cubs = spec.agents.filter((a) => a.strategy instanceof TigerCubStrategy);
  assert.equal(cubs.length, 3);
  assert.equal(new Set(cubs.map((a) => a.pod)).size, 3);
  const longs = new Set(cubs.map((a) => (a.strategy as TigerCubStrategy).idea.long?.ticker));
  assert.equal(longs.size, 1, "different question weightings, same stock");

  const h = await headToHead(defaultMarketConfig());
  const hotel = h.market.config.crowd.instrument;
  assert.equal(hotel, [...longs][0]);
  assert.equal(h.naive.decisions.filter((d) => d.kind === "CROWDING_CUT").length, 0);
  const first = h.center.decisions.find((d) => d.kind === "CROWDING_CUT" && d.detail.includes(hotel));
  assert.ok(first && first.t <= 1, "the hotel is flagged on day one, not after the unwind");
  assert.ok(h.centerSummary.peakCrowdExposure < h.naiveSummary.peakCrowdExposure);
  assert.ok(h.centerSummary.crashWindowReturn > h.naiveSummary.crashWindowReturn);
});
