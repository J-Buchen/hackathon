#!/usr/bin/env node
// Improvement-loop driver: turns a loop's reviewed proposals into a verdict.
//
//   node scripts/loop-driver.mjs <loop> <proposals.json> <out.json>
//
// Protocol (all on SEALED arena seeds, never seen by researchers):
//   1. Each proposal that passed code review is applied to a fresh git
//      worktree at HEAD; package tests must pass.
//   2. Selection: judged world-by-world vs HEAD on block A. A PERFORMANCE
//      proposal (track allocator/tiger/both) wins if its target track's paired
//      uplift has a 90% lower bound > 0 and the other track's mean change is
//      > -0.1 percentage points. A STRUCTURE proposal (track "structure": new
//      tested guarantees such as reservation or subtree close, not a return
//      claim) wins if it does not hurt: both tracks' mean change > -0.05 pp
//      and lower bound > -0.2 pp.
//   3. Winners are combined (best first; any that no longer applies is dropped)
//      and the combination must CONFIRM on a separate block B (target track
//      lower bound > 0). Otherwise the best single winner is tried on B.
//   4. Output: the diff to merge (or none) and every number, winners or not.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const [loopArg, proposalsFile, outFile] = process.argv.slice(2);
const L = Number(loopArg);
const REPO = execSync("git rev-parse --show-toplevel").toString().trim();
const A = { from: 10000 + L * 1000, count: 200 };
const B = { from: 10000 + L * 1000 + 500, count: 200 };
const proposals = JSON.parse(readFileSync(proposalsFile, "utf8")).proposals ?? [];
const root = `/tmp/loops/L${L}`;
mkdirSync(root, { recursive: true });

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 27 }).toString();
function worktree(name, diffs) {
  const dir = join(root, name);
  try { sh(`git worktree remove --force ${dir}`, REPO); } catch {}
  rmSync(dir, { recursive: true, force: true });
  sh(`git worktree add -q --detach ${dir} HEAD`, REPO);
  const applied = [];
  for (const [i, d] of diffs.entries()) {
    const f = join(root, `${name}-${i}.diff`);
    writeFileSync(f, d.endsWith("\n") ? d : d + "\n");
    try { sh(`git apply --whitespace=nowarn ${f}`, dir); applied.push(i); } catch (e) { /* dropped */ }
  }
  sh(`bash scripts/worktree-setup.sh ${REPO}`, dir);
  return { dir, applied };
}
function testsPass(dir) {
  try {
    sh("npx tsc -b tsconfig.json", dir);
    sh("npm -w @allowance/swarm run test", dir);
    sh("npm -w @allowance/lab run test", dir);
    return true;
  } catch { return false; }
}
function judge(block, dirs) {
  const out = execFileSync("node", ["scripts/loop-judge.mjs", String(block.from), String(block.count), REPO, ...dirs], { cwd: REPO, maxBuffer: 1 << 27 }).toString();
  return JSON.parse(out);
}
const target = (p) => (p.track === "both" ? ["allocator", "tiger"] : p.track === "structure" ? [] : [p.track]);
const other = (p) => (p.track === "allocator" ? ["tiger"] : p.track === "tiger" ? ["allocator"] : p.track === "structure" ? ["allocator", "tiger"] : []);
const neutral = (c) => ["allocator", "tiger"].every((t) => c[t].mean > -0.0005 && c[t].lo > -0.002);

const report = { loop: L, blocks: { A, B }, candidates: [], merged: null };
const live = [];
for (const [k, p] of proposals.entries()) {
  const entry = { k, angle: p.angle, track: p.track, hypothesis: p.hypothesis, reviewOk: !!p.review?.ok, reviewProblems: p.review?.problems ?? [] };
  report.candidates.push(entry);
  if (!p.review?.ok || !p.diff?.trim()) { entry.status = "rejected-review"; continue; }
  const wt = worktree(`c${k}`, [p.diff]);
  if (wt.applied.length === 0) { entry.status = "does-not-apply"; continue; }
  if (!testsPass(wt.dir)) { entry.status = "tests-fail"; continue; }
  live.push({ k, p, dir: wt.dir, entry });
}
if (live.length) {
  const res = judge(A, live.map((c) => c.dir));
  res.candidates.forEach((c, i) => {
    const e = live[i].entry;
    e.blockA = { allocator: c.allocator, tiger: c.tiger };
    const p = live[i].p;
    if (p.track === "structure") {
      e.status = neutral(c) ? "winner-A" : "harms-A";
      return;
    }
    const up = target(p).every((t) => c[t].lo > 0);
    const safe = other(p).every((t) => c[t].mean > -0.001);
    e.status = up && safe ? "winner-A" : "no-uplift-A";
  });
  report.baselineA = res.baseline;
}
const winners = live.filter((c) => c.entry.status === "winner-A")
  .sort((x, y) => {
    const score = (c) => (target(c.p).length ? Math.max(...target(c.p).map((t) => c.entry.blockA[t].mean)) : -1);
    return score(y) - score(x);
  });
const tryConfirm = (set, label) => {
  const wt = worktree(label, set.map((c) => c.p.diff));
  const kept = wt.applied.map((i) => set[i]);
  if (!kept.length || !testsPass(wt.dir)) return null;
  const res = judge(B, [wt.dir]);
  const c = res.candidates[0];
  const tracks = [...new Set(kept.flatMap((x) => target(x.p)))];
  // Performance tracks must confirm a gain; untargeted tracks (and pure
  // structure changes) must confirm they are not harmed.
  const ok =
    tracks.every((t) => c[t].lo > 0) &&
    ["allocator", "tiger"].filter((t) => !tracks.includes(t)).every((t) => c[t].mean > -0.0005 && c[t].lo > -0.002);
  return { ok, kept: kept.map((x) => x.k), blockB: { allocator: c.allocator, tiger: c.tiger }, baselineB: res.baseline, dir: wt.dir };
};
if (winners.length) {
  let conf = winners.length > 1 ? tryConfirm(winners, "combined") : null;
  if (!conf?.ok) conf = tryConfirm([winners[0]], "best");
  if (conf) {
    report.confirmation = { ok: conf.ok, kept: conf.kept, blockB: conf.blockB, baselineB: conf.baselineB };
    if (conf.ok) {
      const diff = sh("git add -A && git diff --cached HEAD -- . ':(exclude)node_modules'", conf.dir);
      writeFileSync(join(root, "merge.diff"), diff);
      report.merged = { kept: conf.kept, diffFile: join(root, "merge.diff") };
    }
  }
}
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ loop: L, merged: report.merged, candidates: report.candidates.map((c) => ({ angle: c.angle, status: c.status })) }, null, 2));
