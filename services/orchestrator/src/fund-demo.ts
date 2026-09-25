/**
 * Allowance — the fund console demo.
 *
 * A multi-manager fund whose PMs are AI agents, on ONE showcase virtual world
 * from the arena (no market data). The same roster runs twice on identical
 * prices: under the center book (the allocator) and with per-agent guardrails
 * only. Prints the seed rule, the world, the head-to-head, the group cuts and
 * stop-outs, and the sealed-loop evidence, then writes
 * `apps/web/public/fund-snapshot.json` for the console.
 *
 * Run:  npm run demo:fund   (from the repo root)
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildFundSnapshot, SHOWCASE_RULE, type BookSummaryView } from "./fund";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)} pp`;
const usd = (x: number) => `${Math.round(x).toLocaleString("en-US")} USDC`;

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

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  const snap = await buildFundSnapshot({ loopsDir: resolve(repoRoot, "docs/loops") });
  const w = snap.world;

  header("1. THE SHOWCASE WORLD (virtual — no market data)", "Pick the world by a rule written down in advance, not by which one looks best.");
  line(`rule: ${SHOWCASE_RULE}`);
  line(`chosen seed: ${w.seed}`);
  line(`${w.stocks.length} virtual stocks (${w.stocks.join(", ")}), ${w.ticks} trading days, AUM ${usd(w.aum)}`);
  line(`crowd: piles into ${w.crowd.instrument} from day ${w.crowd.startTick + 1}, unwinds on day ${w.crowd.crashTick + 1}`);
  line(`${snap.agents.length} agents in ${w.pods.length} pods, ${w.operators.length} operators; ${w.skilled} skilled pickers`);
  for (const o of w.operators.filter((x) => x.agents.length > 1)) line(`operator ${o.id} runs ${o.agents.join(" and ")} under different names`);
  line("(the allocator does not read operator identity yet; operators are flagged on its cuts after the run)");

  header("2. SAME AGENTS, TWO BOOKS", "Both books hold the same agents with the same limits each. Only one looks across them.");
  const row = (name: string, f: (s: BookSummaryView) => string) =>
    line(`${name.padEnd(30)} ${f(snap.books.baseline.summary).padStart(12)} ${f(snap.books.center.summary).padStart(12)}`);
  line(`${"(virtual world)".padEnd(30)} ${"guardrails".padStart(12)} ${"center book".padStart(12)}`);
  row("total return", (s) => signed(s.totalReturn));
  row("max drawdown", (s) => pct(s.maxDrawdown));
  row("sharpe", (s) => s.sharpe.toFixed(2));
  row("certainty equivalent (γ=3)", (s) => signed(s.utility));
  row("stop-outs", (s) => String(s.stopOuts));

  header("3. WHAT THE ALLOCATOR DID", "Every move is a resize on the same mandate tree; a stop-out is one close.");
  line(`decisions: ${Object.entries(snap.decisionCounts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  line(`tree writes: ${snap.resizes} resizes`);
  const oneTrade = snap.groupCuts.filter((g) => g.kind === "CLONES");
  const bookWide = snap.groupCuts.filter((g) => g.kind === "BOOK");
  line(
    `group cuts: ${snap.groupCuts.length} — ${oneTrade.length} one-trade (agents holding overlapping books), ` +
      `${bookWide.length} book-wide (the whole book's net exposure to one name over its cap)`,
  );
  const flagged = oneTrade.filter((g) => g.sharedOperators.length > 0);
  line(
    `shared operator (flagged after the run; the allocator groups by positions, not operator): ` +
      `${flagged.length} of the one-trade cuts included both agents of one operator`,
  );
  for (const g of flagged.slice(0, 4)) {
    line(
      `  day ${g.t + 1}: ${g.members.join(", ")} held one trade in ${g.instrument ?? "one name"}; ` +
        g.sharedOperators.map((o) => `${o.agents.join(" + ")} also share ${o.operator}`).join("; "),
    );
  }
  for (const s of snap.stopOuts) {
    line(`stop-out day ${s.t + 1}: ${s.agent}'s mandate closed, ${usd(s.freed)} back to its pod`);
  }

  header("4. SEALED EVIDENCE", "Every loop is judged on virtual worlds nobody tuned on, then confirmed on a second fresh block.");
  if (snap.evidence.loops.length === 0) line("no sealed loop reports found in docs/loops");
  for (const l of snap.evidence.loops) {
    const merged = l.merged.map((m) => m.angle.split(":")[0]).join(" + ") || "nothing merged";
    line(`loop ${l.loop}: ${l.title ?? merged}`);
    if (l.note) line(`  note: ${l.note}`);
    if (l.blockA) line(`  block A (${l.blocks.A.count} worlds from ${l.blocks.A.from}): ${pp(l.blockA.allocator.mean)} [${pp(l.blockA.allocator.lo)}, ${pp(l.blockA.allocator.hi)}] 90% CI`);
    if (l.blockB) line(`  block B (${l.blocks.B.count} worlds from ${l.blocks.B.from}): ${pp(l.blockB.allocator.mean)} [${pp(l.blockB.allocator.lo)}, ${pp(l.blockB.allocator.hi)}] 90% CI`);
  }

  const out = resolve(repoRoot, "apps/web/public/fund-snapshot.json");
  await writeFile(out, `${JSON.stringify(snap)}\n`, "utf8");
  header("5. SNAPSHOT", "Wrote the console's data file.");
  line(out);
  line("Virtual world: every price, agent and operator is simulated.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
