/**
 * `fund-snapshot.json` (npm run demo:fund) must load in the fund console: the
 * committed file passes the boundary parser, malformed input fails with a
 * path, and the console's view-model (folded log, tree replay, ladder replay)
 * agrees with the data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FundSnapshotError, parseFundSnapshot, type FundSnapshot } from "./fund/types";
import {
  buildLog,
  entryAgents,
  evidenceRows,
  filterLog,
  groupCutStats,
  ladderAt,
  maxAgentBudget,
  parseMove,
  replayIndexAt,
  stateAtIndex,
  treeRows,
  usdCompact,
} from "./fund/model";
import { isConsoleAlias, parseConsoleHash } from "./fund/hash";
import type { LoopEvidence } from "./fund/types";

const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL("../public/fund-snapshot.json", import.meta.url), "utf8")) as Record<string, unknown>;

const load = (): FundSnapshot => parseFundSnapshot(raw());

test("the committed fund-snapshot.json parses and is labelled a virtual world", () => {
  const s = load();
  assert.equal(s.simulated, true);
  assert.ok(s.world.seed >= 1 && s.world.seed < 10_000, "research seed only");
  assert.match(s.world.seedRule, /smallest research seed/);
  assert.equal(s.books.center.nav.length, s.world.ticks);
  assert.ok(s.agents.length > 0);
  assert.ok(s.world.operators.some((o) => o.agents.length > 1), "an operator runs two agents");
  assert.ok(s.evidence.loops.length >= 1);
});

test("parseFundSnapshot rejects malformed input with the JSON path", () => {
  assert.throws(() => parseFundSnapshot(null), FundSnapshotError);
  assert.throws(() => parseFundSnapshot({ ...raw(), simulated: false }), /simulated: expected true/);
  assert.throws(() => parseFundSnapshot({ ...raw(), schema: "fund-snapshot/0" }), /schema/);

  const sealed = raw();
  (sealed.world as Record<string, unknown>).seed = 10_001;
  assert.throws(() => parseFundSnapshot(sealed), /world\.seed: expected research seed/);

  const shortNav = raw();
  ((shortNav.books as Record<string, Record<string, unknown>>).center!).nav = [1, 2];
  assert.throws(() => parseFundSnapshot(shortNav), /books\.center\.nav: expected \d+ entries, got 2/);

  const badAgent = raw();
  ((badAgent.agents as Array<Record<string, unknown>>)[0]!).status = "slashed";
  assert.throws(() => parseFundSnapshot(badAgent), /agents\[0\]\.status: expected active \| cut \| stopped/);

  const badState = raw();
  ((badState.treeStates as Array<Record<string, unknown>>)[0]!).budget = [1];
  assert.throws(() => parseFundSnapshot(badState), /treeStates\[0\]\.budget: expected \d+ entries/);

  const badTree = raw();
  (badTree.treeNodes as string[]).reverse();
  assert.throws(() => parseFundSnapshot(badTree), /treeNodes: must list tree\.nodes/);
});

test("parseFundSnapshot validates the policy fields the console reads", () => {
  // Without this, a file missing `policy` passed the parser and then crashed
  // the render (snapshot.policy.center.leverage), blanking the whole page.
  const noPolicy = raw();
  delete noPolicy.policy;
  assert.throws(() => parseFundSnapshot(noPolicy), /policy: expected object, got undefined/);

  const noCenter = raw();
  noCenter.policy = { baseline: { leverage: 2 } };
  assert.throws(() => parseFundSnapshot(noCenter), /policy\.center: expected object/);

  const badLeverage = raw();
  ((badLeverage.policy as Record<string, Record<string, unknown>>).center!).leverage = "2";
  assert.throws(() => parseFundSnapshot(badLeverage), /policy\.center\.leverage: expected finite number, got string/);

  const noCutFactor = raw();
  delete ((noCutFactor.policy as Record<string, Record<string, unknown>>).center!).cutFactor;
  assert.throws(() => parseFundSnapshot(noCutFactor), /policy\.center\.cutFactor: expected finite number/);

  const badStatus = raw();
  (((badStatus.evidence as Record<string, unknown>).loops as Array<Record<string, unknown>>)[0]!).statuses = { "winner-A": "one" };
  assert.throws(() => parseFundSnapshot(badStatus), /statuses\.winner-A: expected finite number/);
});

test("the log folds routine moves: one grant, one entry per rebalance tick", () => {
  const s = load();
  const log = buildLog(s);
  const grants = log.filter((e) => e.type === "grant");
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.type === "grant" && grants[0]!.agents, s.decisionCounts.ALLOCATE);
  const reTicks = new Set(s.decisions.filter((d) => d.kind === "REALLOCATE").map((d) => d.t));
  const rebalances = log.filter((e) => e.type === "rebalance");
  assert.equal(rebalances.length, reTicks.size);
  const moves = rebalances.reduce((n, e) => n + (e.type === "rebalance" ? e.moves.length : 0), 0);
  assert.equal(moves, s.decisionCounts.REALLOCATE);
  assert.equal(filterLog(log, "group").length, s.groupCuts.length);
  // "Shared operator (flagged)": one-trade (CLONES) cuts only. Book-wide caps
  // that happened to sweep up both agents of an operator are not counted.
  const sameOp = filterLog(log, "operator");
  assert.equal(sameOp.length, s.groupCuts.filter((g) => g.kind === "CLONES" && g.sharedOperators.length > 0).length);
  assert.ok(sameOp.length > 0 && sameOp.every((e) => e.type === "group" && e.cut.kind === "CLONES" && e.cut.sharedOperators.length > 0));
  assert.equal(filterLog(log, "stopout").length, s.stopOuts.length);
  assert.ok(filterLog(log, "key").every((e) => e.type !== "rebalance"));
  // Log order follows the decisions.
  const ts = log.map((e) => e.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  // Group entries carry their members for highlighting.
  const g = log.find((e) => e.type === "group")!;
  assert.ok(entryAgents(g).length >= 1);
});

test("parseMove reads reallocation amounts", () => {
  assert.deepEqual(parseMove("533333 → 612345 USDC (sharpe 1.2)"), { from: 533333, to: 612345 });
  assert.deepEqual(parseMove("something else"), { from: null, to: null });
});

test("group cut stats split one-trade from book-wide cuts", () => {
  const s = load();
  const st = groupCutStats(s.groupCuts);
  assert.equal(st.total, s.groupCuts.length);
  assert.equal(st.oneTrade + st.bookWide + s.groupCuts.filter((g) => g.kind === "OTHER").length, st.total);
  assert.ok(st.oneTradeSharedOperator <= st.oneTrade);
  assert.equal(st.oneTradeSharedOperator, filterLog(buildLog(s), "operator").length);
});

test("tree replay: the index the console uses maps every decision to its own tick", () => {
  const s = load();
  // Index 0 is the tree at grant; the last index is the end of the run.
  assert.equal(stateAtIndex(s, 0), s.treeAtGrant);
  assert.equal(stateAtIndex(s, -3), s.treeAtGrant);
  assert.equal(stateAtIndex(s, s.treeStates.length), s.treeStates.at(-1));
  assert.equal(stateAtIndex(s, s.treeStates.length + 5), s.treeStates.at(-1), "clamped");
  assert.equal(stateAtIndex(s, s.treeStates.length).t, s.world.ticks - 1);
  assert.equal(replayIndexAt(s, -1), 0);
  // Selecting any log entry (FundConsole.onSelect) replays the tree on that
  // entry's own day, never a neighbour's.
  for (const e of buildLog(s)) {
    const i = replayIndexAt(s, e.t);
    assert.ok(i >= 1, `${e.id} has a recorded state`);
    assert.equal(stateAtIndex(s, i).t, e.t, e.id);
  }
  // Between decision ticks the latest earlier state is shown.
  const a = s.treeStates[1]!;
  const b = s.treeStates[2];
  if (b && b.t > a.t + 1) assert.equal(stateAtIndex(s, replayIndexAt(s, a.t + 1)), a);
});

test("agent bars share one scale: the largest mandate any agent held", () => {
  const s = load();
  const max = maxAgentBudget(s);
  const idx = s.agents.map((a) => s.treeNodes.indexOf(a.name));
  const all = [s.treeAtGrant, ...s.treeStates].flatMap((st) => idx.map((i) => st.budget[i]!));
  assert.equal(max, Math.max(...all));
  assert.ok(max > s.treeAtGrant.budget[idx[0]!]!, "some agent grew past its grant");
  assert.ok(max < s.world.aum);
});

test("evidence rows plot only merged, confirmed changes", () => {
  const s = load();
  const u = (mean: number) => ({ mean, lo: mean - 0.01, hi: mean + 0.01, wins: 0.5 });
  const unmerged: LoopEvidence = {
    loop: 9,
    title: null,
    note: null,
    blocks: { A: { from: 19000, count: 200 }, B: { from: 19500, count: 200 } },
    candidates: 1,
    statuses: { "winner-A": 1 },
    merged: [],
    confirmed: false,
    blockA: null,
    // A report can carry block B for a winner that FAILED it; it must not plot.
    blockB: { allocator: u(-0.004), tiger: u(0) },
    headVsBaseline: null,
  };
  const rows = evidenceRows([...s.evidence.loops, unmerged]);
  assert.ok(rows.every((r) => !r.key.startsWith("9")), "the unmerged loop is not plotted");
  const confirmed = s.evidence.loops.filter((l) => l.confirmed);
  assert.equal(rows.length, confirmed.reduce((n, l) => n + (l.blockA ? 1 : 0) + (l.blockB ? 1 : 0), 0));
  assert.deepEqual(evidenceRows([unmerged]), []);
});

test("console links: aliases set the log filter or the replay; plain ids pass through", () => {
  assert.deepEqual(parseConsoleHash("#fc-log-rebalance"), { id: "fc-log", filter: "rebalance" });
  assert.deepEqual(parseConsoleHash("#fc-log-group"), { id: "fc-log", filter: "group" });
  assert.deepEqual(parseConsoleHash("#fc-tree-grant"), { id: "fc-tree", replay: "grant" });
  assert.deepEqual(parseConsoleHash("#fc-evidence"), { id: "fc-evidence" });
  assert.deepEqual(parseConsoleHash("fund-console"), { id: "fund-console" });
  assert.equal(parseConsoleHash(""), null);
  assert.equal(parseConsoleHash("#"), null);
  assert.equal(isConsoleAlias("#fc-log-rebalance"), true);
  assert.equal(isConsoleAlias("#fc-log"), false);
});

test("ladder replay ends where the book ended, and closed agents are revoked in the final tree", () => {
  const s = load();
  const end = ladderAt(s, s.world.ticks - 1);
  for (const a of s.agents) assert.equal(end.get(a.name), a.status, a.label);
  assert.ok([...ladderAt(s, -1).values()].every((v) => v === "active"));
  const idx = new Map(s.treeNodes.map((n, i) => [n, i]));
  const final = s.treeStates.at(-1)!;
  for (const a of s.agents) assert.equal(final.revoked[idx.get(a.name)!], a.status === "stopped", a.label);
});

test("treeRows orders fund, then each pod followed by its agents", () => {
  const s = load();
  const rows = treeRows(s);
  assert.equal(rows[0]!.depth, 0);
  assert.equal(rows.length, s.tree.nodes.length);
  assert.equal(rows.filter((r) => r.depth === 2).length, s.agents.length);
  let pod: string | null = null;
  for (const r of rows.slice(1)) {
    if (r.depth === 1) pod = r.pod;
    else assert.equal(r.pod, pod, `${r.label} listed under its pod`);
  }
});

test("usdCompact", () => {
  assert.equal(usdCompact(10_000_000), "10.00M");
  assert.equal(usdCompact(854_489), "854K");
  assert.equal(usdCompact(1_500), "1.5K");
  assert.equal(usdCompact(-800), "−800");
});
