/**
 * The fund console's snapshot: the seed rule, determinism, and that the
 * observed tree states agree with what the book itself reports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DelegationTree } from "@allowance/core";
import { ARENA_EVAL_FLOOR, makeWorld } from "@allowance/lab";
import { defaultCenterBookPolicy } from "@allowance/swarm";
import {
  buildFundSnapshot,
  observeBook,
  pickShowcaseSeed,
  qualifies,
  readEvidence,
  type FundSnapshot,
  type LoopEvidence,
} from "./fund";

const here = dirname(fileURLToPath(import.meta.url));
const loopsDir = resolve(here, "../../../docs/loops");

let cached: Promise<FundSnapshot> | null = null;
const snapshot = () => (cached ??= buildFundSnapshot({ loopsDir }));

test("the showcase seed is the smallest research seed that satisfies the published rule", () => {
  const seed = pickShowcaseSeed();
  assert.ok(seed >= 1 && seed < ARENA_EVAL_FLOOR);
  assert.ok(qualifies(makeWorld(seed).meta));
  for (let s = 1; s < seed; s++) assert.equal(qualifies(makeWorld(s).meta), false, `seed ${s} qualifies too`);
});

test("sealed seeds are refused", async () => {
  await assert.rejects(buildFundSnapshot({ loopsDir, seed: ARENA_EVAL_FLOOR }), /not a research seed/);
});

test("the snapshot is deterministic", async () => {
  const a = await snapshot();
  const b = await buildFundSnapshot({ loopsDir });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("series line up with the world and the tree", async () => {
  const s = await snapshot();
  const T = s.world.ticks;
  assert.equal(s.simulated, true);
  assert.equal(s.books.center.nav.length, T);
  assert.equal(s.books.baseline.nav.length, T);
  for (const a of s.agents) {
    assert.equal(a.capital.length, T, a.label);
    assert.equal(a.pnl.length, T, a.label);
  }
  assert.deepEqual(s.treeNodes, s.tree.nodes.map((n) => n.name));
  const ticks = s.treeStates.map((x) => x.t);
  assert.deepEqual(ticks, [...new Set(ticks)].sort((x, y) => x - y), "one state per tick, increasing");
  for (const d of s.decisions) assert.ok(ticks.includes(d.t), `state for decision tick ${d.t}`);
  assert.equal(ticks.at(-1), T - 1, "the final state is included");
});

test("observed tree states match the book: agent budgets are the capital it ran", async () => {
  const s = await snapshot();
  const idx = new Map(s.treeNodes.map((n, i) => [n, i]));
  // At the end of each tick an agent's budget is the capital it ran that tick,
  // unless the drawdown ladder (which runs after marking) moved it — so the
  // states were read at the right boundaries.
  const ladderMoves = new Set(s.decisions.filter((d) => d.kind === "CUT" || d.kind === "STOP_OUT").map((d) => `${d.t}|${d.node}`));
  let compared = 0;
  for (const st of s.treeStates) {
    for (const a of s.agents) {
      if (ladderMoves.has(`${st.t}|${a.name}`)) continue;
      assert.equal(st.budget[idx.get(a.name)!], a.capital[st.t], `${a.label} at tick ${st.t}`);
      compared++;
    }
  }
  assert.ok(compared > s.treeStates.length * s.agents.length * 0.9);
  // The grant: every agent holds the equal initial allocation.
  const first = s.treeAtGrant.budget[idx.get(s.agents[0]!.name)!]!;
  for (const a of s.agents) assert.equal(s.treeAtGrant.budget[idx.get(a.name)!], first, `${a.label} granted equally`);
  // End of run: closed agents hold nothing and are revoked; live ones hold what they ran last.
  const end = s.treeStates.at(-1)!;
  for (const a of s.agents) {
    const i = idx.get(a.name)!;
    assert.equal(end.revoked[i], a.status === "stopped", a.label);
    if (a.status === "stopped") assert.equal(end.budget[i], 0, a.label);
  }
  // Pods hold exactly what they delegated; the fund's budget is reserved + available.
  for (const st of [s.treeAtGrant, ...s.treeStates]) {
    const root = idx.get(s.world.fund)!;
    assert.ok(Math.abs(st.budget[root]! - st.reserved[root]! - st.available[root]! - st.spent[root]!) <= 1);
    for (const pod of s.world.pods) {
      const i = idx.get(`${pod}.${s.world.fund}`)!;
      assert.ok(Math.abs(st.budget[i]! - st.reserved[i]!) <= 1, `${pod} at ${st.t}`);
    }
  }
});

test("group cuts name their members and flag shared operators; stop-outs report the capital handed back", async () => {
  const s = await snapshot();
  assert.equal(s.groupCuts.length, s.decisionCounts.CROWDING_CUT ?? 0);
  const opOf = new Map(s.agents.map((a) => [a.label, a.operator]));
  for (const g of s.groupCuts) {
    assert.ok(g.members.length >= 1);
    for (const o of g.sharedOperators) {
      assert.ok(o.agents.length >= 2);
      for (const a of o.agents) assert.equal(opOf.get(a), o.operator);
    }
  }
  assert.ok(s.groupCuts.some((g) => g.sharedOperators.length > 0), "the rule guarantees an operator running two agents");
  assert.equal(s.stopOuts.length, s.decisionCounts.STOP_OUT ?? 0);
  for (const x of s.stopOuts) {
    assert.ok(x.freed >= 0);
    assert.equal(x.subtree[0], x.name);
    const a = s.agents.find((y) => y.name === x.name)!;
    assert.equal(a.status, "stopped");
  }
});

/* Loop reports shaped like scripts/loop-driver.mjs writes them. */
const u = (mean: number) => ({ mean, lo: mean - 0.01, hi: mean + 0.01, wins: 0.6 });
const blocks = (from: number) => ({ A: { from, count: 200 }, B: { from: from + 500, count: 200 } });
const LOOP_FIXTURES: Record<string, unknown> = {
  // Merged and confirmed on block B.
  "loop-2.json": {
    loop: 2,
    blocks: blocks(12000),
    candidates: [
      { k: 0, angle: "(A) Better sizing: detail", track: "allocator", status: "winner-A", blockA: { allocator: u(0.02), tiger: u(0) } },
      { k: 1, angle: "x", track: "structure", status: "rejected-review" },
    ],
    confirmation: {
      ok: true,
      kept: [0],
      blockB: { allocator: u(0.03), tiger: u(0) },
      booksB: {
        allocator: { utility: 0.11, sharpe: 1.2, maxDD: 0.078, baselineUtility: 0.06, baselineMaxDD: 0.069 },
        tiger: { utility: -0.07, sharpe: 0, maxDD: 0.28, baselineUtility: -0.2, baselineMaxDD: 0.44 },
      },
      // The pre-change run on the same block: its guardrails numbers match booksB's.
      baselineB: { allocator: { baseline: 0.06, baselineMaxDD: 0.069, baselineSharpe: 0.77 } },
    },
    correction: { loop2GainOnBAfterFix: { vs: "abc1234", mean: 0.025, lo: 0.015, hi: 0.035, wins: 0.58 } },
    riskSummary: {
      block: "B",
      seeds: "12500-12699",
      centerMaxDDBefore: 0.081,
      centerMaxDDAfter: 0.078,
      guardrailsMaxDD: 0.069,
      pairedChange: { mean: -0.003, lo: -0.005, hi: -0.001 },
    },
    rejections: [
      { title: "Looser crowding limits (G)", reason: "stopped by the risk guard" },
      { title: "no reason" },
      "not an object",
    ],
    merged: { kept: [0] },
  },
  // A block-A winner that FAILED block B (loop-driver.mjs:114): block B is
  // recorded, nothing is merged.
  "loop-3.json": {
    loop: 3,
    blocks: blocks(13000),
    baselineA: { allocator: { worlds: 200, utility: 0.08, baseline: 0.07, uplift: 0.01, upliftLo: null, upliftHi: 0.02, winRate: 0.6 } },
    candidates: [
      { k: 0, angle: "(G) Something: detail", track: "allocator", status: "winner-A", blockA: { allocator: u(0.01), tiger: u(0) } },
    ],
    confirmation: {
      ok: false,
      kept: [0],
      blockB: { allocator: u(-0.004), tiger: u(0) },
      booksB: { allocator: { utility: 0.1, sharpe: 1, maxDD: 0.07, baselineUtility: 0.06, baselineMaxDD: 0.069 } },
    },
    // A malformed risk summary (a number is missing) on a loop that merged nothing.
    riskSummary: { block: "B", seeds: "13500-13699", centerMaxDDBefore: 0.08, centerMaxDDAfter: null, guardrailsMaxDD: 0.07 },
    rejections: [{ title: "Something (G)", reason: "failed block B" }],
    merged: null,
  },
  // Incomplete: no block ranges.
  "loop-4.json": { loop: 4, blocks: {}, candidates: [], merged: null },
};

function fixtureDir(withCommittedLoop1: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "loops-"));
  for (const [name, body] of Object.entries(LOOP_FIXTURES)) writeFileSync(join(dir, name), JSON.stringify(body));
  if (withCommittedLoop1) copyFileSync(join(loopsDir, "loop-1.json"), join(dir, "loop-1.json"));
  return dir;
}

test("readEvidence summarizes sealed loop reports and tolerates a missing directory", () => {
  assert.deepEqual(readEvidence(join(tmpdir(), "no-such-loops-dir")), []);
  const ev = readEvidence(fixtureDir(false));
  // loop-4 has no block ranges, so it is skipped rather than written as NaN/null.
  assert.deepEqual(ev.map((l) => l.loop), [2, 3]);
  const [two, three] = ev as [LoopEvidence, LoopEvidence];
  assert.equal(two.confirmed, true);
  assert.equal(two.merged[0]!.angle, "(A) Better sizing: detail");
  assert.equal(two.blockA!.allocator.mean, 0.02);
  assert.equal(two.blockB!.allocator.mean, 0.03);
  assert.deepEqual(two.statuses, { "winner-A": 1, "rejected-review": 1 });
  assert.equal(two.headVsBaseline, null);
});

test("readEvidence never reports block B for a change that failed confirmation", () => {
  const three = readEvidence(fixtureDir(false)).find((l) => l.loop === 3)!;
  assert.equal(three.confirmed, false);
  assert.deepEqual(three.merged, []);
  assert.equal(three.blockA, null, "nothing merged, so no merged-change uplift");
  assert.equal(three.blockB, null, "block B of an unmerged change is not the merged change's evidence");
  // A baseline summary with a missing number is dropped, not written as null fields.
  assert.equal(three.headVsBaseline, null);
  // Nor are its block-B books or its drawdown summary the merged change's.
  assert.equal(three.booksB, null);
  assert.equal(three.riskSummary, null);
  assert.equal(three.correctedB, null);
  // Rejections are recorded whatever the verdict.
  assert.deepEqual(three.rejections, [{ title: "Something (G)", reason: "failed block B" }]);
});

test("readEvidence carries the drawdown summary, the rejections and the sealed books of a confirmed loop", () => {
  const two = readEvidence(fixtureDir(false)).find((l) => l.loop === 2)!;
  assert.deepEqual(two.riskSummary, {
    block: "B",
    seeds: "12500-12699",
    centerMaxDDBefore: 0.081,
    centerMaxDDAfter: 0.078,
    guardrailsMaxDD: 0.069,
    pairedChange: { mean: -0.003, lo: -0.005, hi: -0.001 },
    note: null,
  });
  // Entries without a title and a reason are dropped.
  assert.deepEqual(two.rejections, [{ title: "Looser crowding limits (G)", reason: "stopped by the risk guard" }]);
  assert.deepEqual(two.booksB, {
    block: "B",
    seeds: { from: 12500, count: 200 },
    center: { utility: 0.11, sharpe: 1.2, maxDrawdown: 0.078 },
    // booksB has no guardrails Sharpe; baselineB's is the same guardrails run, so it is used.
    guardrails: { utility: 0.06, maxDrawdown: 0.069, sharpe: 0.77 },
  });
  assert.deepEqual(two.correctedB, { uplift: { mean: 0.025, lo: 0.015, hi: 0.035, wins: 0.58 }, vs: "abc1234" });
});

test("readEvidence leaves the guardrails Sharpe null when the report cannot vouch for it", () => {
  const dir = mkdtempSync(join(tmpdir(), "loops-"));
  const body = JSON.parse(JSON.stringify(LOOP_FIXTURES["loop-2.json"])) as {
    confirmation: { baselineB: { allocator: { baseline: number } } };
  };
  // A different guardrails run (utility differs): its Sharpe is not this block's.
  body.confirmation.baselineB.allocator.baseline = 0.061;
  writeFileSync(join(dir, "loop-2.json"), JSON.stringify(body));
  const [two] = readEvidence(dir);
  assert.equal(two!.booksB!.guardrails.sharpe, null);
  assert.equal(two!.booksB!.guardrails.utility, 0.06);
});

test("the committed loop-2 evidence: the center book beats guardrails on utility but draws down more", () => {
  const two = readEvidence(loopsDir).find((l) => l.loop === 2)!;
  assert.ok(two.booksB, "docs/loops/loop-2.json confirmation.booksB");
  assert.equal(two.booksB.seeds.count, 200);
  assert.ok(two.booksB.center.utility > two.booksB.guardrails.utility);
  // The disclosure the console must not hide: mean max drawdown is still above the guardrails'.
  assert.ok(two.booksB.center.maxDrawdown > two.booksB.guardrails.maxDrawdown);
  assert.ok(two.riskSummary && two.riskSummary.centerMaxDDAfter > two.riskSummary.guardrailsMaxDD);
  assert.ok(two.riskSummary.pairedChange && two.riskSummary.pairedChange.hi < 0, "loop 2 lowered it, with a 90% interval below zero");
  assert.ok(two.rejections.length >= 1);
});

test("a snapshot built from incomplete loop reports still passes the web console's parser", async () => {
  const snap = await buildFundSnapshot({ loopsDir: fixtureDir(true) });
  const wire = JSON.parse(JSON.stringify(snap)) as unknown;
  // The console's boundary parser (apps/web/src/fund/types.ts), loaded at run
  // time so this package does not compile the web app's sources.
  const webParser = pathToFileURL(resolve(here, "../../../apps/web/src/fund/types.ts")).href;
  const { parseFundSnapshot } = (await import(webParser)) as { parseFundSnapshot: (raw: unknown) => FundSnapshot };
  const parsed = parseFundSnapshot(wire);
  assert.deepEqual(parsed.evidence.loops.map((l) => l.loop), [1, 2, 3]);
  assert.equal(parsed.evidence.loops.find((l) => l.loop === 3)!.blockB, null);

  // A CONFIRMED loop whose hand-written fields carry a value the parser refuses:
  // readEvidence drops that field (null) instead of writing a snapshot the
  // console cannot open. Each mutation of the confirmed loop-2 fixture below
  // is refused by the parser when written as is, and accepted once read.
  type Report = {
    blocks: { B: { count: number } };
    riskSummary: { centerMaxDDAfter: number; pairedChange: { mean: number; lo: number; hi: number } };
    confirmation: { booksB: { allocator: { maxDD: number } } };
    correction: { loop2GainOnBAfterFix: { mean: number; lo: number; hi: number } };
  };
  const cases: { what: string; field: keyof LoopEvidence; mutate: (r: Report) => void }[] = [
    { what: "a drawdown in percent units", field: "riskSummary", mutate: (r) => void (r.riskSummary.centerMaxDDAfter = 7.75) },
    { what: "a paired change with lo > hi", field: "riskSummary", mutate: (r) => void (r.riskSummary.pairedChange = { mean: -0.003, lo: -0.001, hi: -0.005 }) },
    { what: "block-B books with a drawdown in percent units", field: "booksB", mutate: (r) => void (r.confirmation.booksB.allocator.maxDD = 7.75) },
    { what: "a correction whose mean is outside its interval", field: "correctedB", mutate: (r) => void (r.correction.loop2GainOnBAfterFix.mean = 0.05) },
    { what: "a block of zero worlds", field: "booksB", mutate: (r) => void (r.blocks.B.count = 0) },
  ];
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "loops-"));
    const body = JSON.parse(JSON.stringify(LOOP_FIXTURES["loop-2.json"])) as Report;
    c.mutate(body);
    writeFileSync(join(dir, "loop-2.json"), JSON.stringify(body));
    const loops = readEvidence(dir);
    const two = loops.find((l) => l.loop === 2)!;
    assert.equal(two.confirmed, true, c.what);
    assert.equal(two[c.field], null, `${c.what}: ${c.field} is dropped`);
    const withLoops = JSON.parse(JSON.stringify({ ...snap, evidence: { ...snap.evidence, loops } })) as unknown;
    assert.doesNotThrow(() => parseFundSnapshot(withLoops), c.what);
    // Written as is, the same value would have made the whole console refuse the file.
    const raw = JSON.parse(JSON.stringify(readEvidence(fixtureDir(false)).find((l) => l.loop === 2))) as Record<string, unknown>;
    const bad = { ...raw };
    if (c.field === "riskSummary") bad.riskSummary = { ...body.riskSummary, note: null };
    if (c.field === "correctedB") bad.correctedB = { uplift: { ...body.correction.loop2GainOnBAfterFix, wins: 0.5 }, vs: null };
    if (c.field === "booksB") {
      const b = raw.booksB as { seeds: { count: number }; center: { maxDrawdown: number } };
      bad.booksB = {
        ...b,
        seeds: { ...b.seeds, count: body.blocks.B.count },
        center: { ...b.center, maxDrawdown: body.confirmation.booksB.allocator.maxDD },
      };
    }
    const refused = JSON.parse(JSON.stringify({ ...snap, evidence: { ...snap.evidence, loops: [bad] } })) as unknown;
    assert.throws(() => parseFundSnapshot(refused), /fund-snapshot\.json evidence\.loops\[0\]/, c.what);
  }
});

test("observeBook refuses to overlap and always restores the tree prototype", async () => {
  const original = DelegationTree.prototype.recordEvent;
  const world = makeWorld(1);
  const first = observeBook(world.market, world.swarm(), defaultCenterBookPolicy());
  const second = observeBook(world.market, world.swarm(), defaultCenterBookPolicy());
  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.match(String((b as PromiseRejectedResult).reason), /one at a time/);
  assert.equal(DelegationTree.prototype.recordEvent, original, "prototype restored");
  // And a later observation works again.
  await observeBook(world.market, world.swarm(), defaultCenterBookPolicy());
  assert.equal(DelegationTree.prototype.recordEvent, original);
});

test("the committed loop-1 evidence is read", () => {
  const ev = readEvidence(loopsDir);
  const l1 = ev.find((l) => l.loop === 1);
  assert.ok(l1, "docs/loops/loop-1.json");
  assert.equal(l1.confirmed, true);
  assert.ok(l1.blockA && l1.blockB);
  assert.ok(l1.blockB.allocator.lo > 0);
  // Its post-push correction (the 40% stop ceiling) re-measured the block-B gain lower.
  assert.ok(l1.correctedB && l1.correctedB.uplift.mean < l1.blockB.allocator.mean);
  // Paired drawdown changes were not recorded before loop 2.
  assert.ok(l1.riskSummary);
  assert.equal(l1.riskSummary.pairedChange, null);
  assert.equal(l1.booksB, null, "loop 1's report has no confirmation.booksB");
});
