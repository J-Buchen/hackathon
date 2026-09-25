#!/usr/bin/env node
// Judge improvement-loop candidates on SEALED arena seeds, world by world.
//
//   node scripts/loop-judge.mjs <from> <count> <baselineDir> <candDir>...
//
// Each dir is a checkout (main or a git worktree prepared with
// scripts/worktree-setup.sh). Runs the arena in each with ARENA_SEALED=1 and
// reports, per candidate and track, the paired utility difference vs the
// baseline checkout with a 90% normal-approximation interval (mean ± 1.645 ·
// sd/√n; with n = 200 worlds the t quantile, 1.653, differs in the third
// decimal), plus each checkout's commit and whether it had local changes
// (demo snapshots under apps/web/public do not count: they are not code).
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
const commit = (dir) => {
  const git = (...a) => execFileSync("git", a, { cwd: dir }).toString().trim();
  return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)node_modules", ":(exclude)apps/web/public").length > 0 };
};
const results = dirs.map((d, i) => ({ dir: d, ...commit(d), r: run(d, i) }));
const base = results[0].r;
const paired = (a, b, key) => {
  const d = a.perWorld.map((w, i) => w[key] - b.perWorld[i][key]);
  const n = d.length, m = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const h = 1.645 * sd / Math.sqrt(n);
  return { mean: m, lo: m - h, hi: m + h, wins: d.filter((x) => x > 0).length / n };
};
// Paired risk changes (candidate − baseline): max drawdown and Sharpe per world.
// Checkouts older than loop 2 do not report them; those fields are then null.
const pairedRisk = (a, b, key) => (a.perWorld[0]?.[key] === undefined || b.perWorld[0]?.[key] === undefined ? null : paired(a, b, key));
const report = results.slice(1).map(({ dir, sha, dirty, r }) => ({
  dir,
  sha,
  dirty,
  allocator: paired(r, base, "allocator"),
  tiger: paired(r, base, "tiger"),
  risk: {
    allocatorMaxDD: pairedRisk(r, base, "allocatorMaxDD"),
    allocatorSharpe: pairedRisk(r, base, "allocatorSharpe"),
    tigerMaxDD: pairedRisk(r, base, "tigerMaxDD"),
    tigerSharpe: pairedRisk(r, base, "tigerSharpe"),
  },
  summary: { allocator: r.allocator, tiger: r.tiger },
}));
console.log(JSON.stringify({ from: Number(from), count: Number(count), baseline: { dir: dirs[0], sha: results[0].sha, dirty: results[0].dirty, allocator: base.allocator, tiger: base.tiger }, candidates: report }, null, 2));
