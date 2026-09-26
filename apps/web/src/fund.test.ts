/**
 * `fund-snapshot.json` (npm run demo:fund) must load in the fund console: the
 * committed file passes the boundary parser, malformed input fails with a
 * path, and the console's view-model (folded log, tree replay, ladder replay)
 * agrees with the data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FundSnapshotError, parseFundSnapshot, type FundSnapshot } from "./fund/types";
import { Evidence } from "./fund/Evidence";
import EvidencePanel from "./fund/EvidencePanel";
import FundConsole from "./fund/FundConsole";
import { DecisionLog } from "./fund/DecisionLog";
import { SealedContext } from "./fund/Context";
import {
  buildLog,
  drawdownRows,
  entryAgents,
  evidenceBlocksLine,
  evidenceRows,
  latestSealed,
  pct,
  loopVerdict,
  titleGloss,
  pp,
  ppInterval,
  ppRange,
  ledgerText,
  ppShort,
  signedPct,
  splitRejections,
  statusLabel,
  showcaseContext,
  standing,
  winPct,
  filterLog,
  groupCutStats,
  ladderAt,
  maxAgentBudget,
  parseMove,
  replayIndexAt,
  stateAtIndex,
  treeRows,
  volMatched,
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
    correctedB: null,
    correctedA: null,
    headVsBaseline: null,
    riskSummary: null,
    rejections: [],
    booksB: null,
  };
  const rows = evidenceRows([...s.evidence.loops, unmerged]);
  assert.ok(rows.every((r) => !r.key.startsWith("9")), "the unmerged loop is not plotted");
  const confirmed = s.evidence.loops.filter((l) => l.confirmed);
  assert.equal(rows.length, confirmed.reduce((n, l) => n + (l.blockA ? 1 : 0) + (l.blockB ? 1 : 0) + (l.correctedB ? 1 : 0) + (l.correctedA ? 1 : 0), 0));
  // A correction is plotted next to the confirmed number, not instead of it:
  // the first confirmation is marked superseded and the re-measurement right
  // after it is the one that stands.
  const corrected = rows.find((r) => r.key.endsWith("Bc"));
  assert.ok(corrected, "loop 1's corrected block-B gain");
  const at = rows.indexOf(corrected);
  const first = rows[at - 1]!;
  assert.equal(first.key, corrected.key.slice(0, -1), "its first confirmation comes right before it");
  assert.equal(first.superseded, true);
  assert.equal(corrected.superseded, false);
  const corrections = confirmed.reduce((n, l) => n + (l.correctedB && l.blockB ? 1 : 0) + (l.correctedA && l.blockA ? 1 : 0), 0);
  assert.equal(rows.filter((r) => r.superseded).length, corrections, "only rows a correction replaced are marked superseded");
  // Plain words on the chart; the commit hash stays in the hover title and the data table.
  assert.doesNotMatch(`${corrected.label} ${corrected.sub}`, /[0-9a-f]{7}|post-push/);
  assert.match(corrected.detail ?? "", /f5b2d80/);
  // A tiger-track loop's rows say they measure the Tiger overlay, not the fund.
  for (const l of confirmed.filter((x) => x.merged[0]?.track === "tiger"))
    assert.ok(rows.filter((r) => r.key.startsWith(String(l.loop))).every((r) => r.label.includes("Tiger overlay")), `loop ${l.loop} rows are labelled`);
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

/* -------------------------------------------------------------------------- */
/* Evidence v2: drawdown summary, rejections, sealed books                     */
/* -------------------------------------------------------------------------- */

type Loop = Record<string, unknown>;
const withLoop = (mutate: (l: Loop) => void): Record<string, unknown> => {
  const r = raw();
  const loops = (r.evidence as { loops: Loop[] }).loops;
  mutate(loops.find((l) => l.loop === 2)!);
  return r;
};
const at = (r: Record<string, unknown>) => (r.evidence as { loops: Loop[] }).loops.findIndex((l) => l.loop === 2);

test("the committed snapshot carries each loop's drawdown summary and rejected candidates", () => {
  const s = load();
  // Loops 1 and 2 are sealed ledger entries (docs/loops/loop-1.json, loop-2.json)
  // with these hand-written fields; later loops are free to differ.
  for (const l of s.evidence.loops.filter((x) => x.loop <= 2)) {
    assert.ok(l.riskSummary, `loop ${l.loop} riskSummary`);
    assert.ok(l.rejections.length > 0, `loop ${l.loop} rejections`);
    for (const r of l.rejections) assert.ok(r.title.length > 0 && r.reason.length > 0);
  }
  const two = s.evidence.loops.find((l) => l.loop === 2)!;
  assert.ok(two.riskSummary!.pairedChange, "loop 2 recorded the paired drawdown change");
  assert.equal(s.evidence.loops.find((l) => l.loop === 1)!.riskSummary!.pairedChange, null, "loop 1 did not");
});

test("parseFundSnapshot rejects malformed evidence v2 fields with the JSON path", () => {
  let r = withLoop((l) => delete l.riskSummary);
  assert.throws(() => parseFundSnapshot(r), new RegExp(`evidence\\.loops\\[${at(r)}\\]\\.riskSummary: expected object, got undefined`));

  r = withLoop((l) => ((l.riskSummary as Loop).centerMaxDDAfter = "7.75%"));
  assert.throws(() => parseFundSnapshot(r), /evidence\.loops\[\d+\]\.riskSummary\.centerMaxDDAfter: expected finite number, got string/);

  // Out-of-range values are named in the message, not just their type.
  r = withLoop((l) => ((l.riskSummary as Loop).guardrailsMaxDD = -0.07));
  assert.throws(() => parseFundSnapshot(r), /riskSummary\.guardrailsMaxDD: expected number in \[0, 1\], got -0\.07$/);

  r = withLoop((l) => ((l.riskSummary as Loop).centerMaxDDAfter = 7.75));
  assert.throws(() => parseFundSnapshot(r), /riskSummary\.centerMaxDDAfter: expected number in \[0, 1\], got 7\.75$/);

  r = withLoop((l) => ((l.booksB as { seeds: Loop }).seeds.count = 0));
  assert.throws(() => parseFundSnapshot(r), /booksB\.seeds\.count: expected positive integer, got 0$/);

  r = raw();
  (r.world as Loop).seed = 10_001;
  assert.throws(() => parseFundSnapshot(r), /world\.seed: expected research seed in \[1, 9999\], got 10001$/);

  r = withLoop((l) => ((l.riskSummary as Loop).pairedChange = { mean: -0.003, lo: -0.001, hi: -0.005 }));
  assert.throws(() => parseFundSnapshot(r), /riskSummary\.pairedChange: expected lo ≤ mean ≤ hi/);

  r = withLoop((l) => ((l.riskSummary as Loop).pairedChange = { mean: -0.003, lo: -0.005 }));
  assert.throws(() => parseFundSnapshot(r), /riskSummary\.pairedChange\.hi: expected finite number, got undefined/);

  r = withLoop((l) => (l.rejections = [{ title: "x", reason: "y" }, { title: "no reason" }]));
  assert.throws(() => parseFundSnapshot(r), /evidence\.loops\[\d+\]\.rejections\[1\]\.reason: expected string, got undefined/);

  r = withLoop((l) => (l.rejections = null));
  assert.throws(() => parseFundSnapshot(r), /rejections: expected array, got null/);

  r = withLoop((l) => ((l.booksB as { center: Loop }).center.maxDrawdown = null));
  assert.throws(() => parseFundSnapshot(r), /booksB\.center\.maxDrawdown: expected finite number, got null/);

  r = withLoop((l) => ((l.booksB as { guardrails: Loop }).guardrails.sharpe = "0.77"));
  assert.throws(() => parseFundSnapshot(r), /booksB\.guardrails\.sharpe: expected finite number, got string/);

  r = withLoop((l) => ((l.booksB as Loop).block = "A"));
  assert.throws(() => parseFundSnapshot(r), /booksB\.block: expected "B"/);

  r = withLoop((l) => delete l.correctedB);
  assert.throws(() => parseFundSnapshot(r), /correctedB: expected object, got undefined/);

  // Nullable fields accept null.
  r = withLoop((l) => {
    l.riskSummary = null;
    l.booksB = null;
    l.rejections = [];
  });
  assert.doesNotThrow(() => parseFundSnapshot(r));
  r = withLoop((l) => ((l.booksB as { guardrails: Loop }).guardrails.sharpe = null));
  assert.doesNotThrow(() => parseFundSnapshot(r));
});

test("drawdown standing is worked out from before AND after", () => {
  assert.equal(standing(0.08, 0.078, 0.069), "still-above");
  assert.equal(standing(0.066, 0.076, 0.067), "now-above");
  assert.equal(standing(0.08, 0.066, 0.069), "now-below");
  assert.equal(standing(0.06, 0.065, 0.069), "below");
});

test("drawdown rows: before → after vs guardrails, and whether this loop crossed them", () => {
  const s = load();
  const rows = drawdownRows(s.evidence.loops);
  assert.equal(rows.length, s.evidence.loops.filter((l) => l.riskSummary).length);
  for (const r of rows) {
    const rs = s.evidence.loops.find((l) => l.loop === r.loop)!.riskSummary!;
    assert.equal(r.before, rs.centerMaxDDBefore);
    assert.equal(r.after, rs.centerMaxDDAfter);
    assert.equal(r.guardrails, rs.guardrailsMaxDD);
    assert.deepEqual(r.paired, rs.pairedChange);
    assert.equal(r.aboveGuardrails, rs.centerMaxDDAfter > rs.guardrailsMaxDD);
    assert.equal(r.standing, standing(rs.centerMaxDDBefore, rs.centerMaxDDAfter, rs.guardrailsMaxDD));
  }
  // The ledger (docs/loops/loop-1.json, loop-2.json): loop 1 took the center
  // book's block-B drawdown ABOVE guardrails (6.62% → 7.58% vs 6.73%); loop 2
  // lowered it but it is still above (8.07% → 7.75% vs 6.88%).
  assert.equal(rows.find((r) => r.loop === 1)!.standing, "now-above");
  assert.equal(rows.find((r) => r.loop === 2)!.standing, "still-above");
  assert.equal(drawdownRows([]).length, 0);
});

test("win rates never round to a number the ledger contradicts", () => {
  // docs/LOOPS.md: loop 1 block B "better in 74% of worlds" (0.745), after the fix "73%" (0.725).
  assert.equal(winPct(0.745), "74.5%");
  assert.equal(winPct(0.725), "72.5%");
  assert.equal(winPct(0.68), "68%");
  assert.equal(winPct(0.59), "59%");
});

/** The evidence panel rendered to HTML, with the collapsed <details> parts removed: what a reader sees by default. */
function visibleEvidence(loops: LoopEvidence[]): string {
  const html = renderToStaticMarkup(createElement(Evidence, { loops }));
  return html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

test("the evidence panel states loop 1's drawdown damage and its corrected gain in the open", () => {
  const s = load();
  const ledger = s.evidence.loops.filter((l) => l.loop <= 2);
  const text = visibleEvidence(ledger);
  const [one, two] = text.split(/Loop 2 /) as [string, string];
  // Loop 1 is what took the center book above guardrails: never "still above".
  assert.match(one, /now above · was below before this loop/);
  assert.doesNotMatch(one, /still above/);
  // Loop 2 was already above and stayed above.
  assert.match(two, /center book still above/);
  // The ledger's own note, including its drawdown sentence, is visible, not collapsed.
  const note = s.evidence.loops.find((l) => l.loop === 1)!.note!;
  assert.match(note, /raised the center book's mean max drawdown above per-agent guardrails'/);
  assert.ok(one.includes(note.replace(/\s+/g, " ")), "loop 1's ledger note is visible");
  // The card leads with the corrected, shipped gain; the first confirmation follows, labelled.
  const l1 = s.evidence.loops.find((l) => l.loop === 1)!;
  const lead = one.indexOf(pp(l1.correctedB!.uplift.mean));
  const firstAt = one.indexOf(`As first confirmed, before the fix: ${pp(l1.blockB!.allocator.mean)}`);
  assert.ok(lead >= 0 && firstAt > lead, "corrected number first, first confirmation after it");
  assert.match(one, /better in 72\.5% of worlds/);
  // The block-A certainty-equivalent lines name their block and seeds.
  assert.match(text, /Before loop 2, on block A \(200 sealed worlds, seeds 12000–12199\)/);
});

test("showcase context: the loop-2 disclosure (fixed facts of a sealed ledger entry)", () => {
  const s = load();
  // Pinned to loop 2's sealed numbers, so a later loop's result cannot break
  // this test; the latest loop is tested against its own data below.
  const upTo2 = { ...s, evidence: { ...s.evidence, loops: s.evidence.loops.filter((l) => l.loop <= 2) } };
  const ctx = showcaseContext(upTo2);
  assert.ok(ctx.sealed);
  assert.equal(ctx.sealed.loop, 2);
  assert.equal(ctx.sealed.worlds, 200);
  assert.deepEqual(ctx.rows.map((r) => r.metric), ["Certainty equivalent", "Sharpe", "Max drawdown"]);
  // Center book beats guardrails on certainty equivalent on the sealed block (11.7% vs 6.1%)…
  assert.equal(ctx.sealed.utilityAbove, true);
  assert.deepEqual(ctx.rows[0]!.sealed, { center: "+11.7%", guardrails: "+6.1%", better: "center" });
  // …but its mean max drawdown is still ABOVE the guardrails' there (7.75% vs 6.88%).
  assert.equal(ctx.sealed.drawdownAbove, true);
  assert.deepEqual(ctx.rows[2]!.sealed, { center: "7.75%", guardrails: "6.88%", better: "guardrails" });
  // Both columns of a row to the same precision.
  for (const r of ctx.rows) {
    if (!r.sealed) continue;
    const dp = (x: string) => x.split(".")[1]?.replace(/\D/g, "").length ?? 0;
    assert.equal(dp(r.world.center), dp(r.sealed.center), r.metric);
  }
});

test("showcase context: the latest sealed loop, whatever its result, is reported as it came out", () => {
  const s = load();
  const latest = latestSealed(s.evidence.loops)!;
  assert.equal(latest.loop, Math.max(...s.evidence.loops.filter((l) => l.confirmed && l.merged.length > 0 && l.booksB).map((l) => l.loop)));
  const ctx = showcaseContext(s);
  assert.ok(ctx.sealed);
  const b = latest.booksB;
  const c = s.books.center.summary;
  const g = s.books.baseline.summary;
  assert.equal(ctx.sealed.loop, latest.loop);
  assert.equal(ctx.sealed.worlds, b.seeds.count);
  assert.equal(ctx.sealed.drawdownAbove, b.center.maxDrawdown > b.guardrails.maxDrawdown);
  assert.equal(ctx.sealed.utilityAbove, b.center.utility > b.guardrails.utility);
  assert.equal(ctx.rows[2]!.sealed!.better === "guardrails", b.center.maxDrawdown > b.guardrails.maxDrawdown + 0.00005);
  assert.equal(ctx.gapWorld, c.utility - g.utility);
  assert.equal(ctx.sealed.gap, b.center.utility - b.guardrails.utility);
  assert.equal(ctx.sealed.favourable, ctx.gapWorld > ctx.sealed.gap);

  // A drawdown result that goes the other way is reported that way too.
  const flipped = {
    ...s,
    evidence: {
      ...s.evidence,
      loops: s.evidence.loops.map((l) =>
        l.loop === latest.loop ? { ...l, booksB: { ...b, center: { ...b.center, maxDrawdown: b.guardrails.maxDrawdown - 0.003 } } } : l,
      ),
    },
  };
  const f = showcaseContext(flipped);
  assert.equal(f.sealed!.drawdownAbove, false);
  assert.equal(f.rows[2]!.sealed!.better, "center");
});

test("showcase context without a sealed confirmation: the card stays and says so", () => {
  const s = load();
  const bare = { ...s, evidence: { ...s.evidence, loops: s.evidence.loops.map((l) => ({ ...l, booksB: null })) } };
  const ctx = showcaseContext(bare);
  assert.equal(ctx.sealed, null);
  assert.equal(ctx.rows.length, 3, "this world's rows are still shown");
  assert.ok(ctx.rows.every((r) => r.sealed === null));
  const html = renderToStaticMarkup(createElement(SealedContext, { ctx, seed: s.world.seed }));
  assert.match(html, /No sealed average yet/);
  assert.match(html, /no average to be read\s+against/);

  // A guardrails Sharpe the report could not vouch for is left out, not guessed;
  // the center book's own sealed Sharpe is still shown.
  const noSharpe = {
    ...s,
    evidence: {
      ...s.evidence,
      loops: s.evidence.loops.map((l) => (l.booksB ? { ...l, booksB: { ...l.booksB, guardrails: { ...l.booksB.guardrails, sharpe: null } } } : l)),
    },
  };
  const sharpeRow = showcaseContext(noSharpe).rows[1]!.sealed;
  assert.equal(sharpeRow?.guardrails, "not recorded");
  assert.equal(sharpeRow?.better, "tie");
  assert.match(sharpeRow?.center ?? "", /^-?\d+\.\d\d$/);
});

/* -------------------------------------------------------------------------- */
/* Loop 4: the center book's drawdown per unit of risk, next to the raw one    */
/* -------------------------------------------------------------------------- */

const withLoop3 = (mutate: (l: Loop) => void): Record<string, unknown> => {
  const r = raw();
  mutate((r.evidence as { loops: Loop[] }).loops.find((l) => l.loop === 3)!);
  return r;
};

test("parseFundSnapshot: the vol-matched drawdown is nullable, and must be a drawdown when present", () => {
  // null and a fraction are accepted.
  assert.doesNotThrow(() => parseFundSnapshot(withLoop3((l) => ((l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter = null))));
  assert.doesNotThrow(() => parseFundSnapshot(withLoop3((l) => ((l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter = 0.05))));
  // A snapshot written before the field existed reads it as null ("not recorded").
  const old = parseFundSnapshot(withLoop3((l) => delete (l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter));
  assert.equal(old.evidence.loops.find((l) => l.loop === 3)!.riskSummary!.centerMaxDDAtGuardrailsVolAfter, null);
  // Percent units, a string or a negative number are refused with the JSON path.
  assert.throws(
    () => parseFundSnapshot(withLoop3((l) => ((l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter = 5.88))),
    /evidence\.loops\[\d+\]\.riskSummary\.centerMaxDDAtGuardrailsVolAfter: expected number in \[0, 1\], got 5\.88$/,
  );
  assert.throws(
    () => parseFundSnapshot(withLoop3((l) => ((l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter = "5.88%"))),
    /riskSummary\.centerMaxDDAtGuardrailsVolAfter: expected finite number, got string/,
  );
  assert.throws(
    () => parseFundSnapshot(withLoop3((l) => ((l.riskSummary as Loop).centerMaxDDAtGuardrailsVolAfter = -0.01))),
    /riskSummary\.centerMaxDDAtGuardrailsVolAfter: expected number in \[0, 1\], got -0\.01$/,
  );
});

test("the committed snapshot carries loop 3's vol-matched drawdown (docs/loops/loop-3.json) and none before it", () => {
  const s = load();
  const r3 = s.evidence.loops.find((l) => l.loop === 3)!.riskSummary!;
  assert.ok(r3.centerMaxDDAtGuardrailsVolAfter !== null);
  assert.ok(Math.abs(r3.centerMaxDDAtGuardrailsVolAfter - 0.0588) < 0.0001);
  for (const l of s.evidence.loops.filter((x) => x.loop < 3)) assert.equal(l.riskSummary!.centerMaxDDAtGuardrailsVolAfter, null);
});

test("drawdown rows keep the raw drawdown and add the per-unit-of-risk one, worked out from the numbers", () => {
  const s = load();
  const rows = drawdownRows(s.evidence.loops);
  const r3 = rows.find((r) => r.loop === 3)!;
  const rs = s.evidence.loops.find((l) => l.loop === 3)!.riskSummary!;
  // The raw number is untouched and still above the guardrails'.
  assert.equal(r3.after, rs.centerMaxDDAfter);
  assert.equal(r3.aboveGuardrails, true);
  assert.equal(r3.standing, "still-above");
  // At the guardrails' volatility: lower than its own raw number (it runs more
  // volatility) and lower than the guardrails' (per unit of risk).
  assert.deepEqual(r3.atGuardrailsVol, { value: rs.centerMaxDDAtGuardrailsVolAfter, moreVol: true, belowGuardrails: true });
  for (const r of rows.filter((x) => x.loop < 3)) assert.equal(r.atGuardrailsVol, null);
  // The flags follow the numbers, not a script.
  assert.deepEqual(volMatched(0.066, 0.07, 0.065), { value: 0.07, moreVol: false, belowGuardrails: false });
  assert.equal(volMatched(0.066, null, 0.065), null);
});

test("the context card shows the raw sealed drawdown AND the per-unit-of-risk one, with the one-line reason", () => {
  const s = load();
  const ctx = showcaseContext(s);
  const latest = latestSealed(s.evidence.loops)!;
  assert.equal(latest.loop, Math.max(...s.evidence.loops.filter((l) => l.booksB).map((l) => l.loop)));
  assert.ok(ctx.sealed?.volMatched);
  assert.equal(ctx.sealed.volMatched.value, latest.riskSummary!.centerMaxDDAtGuardrailsVolAfter);
  const html = renderToStaticMarkup(createElement(SealedContext, { ctx, seed: s.world.seed }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
  // Never drop the raw number: flagged higher, and still said in words (values from the latest sealed loop).
  const L = latestSealed(s.evidence.loops)!;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rawDD = esc(pct(L.booksB.center.maxDrawdown, 2));
  const gDD = esc(pct(L.booksB.guardrails.maxDrawdown, 2));
  const vmDD = esc(pct(L.riskSummary!.centerMaxDDAtGuardrailsVolAfter!, 2));
  assert.match(html, new RegExp(`${rawDD} ▲ higher`));
  assert.match(html, new RegExp(`its mean max drawdown is still higher than theirs \\(${rawDD} vs ${gDD}\\)`));
  // The per-unit-of-risk number next to it, with its reason. Its owner is
  // named on screen (not only to screen readers), after both raw numbers.
  assert.match(html, new RegExp(`${rawDD} ▲ higher (per-agent guardrails )?${gDD} center book at the guardrails' volatility: ${vmDD}`));
  const raw = renderToStaticMarkup(createElement(SealedContext, { ctx, seed: s.world.seed }));
  const perRisk = /<span class="fx-perrisk">([\s\S]*?)<\/span><\/span><\/span>/.exec(raw)?.[1] ?? "";
  assert.doesNotMatch(perRisk, /sr-only/, "the owner is visible text");
  assert.match(perRisk, /fx-perrisk-key/, "the chart's gold diamond marks it");
  assert.match(html, /The center book runs more volatility than the guardrails; per unit of risk its drawdown is lower/);
  assert.match(html, new RegExp(`The raw ${rawDD} is what it actually drew down`));
  // The terms are defined once, under the sealed evidence: the card links there.
  assert.match(html, /Certainty equivalent, sealed worlds and block B are defined under Sealed evidence/);
  assert.match(raw, /href="#evidence-terms"/);
  assert.doesNotMatch(html, /sure yearly return/);

  // A risk summary from a different run than the books (its raw "after" does
  // not match) is not shown next to them.
  const other = {
    ...s,
    evidence: {
      ...s.evidence,
      loops: s.evidence.loops.map((l) =>
        l.loop === latest.loop ? { ...l, riskSummary: { ...l.riskSummary!, centerMaxDDAfter: l.riskSummary!.centerMaxDDAfter + 0.01 } } : l,
      ),
    },
  };
  assert.equal(showcaseContext(other).sealed!.volMatched, null);
  // Nor is a missing one invented.
  const none = {
    ...s,
    evidence: {
      ...s.evidence,
      loops: s.evidence.loops.map((l) => (l.riskSummary ? { ...l, riskSummary: { ...l.riskSummary, centerMaxDDAtGuardrailsVolAfter: null } } : l)),
    },
  };
  const bare = showcaseContext(none);
  assert.equal(bare.sealed!.volMatched, null);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SealedContext, { ctx: bare, seed: s.world.seed })), /guardrails&#x27; volatility/);
});

test("the evidence panel shows loop 3's raw drawdown with its vol-matched one, both in the open", () => {
  const s = load();
  const text = visibleEvidence(s.evidence.loops);
  const three = text.slice(text.indexOf("Loop 3 "));
  assert.match(three, /6\.65% → 6\.63%/);
  assert.match(three, /Per-agent guardrails on the same worlds: 6\.53%/);
  assert.match(three, /center book still above/);
  assert.match(three, /At the guardrails' volatility: 5\.88% \(below their 6\.53%\)/);
  assert.match(three, /The center book runs more volatility than the guardrails; per unit of risk its drawdown is lower/);
  // The drawdown chart labels it next to the raw numbers.
  assert.match(text, /6\.65% → 6\.63% guardrails 6\.53% ◇ 5\.88% at their vol/);
  // "at their vol" never splits across lines in the narrow value column.
  assert.match(renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops })), /<span class="fc-dd-vol-note">at their vol<\/span>/);
});

/* -------------------------------------------------------------------------- */
/* Loop 4 fixes: what a merge had to do, and what "one counterparty" means     */
/* -------------------------------------------------------------------------- */

test("loop verdicts: a structural merge is 'confirmed neutral', not read as a win", () => {
  const s = load();
  const text = visibleEvidence(s.evidence.loops);
  const [one, rest] = text.split(/Loop 2 /) as [string, string];
  const [two, three] = rest.split(/Loop 3 /) as [string, string];
  // Loops 1 and 2 merged return claims that won block B.
  assert.match(one, /✓ merged · confirmed on block B/);
  assert.match(two, /✓ merged · confirmed on block B/);
  // Loop 3 merged two structural guarantees; its block-B interval crosses zero.
  const l3 = s.evidence.loops.find((l) => l.loop === 3)!;
  assert.ok(l3.blockB!.allocator.lo < 0 && l3.merged.every((m) => m.track === "structure"));
  assert.match(three, /✓ merged · confirmed neutral on block B \(structural\)/);
  assert.equal(loopVerdict({ confirmed: false, merged: [] }), "nothing merged");
  assert.equal(loopVerdict({ confirmed: false, merged: [{ k: 0, angle: "x", track: "allocator" }] }), "merged · not confirmed");
});

test("loop 3's title is glossed: 'one counterparty' is the cap after a stop-out, not a crowding-scan grouping key", () => {
  const s = load();
  const text = visibleEvidence(s.evidence.loops);
  const three = text.slice(text.indexOf("Loop 3 "));
  assert.match(three, /An operator is one counterparty \(G\)/);
  assert.match(three, /One counterparty means: when one of an operator's agents is stopped out, its other live agents are capped together/);
  assert.match(three, /It is not a grouping key: the crowding cut still groups agents by overlapping positions only/);
  // Only that title gets it.
  assert.equal(titleGloss("One-year Sharpe scores (A) and stop-out by one close of the agent's subtree (C)"), null);
  assert.equal(text.match(/One counterparty means/g)?.length, 1);
});

test("the evidence panel's method line and drawdown caption take the block size from the data, and need none", () => {
  const s = load();
  const panel = (loops: LoopEvidence[]) =>
    renderToStaticMarkup(createElement(EvidencePanel, { snapshot: { ...s, evidence: { ...s.evidence, loops } } }))
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
  // Every committed loop used 200-world blocks.
  const all = panel(s.evidence.loops);
  assert.match(all, /judged against the code before it on 200 sealed virtual worlds \(block A\), then confirmed on 200 more \(block B\)/);
  assert.match(all, /Each loop is confirmed on its own block of 200 sealed virtual worlds/);
  // No loops yet: no dangling "on  more".
  const none = panel([]);
  assert.match(none, /on sealed virtual worlds \(block A\), then confirmed on a fresh block \(block B\)\. Read from/);
  assert.doesNotMatch(none, /on\s+more/);
  // Mixed block sizes: no count, in the line or in the caption.
  const mixed = s.evidence.loops.map((l) => (l.loop === 2 ? { ...l, blocks: { ...l.blocks, B: { ...l.blocks.B, count: 100 } } } : l));
  const m = panel(mixed);
  assert.match(m, /then confirmed on a fresh block \(block B\)/);
  assert.match(m, /Each loop is confirmed on its own block of sealed virtual worlds/);
  assert.equal(evidenceBlocksLine([]), "Each loop is judged against the code before it on sealed virtual worlds (block A), then confirmed on a fresh block (block B).");
});

const flatten = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The whole console rendered to text. Its charts measure in useLayoutEffect, which React warns about on the server: that one warning is muted. */
function consoleText(s: FundSnapshot): string {
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args);
  };
  try {
    return flatten(renderToStaticMarkup(createElement(FundConsole, { snapshot: s })));
  } finally {
    console.error = error;
  }
}

test("(G) in the console: the crowding cut groups by positions only; the operator cap is named apart, and only as a count", () => {
  const s = load();
  const caps = s.decisions.filter((d) => d.kind === "OPERATOR_CUT").length;
  assert.equal(caps, 0, "the showcase world has no operator cap");
  const text = consoleText(s);
  assert.match(text, /The crowding cut groups agents by overlapping positions only; a cut whose members share an operator is flagged\./);
  assert.match(text, /Separately, since loop 3 a stop-out caps the same operator's other agents; no agent of a shared operator was stopped out in this world, so it did not fire\./);
  // The NAV caption lists what the allocator does in this world: no operator limits.
  assert.match(text, /looks across the agents \(allocation and crowding limits\) and judges/);
  assert.doesNotMatch(text, /operator limits/);
  // Never "groups by operator" as a claim.
  assert.doesNotMatch(text.replace(/still being researched/g, ""), /groups? (agents )?by operator/i);

  // With an operator cap in the world, the console says so and counts it.
  const agent = s.agents.find((a) => a.operator === "op-8")!;
  const capped = { ...s, decisions: [...s.decisions, { t: 50, kind: "OPERATOR_CUT" as const, node: agent.name, detail: "operator cap" }] };
  const withCap = consoleText(capped);
  assert.match(withCap, /caps the same operator's other agents, which happened 1 time in this world\./);
  assert.match(withCap, /\(allocation and crowding limits, and operator caps after a stop-out\)/);
});

test("the decision log's operator filter says what it holds, and names operator caps only when one fired", () => {
  const s = load();
  const note = (snap: FundSnapshot) =>
    flatten(
      renderToStaticMarkup(
        createElement(DecisionLog, { snapshot: snap, filter: "operator", onFilter: () => {}, selected: null, onSelect: () => {} }),
      ),
    );
  const none = note(s);
  assert.match(none, /One-trade cuts whose members share an operator \(flagged; the cut itself groups by overlapping positions only\)\. No operator cap/);
  assert.doesNotMatch(none, /Operator caps \(when/);
  const agent = s.agents.find((a) => a.operator === "op-8")!;
  const capped = { ...s, decisions: [...s.decisions, { t: 50, kind: "OPERATOR_CUT" as const, node: agent.name, detail: "operator cap" }] };
  assert.match(note(capped), /, and 1 operator cap: one of an operator's agents was stopped out/);
});

test("lint: the drawdown chart paints the before ring's outline and the guardrails tick above the after dot", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /\.fc-dd-before::after \{[^}]*z-index: 2;/);
  assert.match(css, /\.fc-dd-after \{ z-index: 1;/);
  assert.match(css, /\.fc-dd-guard \{ z-index: 3;/);
});

test("interval labels keep 2 decimals below 1 pp and never print a signed zero", () => {
  assert.equal(ppRange(-0.0003, 0.0006), "−0.03 to +0.06 pp");
  assert.equal(ppShort(0.0123), "+1.2");
  assert.equal(ppShort(0), "0.00");
  assert.equal(pp(0), "0.00 pp");
  assert.equal(signedPct(-0.00001), "0.0%");
  assert.equal(pp(0.0123), "+1.23 pp");
  const s = load();
  const html = flatten(renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops })));
  assert.doesNotMatch(html, /[−-]0\.0 to|[−-]0\.00? pp|[−-]0\.0%/, "no signed zero in the evidence");
});

test("a non-zero pp value never prints as an exact zero: it keeps its sign with a finer step", () => {
  // Loop 5's block B in the ledger: −0.0014 pp [−0.0037, +0.0008].
  assert.equal(pp(-0.000014), "−0.001 pp");
  assert.equal(ppShort(-0.000014), "−0.001");
  assert.equal(ppRange(-0.000037, 0.000008), "−0.004 to +0.001 pp");
  assert.equal(ppInterval(-0.000037, 0.000008), "−0.004 pp to +0.001 pp");
  // Below the finest step (5 decimals), a signed bound.
  assert.equal(pp(-0.00000001), "−<0.00001 pp");
  assert.equal(pp(0.00000001), "+<0.00001 pp");
  assert.equal(pp(0), "0.00 pp", "an exact zero (e.g. a loop that left the allocator unchanged) stays 0.00");
  // Every non-zero interval end renders with its sign: no false "0.00" for a value that is not 0.
  const s = load();
  const html = flatten(renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops })));
  for (const r of evidenceRows(s.evidence.loops)) {
    for (const v of [r.u.mean, r.u.lo, r.u.hi]) if (v !== 0) assert.doesNotMatch(pp(v), /^0\.0+ pp$/, `${r.key}: ${v}`);
    assert.ok(html.includes(ppRange(r.u.lo, r.u.hi)), `${r.key}: ${ppRange(r.u.lo, r.u.hi)} shown`);
  }
});

test("an interval label uses one precision for both ends", () => {
  // Loop 4 · block B: "+0.19 to +2.92 pp", as in the loop card (not "+0.19 to +2.9").
  assert.equal(ppRange(0.0019, 0.0292), "+0.19 to +2.92 pp");
  assert.equal(ppRange(0.031, 0.05), "+3.1 to +5.0 pp");
  assert.equal(ppInterval(0.0019, 0.0292), "+0.19 pp to +2.92 pp");
});

test("ledger notes show no signed zero and a typographic minus", () => {
  assert.equal(
    ledgerText("alpha scoring missed on block A (+0.23 pp [-0.00, +0.46])"),
    "alpha scoring missed on block A (+0.23 pp [0.00, +0.46])",
  );
  assert.equal(ledgerText("block B -0.0014 pp [-0.0037, +0.0008]"), "block B −0.0014 pp [−0.0037, +0.0008]");
  assert.equal(ledgerText("+0.0 and −0.00%"), "0.0 and 0.00%");
  // Hyphens inside words and ranges are left alone.
  assert.equal(ledgerText("loop-2 seeds 1-200, re-run"), "loop-2 seeds 1-200, re-run");
  const s = load();
  const html = flatten(renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops })));
  assert.doesNotMatch(html, /(^|[\s([,])[-−+]0\.0+(?![\d.])/, "no signed zero anywhere in the evidence, notes included");
  assert.doesNotMatch(html, /(^|[\s([,])-\d/, "no hyphen-minus before a number in the evidence");
});

test("the rejection sub-lists are h4 headings under the panel's h3", () => {
  const s = load();
  const html = renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops }));
  if (s.evidence.loops.some((l) => l.loop === 3)) {
    assert.match(html, /<h4 class="fc-rejects-k">Candidates not merged<\/h4>/);
    assert.match(html, /<h4 class="fc-rejects-k">Null results: tested, no change proposed<\/h4>/);
  }
});

test("null results are listed apart from candidates that were not merged", () => {
  const { candidates, nulls } = splitRejections([
    { title: "a", reason: "won block A, failed block B" },
    { title: "b", reason: "null result, no diff: none beats uniform deleveraging" },
    { title: "c", reason: "Null result, no diff" },
  ]);
  assert.deepEqual(candidates.map((r) => r.title), ["a"]);
  assert.deepEqual(nulls.map((r) => r.title), ["b", "c"]);
  const s = load();
  const html = flatten(renderToStaticMarkup(createElement(Evidence, { loops: s.evidence.loops })));
  if (s.evidence.loops.some((l) => l.loop === 3)) {
    assert.match(html, /1 candidate not merged · 2 null results \(no diff proposed\), and why/);
    assert.match(html, /Null results: tested, no change proposed/);
  }
});

test("an agent sized to zero reads unallocated, not a cut that cannot explain ×0.00", () => {
  assert.equal(statusLabel("cut", 0.5, 0), "unallocated");
  assert.equal(statusLabel("cut", 0.5, 1200), "cut ×0.5");
  assert.equal(statusLabel("active", 0.5, 0), "unallocated");
  assert.equal(statusLabel("stopped", 0.5, 0), "stopped out");
  const s = load();
  const zero = s.agents.filter((a) => a.status !== "stopped" && (a.capital.at(-1) ?? 0) <= 0);
  const html = flatten(renderToStaticMarkup(createElement(FundConsole, { snapshot: s })));
  assert.doesNotMatch(html, /allocated nothing/);
  for (const a of zero) assert.match(html, new RegExp(`${a.label} .*unallocated 0 `));
});
