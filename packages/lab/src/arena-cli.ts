/**
 * Arena CLI.
 *
 *   npm run arena -- eval --from 1 --count 100 [--out file.json]
 *
 * Research seeds are < 10000. Seeds ≥ 10000 are sealed for judging and need
 * ARENA_SEALED=1 (set only by the improvement-loop driver).
 */

import { writeFile } from "node:fs/promises";
import { evaluate, ARENA_EVAL_FLOOR } from "./arena";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "eval") {
    console.log(`usage: npm run arena -- eval --from <seed> --count <n> [--out file.json]   (seeds ≥ ${ARENA_EVAL_FLOOR} sealed)`);
    return;
  }
  const from = Number(arg("from", "1"));
  const count = Number(arg("count", "50"));
  const t0 = Date.now();
  const r = await evaluate({ from, count, sealed: process.env.ARENA_SEALED === "1" });
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  for (const [name, s] of Object.entries({ allocator: r.allocator, tiger: r.tiger })) {
    console.log(
      `${name.padEnd(9)} utility ${pct(s.utility)} vs baseline ${pct(s.baseline)} | uplift ${pct(s.uplift)} [90% ${pct(s.upliftLo)}, ${pct(s.upliftHi)}] ` +
        `| wins ${(s.winRate * 100).toFixed(0)}% | Sharpe ${s.sharpe.toFixed(2)} vs ${s.baselineSharpe.toFixed(2)} | maxDD ${pct(s.maxDD)} vs ${pct(s.baselineMaxDD)}` +
          (s.maxDDAtBaselineVol !== undefined ? ` (${pct(s.maxDDAtBaselineVol)} at the baseline's vol)` : ""),
    );
  }
  console.log(`${count} worlds (seeds ${from}–${from + count - 1}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const out = arg("out");
  if (out) await writeFile(out, JSON.stringify({ from, count, ...r }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
