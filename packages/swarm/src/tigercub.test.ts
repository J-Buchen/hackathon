import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BALANCED_STYLE,
  TigerCubStrategy,
  catalystTicks,
  dateToTick,
  parseExpected,
  pickTrade,
  scoreCandidates,
  type Candidate,
  type TrendThesis,
} from "./tigercub";

// Fictional companies: these tests exercise the process, not the research.
const cand = (
  ticker: string,
  scores: [number, number, number],
  trendExposure = 4,
  catalysts: Candidate["whyNow_q"]["catalysts"] = [],
): Candidate => ({
  ticker,
  company: `${ticker} Inc.`,
  trendExposure,
  company_q: { score: scores[0], evidence: [] },
  management_q: { score: scores[1], evidence: [] },
  whyNow_q: { score: scores[2], evidence: [], catalysts },
  keyRisk: "",
});

const THESIS: TrendThesis = {
  asOf: "2026-09-25",
  trend: { name: "Rising widget consumption", thesis: "", evidence: [] },
  candidates: [
    // Great company, great team — but no reason it works NOW.
    cand("NOCAT", [5, 5, 2]),
    // Yes to all three.
    cand("WIN", [4, 4, 5], 5, [
      { event: "Investor day", expected: "2026-11-10" },
      { event: "Q1 earnings", expected: "2027-02" },
      { event: "Undated", expected: null },
    ]),
    cand("OK", [3, 3, 3]),
    // Rides the trend, bad company and bad management: the short.
    cand("LOSER", [2, 2, 3], 4),
    // Fails questions but barely exposed to the trend: not a pair hedge.
    cand("OFFTREND", [1, 1, 1], 1),
  ],
};

test("a long must answer yes to all three questions — a great company with no catalyst is not enough", () => {
  const idea = pickTrade(THESIS, BALANCED_STYLE);
  assert.equal(idea.long?.ticker, "WIN");
  assert.notEqual(idea.long?.ticker, "NOCAT");
  const nocat = scoreCandidates(THESIS, BALANCED_STYLE).find((c) => c.ticker === "NOCAT")!;
  assert.deepEqual(nocat.failed, ["whyNow"]);
  assert.equal(nocat.conviction, 0);
});

test("the short is the weakest trend-exposed name that fails a question", () => {
  const idea = pickTrade(THESIS, BALANCED_STYLE);
  assert.equal(idea.short?.ticker, "LOSER");
  assert.match(idea.rationale.join("\n"), /SHORT LOSER .*fails "Is this a good company\?" and "Is this a good management team\?"/);
});

test("no candidate clears the bar → no long (cash is a position)", () => {
  const idea = pickTrade({ ...THESIS, candidates: [cand("A", [2, 5, 5]), cand("B", [5, 2, 5])] });
  assert.equal(idea.long, null);
});

test("PM style changes the ranking but never waives the three-question gate", () => {
  const style = { ...BALANCED_STYLE, weights: { company: 0.8, management: 0.1, whyNow: 0.1 } };
  const ranked = scoreCandidates(THESIS, style);
  assert.equal(ranked[0]!.ticker, "NOCAT", "company-heavy PM ranks NOCAT first…");
  assert.equal(pickTrade(THESIS, style).long?.ticker, "WIN", "…but still cannot own it");
});

test("catalyst calendar maps dated catalysts onto trading-day ticks", () => {
  const start = new Date(Date.UTC(2026, 8, 25));
  assert.equal(parseExpected("2027-02")!.toISOString().slice(0, 10), "2027-02-15");
  assert.equal(parseExpected("soon"), null);
  assert.equal(dateToTick(new Date(Date.UTC(2027, 8, 25)), start), 252);
  const ticks = catalystTicks(THESIS.candidates[1]!.whyNow_q.catalysts, start, 260);
  assert.equal(ticks.length, 2, "undated catalyst dropped");
  assert.ok(ticks[0]! > 0 && ticks[0]! < ticks[1]!);
});

test("TigerCubStrategy: long the pick, short the loser, full size into catalysts, gross ≤ 1", async () => {
  const start = new Date(Date.UTC(2026, 8, 25));
  const s = new TigerCubStrategy(THESIS, BALANCED_STYLE, start, 260);
  const [investorDay] = catalystTicks(THESIS.candidates[1]!.whyNow_q.catalysts, start, 260);
  const obs = (t: number, universe = ["WIN", "LOSER", "OK"]) => ({ t, universe, history: [], carry: {}, viralSignal: null });
  const quiet = await s.decide(obs(0));
  const loaded = await s.decide(obs(investorDay! - 2));
  assert.ok(quiet.WIN! > 0 && quiet.LOSER! < 0);
  assert.ok(loaded.WIN! > quiet.WIN!, "sizes up ahead of the catalyst");
  for (const w of [quiet, loaded]) {
    assert.ok(Object.values(w).reduce((a, x) => a + Math.abs(x), 0) <= 1 + 1e-12);
  }
  // Pick not in the mandate → no trade at all.
  assert.deepEqual(await s.decide(obs(0, ["OK"])), {});
});
