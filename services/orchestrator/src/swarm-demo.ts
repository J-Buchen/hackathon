/**
 * Allowance — the center-book demo.
 *
 * A Tiger-Cub-style fund whose PMs are agents, run twice on the same synthetic
 * market: once with per-agent guardrails only (what agent-trading products ship
 * today), once with the center book looking across all agents. Prints the
 * thesis, the head-to-head, the multi-seed sweep and the ablation, then writes
 * `apps/web/public/swarm-snapshot.json` for the dashboard.
 *
 * Run:  npm run demo:swarm   (from the repo root)
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ablation,
  buildSwarmSnapshot,
  defaultMarketConfig,
  defaultSwarm,
  headToHead,
  sweepSeeds,
  trackRecords,
  TigerCubStrategy,
  QUESTION_TEXT,
  type BookSummary,
  type Question,
} from "@allowance/swarm";

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function header(title: string, eli5: string): void {
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${title}`);
  console.log(`  (ELI5) ${eli5}`);
  console.log("═".repeat(78));
}

function line(msg = ""): void {
  console.log(`   ${msg}`);
}

function compare(label: string, naive: BookSummary, center: BookSummary): void {
  const row = (name: string, f: (s: BookSummary) => string) =>
    line(`${name.padEnd(28)} ${f(naive).padStart(10)} ${f(center).padStart(12)}`);
  line(`${label.padEnd(28)} ${"per-agent".padStart(10)} ${"center book".padStart(12)}`);
  row("loss in the unwind", (s) => signed(s.crashWindowReturn));
  row("max drawdown", (s) => pct(s.maxDrawdown));
  row("peak crowded exposure", (s) => pct(s.peakCrowdExposure));
  row("sharpe", (s) => s.sharpe.toFixed(2));
  row("total return", (s) => signed(s.totalReturn));
  row("stop-outs (revocations)", (s) => (Number.isInteger(s.stopOuts) ? String(s.stopOuts) : s.stopOuts.toFixed(1)));
}

async function main(): Promise<void> {
  const config = defaultMarketConfig();
  const spec = defaultSwarm(config.seed);

  /* 1) The thesis ---------------------------------------------------- */
  if (spec.thesis) {
    header(
      `1. THE TREND — ${spec.thesis.trend.name} (research as of ${spec.thesis.asOf})`,
      "Find something the world is doing more of, then find the company best placed to win from it.",
    );
    line(spec.thesis.trend.thesis);
    if (spec.thesis.caveat) line(`⚠ ${spec.thesis.caveat}`);
    for (const e of spec.thesis.trend.evidence) line(`• ${e.claim}${e.source ? ` [${e.source}]` : ""}`);

    header(
      "2. THREE QUESTIONS — good company? good management? why now?",
      "A Tiger Cub only buys a company that gets a 'yes' to all three. Two out of three is a pass.",
    );
    const cubs = spec.agents.filter((a) => a.strategy instanceof TigerCubStrategy);
    for (const a of cubs) {
      const s = a.strategy as TigerCubStrategy;
      const w = s.pmStyle.weights;
      line(`${a.label} (${a.pod} pod) — weights ${(Object.keys(w) as Question[]).map((q) => `${q} ${(w[q] * 100).toFixed(0)}%`).join(" · ")}`);
      for (const r of s.idea.rationale) line(`   ${r}`);
    }
    const longs = new Set(cubs.map((a) => (a.strategy as TigerCubStrategy).idea.long?.ticker ?? "none"));
    if (cubs.length > 1 && longs.size === 1) {
      line();
      line(`→ ${cubs.length} PMs in ${new Set(cubs.map((a) => a.pod)).size} pods, weighting ${Object.values(QUESTION_TEXT).length} questions differently,`);
      line(`  all land on ${[...longs][0]}. Each is inside its own limits. Together they are one trade.`);
    }
  }

  /* 2) Head-to-head --------------------------------------------------- */
  header(
    "3. SAME MARKET, TWO BOOKS",
    "Both books hold the same agents with the same rules each. Only one of them looks at all the agents together.",
  );
  const h = await headToHead(config);
  compare(`seed ${config.seed}`, h.naiveSummary, h.centerSummary);

  header(
    "4. WHAT THE CENTER BOOK DID",
    "Cutting an agent shrinks its allowance; stopping it out takes the allowance away. Same tree as payments.",
  );
  for (const d of h.center.decisions.filter((x) => x.kind === "CROWDING_CUT" || x.kind === "STOP_OUT" || x.kind === "GATE_CLIP").slice(0, 12)) {
    line(`day ${String(d.t + 1).padStart(3)}  ${d.kind.padEnd(13)} ${d.detail}`);
  }
  const counts: Record<string, number> = {};
  for (const d of h.center.decisions) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  line(`… totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  header("5. TRACK RECORDS", "Every agent's results per dollar it was given — the dataset allocators actually want.");
  for (const r of trackRecords(h.center)) {
    line(
      `${r.agent.padEnd(16)} ${r.pod.padEnd(12)} ${r.status.padEnd(8)} sharpe ${r.sharpe.toFixed(2).padStart(5)}  maxDD ${pct(r.maxDrawdown).padStart(6)}  twin ${r.closestTwin?.agent ?? "-"} (${r.closestTwin?.corr.toFixed(2) ?? "-"})`,
    );
  }

  /* 3) Robustness ----------------------------------------------------- */
  header(`6. ${SEEDS.length} MARKETS, NOT ONE`, "One lucky run proves nothing, so rerun on many different random markets.");
  const sweep = await sweepSeeds(SEEDS);
  line(`center book had the smaller max drawdown on ${sweep.centerWinsDrawdown}/${SEEDS.length} seeds`);
  line(`center book had the higher Sharpe on      ${sweep.centerWinsSharpe}/${SEEDS.length} seeds`);
  compare("mean over seeds", sweep.naiveMean, sweep.centerMean);
  line();
  line("…and if the research is WRONG (catalysts carry no edge at all):");
  const noEdge = await sweepSeeds(SEEDS, { assumeEdge: false });
  line(`center book had the smaller max drawdown on ${noEdge.centerWinsDrawdown}/${SEEDS.length} seeds`);
  compare("mean over seeds, no edge", noEdge.naiveMean, noEdge.centerMean);

  header("7. ABLATION — WHAT EARNS ITS KEEP", "Switch each piece off and see what breaks. Reported as-is.");
  const rows = await ablation(SEEDS);
  line(`${"variant".padEnd(24)} ${"maxDD".padStart(7)} ${"unwind".padStart(8)} ${"sharpe".padStart(7)} ${"return".padStart(8)}`);
  for (const r of rows) {
    line(
      `${r.variant.padEnd(24)} ${pct(r.meanMaxDrawdown).padStart(7)} ${signed(r.meanCrashWindowReturn).padStart(8)} ${r.meanSharpe.toFixed(2).padStart(7)} ${signed(r.meanTotalReturn).padStart(8)}`,
    );
  }

  /* 4) Snapshot ------------------------------------------------------- */
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../../apps/web/public/swarm-snapshot.json");
  const snapshot = buildSwarmSnapshot(spec, h, sweep, rows, noEdge);
  await writeFile(out, `${JSON.stringify(snapshot)}\n`, "utf8");
  header("8. SNAPSHOT", "Wrote the dashboard's data file.");
  line(out);
  line("Prices are synthetic; research is illustrative and dated; not investment advice.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
