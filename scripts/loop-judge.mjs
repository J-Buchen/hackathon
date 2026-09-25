#!/usr/bin/env node
// Judge improvement-loop candidates on SEALED arena seeds, world by world.
//
//   node scripts/loop-judge.mjs <from> <count> <baselineDir> <candDir>...
//
// Each dir is a checkout (main or a git worktree prepared with
// scripts/worktree-setup.sh). Runs the arena in each with ARENA_SEALED=1 and
// reports, per candidate and track, the paired utility difference vs the
// baseline checkout with a 90% t-interval.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [from, count, ...dirs] = process.argv.slice(2);
const out = mkdtempSync(join(tmpdir(), "judge-"));
const run = (dir, i) => {
  const file = join(out, `r${i}.json`);
  execFileSync("npx", ["tsx", "packages/lab/src/arena-cli.ts", "eval", "--from", from, "--count", count, "--out", file], {
    cwd: dir, env: { ...process.env, ARENA_SEALED: "1" }, stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 26,
  });
  return JSON.parse(readFileSync(file, "utf8"));
};
const results = dirs.map((d, i) => ({ dir: d, r: run(d, i) }));
const base = results[0].r;
const paired = (a, b, key) => {
  const d = a.perWorld.map((w, i) => w[key] - b.perWorld[i][key]);
  const n = d.length, m = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const h = 1.645 * sd / Math.sqrt(n);
  return { mean: m, lo: m - h, hi: m + h, wins: d.filter((x) => x > 0).length / n };
};
const report = results.slice(1).map(({ dir, r }) => ({
  dir,
  allocator: paired(r, base, "allocator"),
  tiger: paired(r, base, "tiger"),
  summary: { allocator: r.allocator, tiger: r.tiger },
}));
console.log(JSON.stringify({ from: Number(from), count: Number(count), baseline: { dir: dirs[0], allocator: base.allocator, tiger: base.tiger }, candidates: report }, null, 2));
