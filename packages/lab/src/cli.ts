/**
 * Luckin Tiger lab — command line.
 *
 *   npm run lab -- fetch                 download prices, T-bill, SEC earnings dates (+ provenance)
 *   npm run lab -- study                 research on the DEVELOPMENT period only
 *   npm run lab -- holdout <params.json> unseal the holdout for one parameter set (ledgered)
 *   npm run lab -- forward <params.json> forward Monte Carlo + valuation + Kelly sizing
 *
 * Data lives in data/lab (git-ignored: raw vendor data is not redistributed);
 * results in lab-results/. The holdout ledger records every unsealing.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAll } from "./fetch";
import { forwardMonteCarlo, type Drift } from "./montecarlo";
import { performance } from "./metrics";
import { defaultSpace, evaluateHoldout, expandGrid, makeSplit, study } from "./research";
import { alignPanel, mapEvents, parseEventsCsv, parseFredCsv, parsePriceCsv, DataError, type Bar, type Panel, type PanelEvent } from "./series";
import { BUY_AND_HOLD, DEFAULT_PARAMS, runTiger, type TigerParams } from "./strategy";
import { defaultScenarios, kellySize, sensitivityToPitchProbability, valueScenarios } from "./valuation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA = process.env.LAB_DATA ?? join(ROOT, "data/lab");
const OUT = process.env.LAB_OUT ?? join(ROOT, "lab-results");
const PRIMARY = "LKNCY";
const HEDGES = ["KWEB", "FXI", "MCHI"];
const EXTRA = ["SBUX"];
/** LKNCY began trading OTC on 2020-06-29 after the Nasdaq delisting. */
const START = "2020-06-29";
const HOLDOUT_DAYS = 252;
const WARMUP_DAYS = 200;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadPanel(): Promise<{ panel: Panel; events: PanelEvent[]; hedges: string[] }> {
  if (!existsSync(join(DATA, "prices", `${PRIMARY}.csv`))) {
    throw new DataError(`no data in ${DATA}. Run "npm run lab -- fetch" (needs network access to Yahoo, Stooq, SEC and FRED), or place Yahoo-format CSVs in ${join(DATA, "prices")}.`);
  }
  const files = (await readdir(join(DATA, "prices"))).filter((f) => /^[A-Z.]+\.csv$/.test(f));
  const series: Record<string, Bar[]> = {};
  for (const f of files) {
    const sym = f.replace(/\.csv$/, "");
    if (sym !== PRIMARY && !HEDGES.includes(sym)) continue; // extras are context, not tradeable here
    series[sym] = parsePriceCsv(await readFile(join(DATA, "prices", f), "utf8"), sym);
  }
  const rfPath = join(DATA, "rates", "DTB3.csv");
  const riskFree = existsSync(rfPath) ? parseFredCsv(await readFile(rfPath, "utf8")) : [];
  const { panel, report } = alignPanel(series, PRIMARY, { from: START, riskFree });
  console.log(`panel: ${panel.dates.length} days ${report.firstDate} → ${report.lastDate}, symbols ${panel.symbols.join(", ")}, ${report.dropped} misaligned days dropped`);
  for (const [s, w] of Object.entries(report.maxAbsReturn)) console.log(`  largest move ${s}: ${(w.ret * 100).toFixed(1)}% on ${w.date}`);
  if (riskFree.length === 0) console.log("  ⚠ no risk-free series: Sharpe is on raw returns");
  const evPath = join(DATA, "events", `${PRIMARY}.csv`);
  const events = existsSync(evPath) ? mapEvents(parseEventsCsv(await readFile(evPath, "utf8")), panel.dates) : [];
  console.log(`  ${events.length} earnings prints mapped`);
  return { panel, events, hedges: panel.symbols.filter((s) => s !== PRIMARY) };
}

async function cmdFetch() {
  const to = arg("to") ?? new Date().toISOString().slice(0, 10);
  console.log(`fetching ${PRIMARY} + ${[...HEDGES, ...EXTRA].join(", ")} from ${START} to ${to} into ${DATA}`);
  const prov = await downloadAll(DATA, { primary: PRIMARY, hedges: [...HEDGES, ...EXTRA], from: START, to });
  if (prov.errors.length) console.log(`\n${prov.errors.length} problem(s):\n  ${prov.errors.join("\n  ")}`);
  const bad = prov.crossChecks.filter((c) => c.agreement < 0.98);
  if (bad.length) console.log(`\n⚠ sources disagree on >2% of days for: ${bad.map((c) => c.symbol).join(", ")} — inspect provenance.json`);
}

async function cmdStudy() {
  const { panel, events, hedges } = await loadPanel();
  const split = makeSplit(panel, { holdoutDays: HOLDOUT_DAYS, warmupDays: WARMUP_DAYS });
  console.log(`development ${panel.dates[split.dev.from]} → ${panel.dates[split.dev.to]}; holdout ${split.holdout ? `${panel.dates[split.holdout.from]} → ${panel.dates[split.holdout.to]} (SEALED)` : "none"}`);
  const grid = expandGrid(DEFAULT_PARAMS, defaultSpace(hedges));
  console.log(`searching ${grid.length} variants…`);
  const s = study(panel, events, grid, split.dev, { minTrain: 504, testLen: 126 });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "study.json"), JSON.stringify({ split: { dev: [panel.dates[split.dev.from], panel.dates[split.dev.to]] }, ...s }, null, 2));
  await writeFile(join(OUT, "selected-params.json"), JSON.stringify(s.best.params, null, 2));
  const f = (x: number) => x.toFixed(2);
  console.log(`\nIn-sample winner: Sharpe ${f(s.best.perf.sharpe)} vs buy-and-hold ${f(s.bench.sharpe)} (max DD ${(s.best.perf.maxDrawdown * 100).toFixed(0)}% vs ${(s.bench.maxDrawdown * 100).toFixed(0)}%)`);
  console.log(`Deflated Sharpe: ${(s.deflated.dsr * 100).toFixed(1)}% probability it beats the best of ${s.trials} unskilled variants`);
  console.log(`PBO: ${(s.pbo.pbo * 100).toFixed(0)}% of CSCV splits put the in-sample winner in the bottom half out of sample`);
  console.log(`Walk-forward (out of sample): Sharpe ${f(s.walkForward.perf.sharpe)} vs buy-and-hold ${f(s.walkForward.bench.sharpe)}; ` +
    `difference ${f(s.walkForward.vsBench.diff)} [90% CI ${f(s.walkForward.vsBench.lo)}, ${f(s.walkForward.vsBench.hi)}], P(>0) ${(s.walkForward.vsBench.pPositive * 100).toFixed(0)}%`);
  console.log(`\nwrote ${join(OUT, "study.json")}`);
}

async function cmdHoldout(paramsFile: string) {
  const { panel, events } = await loadPanel();
  const split = makeSplit(panel, { holdoutDays: HOLDOUT_DAYS, warmupDays: WARMUP_DAYS });
  if (!split.holdout) throw new DataError("history too short for a holdout");
  const params = { ...DEFAULT_PARAMS, ...(JSON.parse(await readFile(paramsFile, "utf8")) as Partial<TigerParams>) };
  const h = evaluateHoldout(panel, events, params, split.holdout);
  await mkdir(OUT, { recursive: true });
  const ledgerPath = join(OUT, "holdout-ledger.json");
  const ledger = existsSync(ledgerPath) ? (JSON.parse(await readFile(ledgerPath, "utf8")) as unknown[]) : [];
  ledger.push({ at: new Date().toISOString(), paramsFile, params, sharpe: h.perf.sharpe, benchSharpe: h.bench.sharpe });
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
  await writeFile(join(OUT, "holdout.json"), JSON.stringify(h, null, 2));
  console.log(`HOLDOUT ${h.range.from} → ${h.range.to} (unsealing #${ledger.length}${ledger.length > 1 ? " — no longer a clean holdout" : ""})`);
  console.log(`  strategy: Sharpe ${h.perf.sharpe.toFixed(2)}, return ${(h.perf.totalReturn * 100).toFixed(1)}%, max DD ${(h.perf.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  buy&hold: Sharpe ${h.bench.sharpe.toFixed(2)}, return ${(h.bench.totalReturn * 100).toFixed(1)}%, max DD ${(h.bench.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  difference ${h.vsBench.diff.toFixed(2)} [90% CI ${h.vsBench.lo.toFixed(2)}, ${h.vsBench.hi.toFixed(2)}]`);
}

async function cmdForward(paramsFile: string) {
  const { panel, events } = await loadPanel();
  const params = { ...DEFAULT_PARAMS, ...(JSON.parse(await readFile(paramsFile, "utf8")) as Partial<TigerParams>) };
  // Forward prints: each of the last four prints, one year later.
  const last = panel.dates.length - 1;
  const forwardEvents = events
    .slice(-4)
    .map((e) => e.t + 252 - last)
    .filter((d) => d >= 1 && d <= 252);
  const recent = panel.ret[PRIMARY]!.slice(-252);
  const vol = performance(recent).annVol;
  const rf = (panel.rf[last] ?? 0) * 252;
  const mcapUsdMm = Number(arg("mcap") ?? NaN);
  const usdCny = Number(arg("usdcny") ?? 7.1);
  const out: Record<string, unknown> = { forwardEvents, realizedVol: vol, riskFree: rf };
  let thesisDrift: number | null = null;
  if (Number.isFinite(mcapUsdMm)) {
    const inputs = { marketCapUsdMm: mcapUsdMm, usdCny, scenarios: defaultScenarios() };
    const v = valueScenarios(inputs);
    thesisDrift = v.expectedReturn;
    out.valuation = v;
    out.sensitivity = sensitivityToPitchProbability(inputs);
    out.kelly = kellySize(v.expectedReturn, vol, rf);
  } else {
    console.log("  (pass --mcap <USD millions> to value the scenarios and size with Kelly)");
  }
  const drifts: Record<string, Drift> = { zero: "zero", historical: "historical" };
  if (thesisDrift !== null) drifts.thesis = { annual: thesisDrift };
  const mc: Record<string, unknown> = {};
  for (const [name, drift] of Object.entries(drifts)) {
    mc[name] = forwardMonteCarlo(panel, events, { tiger: params, buyAndHold: BUY_AND_HOLD }, { horizon: 252, paths: 2000, meanBlock: 20, drift, forwardEvents, seed: 7, warmup: 260 });
  }
  out.monteCarlo = mc;
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "forward.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
}

async function main() {
  const [cmd, file] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !process.argv[process.argv.indexOf(a) - 1]?.startsWith("--"));
  switch (cmd) {
    case "fetch":
      return cmdFetch();
    case "study":
      return cmdStudy();
    case "holdout":
      return cmdHoldout(file ?? join(OUT, "selected-params.json"));
    case "forward":
      return cmdForward(file ?? join(OUT, "selected-params.json"));
    case "baseline": {
      const { panel, events } = await loadPanel();
      const r = runTiger(panel, events, BUY_AND_HOLD, { from: WARMUP_DAYS, to: panel.dates.length - 1 });
      console.log(performance(r.ret, r.rf));
      return;
    }
    default:
      console.log("usage: npm run lab -- <fetch|study|holdout [params.json]|forward [params.json] [--mcap USDmm]|baseline>");
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = e instanceof DataError ? 2 : 1;
});
