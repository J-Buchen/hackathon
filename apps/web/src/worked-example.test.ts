/**
 * The worked example (swarm-snapshot.json, npm run demo:swarm): the committed
 * file parses, malformed sweep numbers fail with their path, and the result the
 * section states is derived from the sweep, not written by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSwarmSnapshot, type SweepView } from "./swarm/types";
import { TOLERANCE, workedExampleVerdict } from "./swarm/verdict";

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../public/swarm-snapshot.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("the committed swarm-snapshot.json parses", () => {
  const s = parseSwarmSnapshot(raw());
  assert.ok(s.sweep.seeds >= 1);
  assert.ok(s.thesis && s.thesis.pms.length === 3, "three Tiger-Cub PMs");
  assert.ok(s.thesis.pms.every((p) => p.long === s.thesis!.pms[0]!.long), "they converge on one long");
});

test("parseSwarmSnapshot rejects missing or non-finite sweep numbers with the path", () => {
  const noSeeds = raw();
  delete (noSeeds.sweep as Record<string, unknown>).seeds;
  assert.throws(() => parseSwarmSnapshot(noSeeds), /missing or invalid sweep\.seeds/);

  const nanDD = raw();
  ((nanDD.sweep as Record<string, Record<string, unknown>>).centerMean!).maxDrawdown = null;
  assert.throws(() => parseSwarmSnapshot(nanDD), /missing or invalid sweep\.centerMean\.maxDrawdown/);

  const strSharpe = raw();
  ((strSharpe.sweep as Record<string, Record<string, unknown>>).naiveMean!).sharpe = "0.5";
  assert.throws(() => parseSwarmSnapshot(strSharpe), /missing or invalid sweep\.naiveMean\.sharpe/);
});

test("the committed result is derived from the committed sweep, whatever it says", () => {
  // packages/swarm changes from loop to loop and `npm run demo:swarm`
  // regenerates the sweep, so this checks that the words follow the committed
  // numbers rather than pinning today's outcome.
  const s = parseSwarmSnapshot(raw());
  const v = workedExampleVerdict(s.sweep);
  const by = Object.fromEntries(v.items.map((i) => [i.key, i]));
  assert.equal(v.seeds, s.sweep.seeds);
  const c = s.sweep.centerMean;
  const g = s.sweep.naiveMean;
  const tone = (center: number, guardrails: number, tol: number, higherIsBetter: boolean) =>
    Math.abs(center - guardrails) < tol ? "even" : center > guardrails === higherIsBetter ? "good" : "bad";
  assert.equal(by.maxDrawdown!.tone, tone(c.maxDrawdown, g.maxDrawdown, TOLERANCE.maxDrawdown, false));
  assert.equal(by.crashWindowReturn!.tone, tone(c.crashWindowReturn, g.crashWindowReturn, TOLERANCE.crashWindowReturn, true));
  assert.equal(by.sharpe!.tone, tone(c.sharpe, g.sharpe, TOLERANCE.sharpe, true));
  assert.equal(by.totalReturn!.tone, tone(c.totalReturn, g.totalReturn, TOLERANCE.totalReturn, true));
  // "About equal" is said only inside the tolerance; outside it a worse number is a cost ("bad"), never "even".
  for (const i of v.items) assert.equal(i.word === "About equal", i.tone === "even", i.key);
  // The printed numbers are the sweep's means.
  assert.equal(by.maxDrawdown!.center, `${(c.maxDrawdown * 100).toFixed(1)}%`);
  assert.equal(by.maxDrawdown!.guardrails, `${(g.maxDrawdown * 100).toFixed(1)}%`);
});

test("the words follow the numbers in every direction", () => {
  const book = (o: Partial<SweepView["centerMean"]>): SweepView["centerMean"] => ({
    totalReturn: 0.05,
    sharpe: 0.5,
    maxDrawdown: 0.08,
    crashWindowReturn: -0.05,
    peakCrowdExposure: 0.5,
    stopOuts: 5,
    ...o,
  });
  const sweep = (center: Partial<SweepView["centerMean"]>): SweepView => ({
    seeds: 20,
    centerWinsDrawdown: 10,
    centerWinsSharpe: 10,
    naiveMean: book({}),
    centerMean: book(center),
  });
  const words = (c: Partial<SweepView["centerMean"]>) =>
    Object.fromEntries(workedExampleVerdict(sweep(c)).items.map((i) => [i.key, `${i.word}/${i.tone}`]));

  assert.deepEqual(words({ maxDrawdown: 0.1, crashWindowReturn: -0.07, sharpe: 0.3, totalReturn: 0.08 }), {
    maxDrawdown: "Higher/bad",
    crashWindowReturn: "Bigger loss/bad",
    sharpe: "Lower/bad",
    totalReturn: "Higher/good",
  });
  // Inside the tolerance it reads "about equal", not a win.
  assert.deepEqual(
    words({ maxDrawdown: 0.08 + TOLERANCE.maxDrawdown / 2, sharpe: 0.5 + TOLERANCE.sharpe / 2 }),
    { maxDrawdown: "About equal/even", crashWindowReturn: "About equal/even", sharpe: "About equal/even", totalReturn: "About equal/even" },
  );
  // A gain in the unwind window is "better", not a "smaller loss".
  const gain = workedExampleVerdict({ ...sweep({ crashWindowReturn: 0.02 }), naiveMean: book({ crashWindowReturn: 0.01 }) });
  assert.equal(gain.items.find((i) => i.key === "crashWindowReturn")!.word, "Better");
});
