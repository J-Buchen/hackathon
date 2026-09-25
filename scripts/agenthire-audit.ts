/**
 * Shadow audit of a running AgentHire: capture its own agent-to-agent (A2A)
 * hires and replay every sub-agent payment through Allowance's pay().
 *
 *   bash scripts/agenthire-up.sh                     # AgentHire on 127.0.0.1:5301
 *   npx tsx scripts/agenthire-audit.ts               # poll 60s, print the headline
 *
 * Options:
 *   --base URL      AgentHire base URL (default $AGENTHIRE_URL or http://127.0.0.1:5301,
 *                   the same default as scripts/agenthire-up.sh and the demo)
 *   --seconds N     how long to poll /api/sim/events (default 60)
 *   --tick S        AgentHire sim tick (real seconds) while capturing; AgentHire's
 *                   own POST /api/sim/speed, restored afterwards (default 0.1,
 *                   AgentHire's minimum; its default is 5). --tick 0 leaves it alone.
 *   --save FILE     also write the capture (events + quotes + workflows) as JSON
 *   --replay FILE   audit a saved capture offline instead of polling
 *   --json FILE     write the full report as JSON
 *   --organic-only  drop AgentHire's demo-cascade jobs (meta.demo: force-all
 *                   triggers, synthetic buyer, nobody paid the primary) and
 *                   audit only jobs from matched buyer bids
 *   --allow-remote  permit a non-loopback base URL (AgentHire's money routes are
 *                   unauthenticated; only run it on 127.0.0.1)
 *
 * Everything replayed is AgentHire's SIMULATED marketplace activity; nothing is
 * settled and no funds move (the settlement port only records). The headline
 * count is the one the replay decides (AgentHire's own displayed Hard Spend
 * Cap); under `strict` every sub-agent fee is outside the buyer's
 * authorization by definition, and that is printed as a total, not a finding.
 */

import { readFile, writeFile } from "node:fs/promises";
import {
  auditJsonReplacer,
  collectSimEvents,
  parseSimEvent,
  runShadowAudit,
  linkPrimaryJobs,
  type A2AWorkflowLike,
  type AgentHireQuoteLike,
  type AgentHireSimEvent,
  type SimEventSource,
} from "@allowance/adapters";

interface Capture {
  capturedAt: string;
  base: string;
  seconds: number;
  tickRealSeconds: number | null;
  missed: number;
  polls: number;
  events: AgentHireSimEvent[];
  quotes: AgentHireQuoteLike[];
  workflows: A2AWorkflowLike[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function getJson(base: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  return res.json();
}

function httpSource(base: string): SimEventSource {
  return {
    async eventsSince(sinceId, limit) {
      const body = (await getJson(base, `/api/sim/events?since=${sinceId}&limit=${limit}`)) as {
        events?: unknown[];
      };
      return (body.events ?? []).map(parseSimEvent).filter((e): e is AgentHireSimEvent => e !== null);
    },
  };
}

function toQuote(raw: unknown): AgentHireQuoteLike | null {
  const q = raw as Partial<AgentHireQuoteLike> | null;
  if (!q || typeof q.agentId !== "number" || typeof q.maxPrice !== "number") return null;
  return { agentId: q.agentId, minPrice: q.minPrice ?? 0, maxPrice: q.maxPrice, currentPrice: q.currentPrice };
}

async function capture(base: string, seconds: number, tick: number): Promise<Capture> {
  const host = new URL(base).hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback && !flag("allow-remote")) {
    throw new Error(`refusing non-loopback AgentHire at ${base} (pass --allow-remote to override)`);
  }
  await getJson(base, "/api/health");
  const status = (await getJson(base, "/api/sim/status")) as { running?: boolean; tickRealSeconds?: number };
  if (!status.running) await getJson(base, "/api/sim/start", { method: "POST", body: "{}" });
  const originalTick = typeof status.tickRealSeconds === "number" ? status.tickRealSeconds : null;
  if (tick > 0) {
    await getJson(base, "/api/sim/speed", { method: "POST", body: JSON.stringify({ tickRealSeconds: tick }) });
    console.error(`sim tick set to ${tick}s (was ${originalTick ?? "?"}s) via POST /api/sim/speed`);
  }

  let collected;
  try {
    console.error(`polling ${base}/api/sim/events for ${seconds}s ...`);
    collected = await collectSimEvents(httpSource(base), {
      durationMs: seconds * 1000,
      pollMs: 1000,
      limit: 500,
      onPoll: ({ total, lastId }) => {
        if (process.stderr.isTTY) process.stderr.write(`\r  ${total} events (last id ${lastId})   `);
      },
    });
    if (process.stderr.isTTY) process.stderr.write("\n");
  } finally {
    if (tick > 0 && originalTick !== null) {
      await getJson(base, "/api/sim/speed", {
        method: "POST",
        body: JSON.stringify({ tickRealSeconds: originalTick }),
      }).catch((e) => console.error(`warning: could not restore sim speed: ${e}`));
    }
  }

  const linked = linkPrimaryJobs(collected.events);
  const primaryIds = [...new Set(linked.jobs.map((j) => j.primaryId))].sort((a, b) => a - b);
  const quotes: AgentHireQuoteLike[] = [];
  for (const id of primaryIds) {
    const q = toQuote(await getJson(base, `/api/pricing/quote/${id}`).catch(() => null));
    if (q) quotes.push(q);
  }
  const cand = (await getJson(base, "/api/sim/a2a-candidates").catch(() => ({ flagships: [] }))) as {
    flagships?: A2AWorkflowLike[];
  };
  return {
    capturedAt: new Date().toISOString(),
    base,
    seconds,
    tickRealSeconds: tick > 0 ? tick : originalTick,
    missed: collected.missed,
    polls: collected.polls,
    events: collected.events,
    quotes,
    workflows: (cand.flagships ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      subAgents: (f.subAgents ?? []).map((s) => ({ id: s.id, name: s.name, estCostHigh: s.estCostHigh ?? null })),
    })),
  };
}

async function main(): Promise<void> {
  const replay = arg("replay");
  const base = (arg("base") ?? process.env.AGENTHIRE_URL ?? "http://127.0.0.1:5301").replace(/\/+$/, "");
  const seconds = Number(arg("seconds") ?? 60);
  const tick = Number(arg("tick") ?? 0.1);

  const cap: Capture = replay
    ? (JSON.parse(await readFile(replay, "utf8")) as Capture)
    : await capture(base, seconds, tick);
  if (!replay && arg("save")) {
    await writeFile(arg("save")!, JSON.stringify(cap, null, 2) + "\n", "utf8");
    console.error(`capture saved to ${arg("save")}`);
  }

  const events = cap.events.map(parseSimEvent).filter((e): e is AgentHireSimEvent => e !== null);
  const report = await runShadowAudit({
    events,
    quotes: cap.quotes,
    workflows: cap.workflows,
    source: `${cap.base} /api/sim/events, ${cap.seconds}s capture at ${cap.capturedAt} (simulated marketplace)`,
    organicOnly: flag("organic-only"),
  });
  const o = report.outsideAuthorization;

  const line = "-".repeat(78);
  console.log(line);
  console.log("AgentHire SHADOW AUDIT  (replayed through Allowance pay(); simulated data, nothing settled)");
  console.log(line);
  console.log(`source   ${report.source}`);
  console.log(
    `window   ${report.window.events} events, ids ${report.window.firstEventId}..${report.window.lastEventId}` +
      (cap.missed ? `, ${cap.missed} ids missed between polls` : ", no gaps"),
  );
  console.log(`budget   ${report.assumption}   [headline scenario: ${report.headlineScenario}]`);
  console.log(`sizing   ${report.sizing}`);
  console.log(line);
  console.log(
    `${report.blocked} of ${report.subPayments} sub-agent payments would have been blocked even under AgentHire's own ` +
      `displayed Hard Spend Cap (${report.blockedUSDC} of ${report.totalSubUSDC} USDC unbudgeted).`,
  );
  console.log(
    `All ${o.payments} (${o.usdc} USDC) were outside what the buyer authorized for the primary job, BY DEFINITION ` +
      `(AgentHire pays sub-agents on top of the primary's price, from the primary agent's wallet).`,
  );
  console.log(
    `Priced at ${report.primaryUSDC} USDC for ${report.primaries} simulated primary jobs; ${report.demoPrimaries} of them are ` +
      `AgentHire's force-all demo cascade with no paying buyer` +
      (report.organicOnly ? ` (--organic-only dropped ${report.droppedDemoPrimaries} such jobs)` : "") +
      ".",
  );
  console.log(line);
  console.log("each buyer cap, same payments:");
  for (const s of report.sensitivity) {
    const what = s.scenario === "strict" ? "outside the buyer's authorization (by definition)" : "blocked by the replay";
    console.log(
      `  ${s.scenario.padEnd(17)} ${String(s.blocked).padStart(4)} of ${s.subPayments} ${what}, ` +
        `${s.blockedUSDC} USDC   (${s.assumption})`,
    );
  }
  console.log("hiring agents (sub-agent fees vs. their simulated primary price):");
  for (const p of report.byPrimary) {
    console.log(
      `  #${String(p.agentId).padEnd(4)} ${(p.name ?? "?").padEnd(18)} ${String(p.jobs).padStart(3)} jobs  ` +
        `simulated revenue ${p.priceUSDC}  sub-agent fees ${p.subUSDC}  = ${p.ratio}x  ` +
        `blocked hardSpendCap ${p.blockedBy.hardSpendCap}/${p.subPayments}, primaryFundsSubs ${p.blockedBy.primaryFundsSubs}; ` +
        `strict (by definition) ${p.blockedBy.strict}`,
    );
  }
  console.log(`sub-agents (headline: ${report.headlineScenario}):`);
  for (const a of report.byAgent) {
    console.log(
      `  #${String(a.agentId).padEnd(4)} ${(a.name ?? "?").padEnd(18)} parents [${a.parents.join(",")}]` +
        `  ${a.blocked}/${a.payments} blocked  ${a.blockedUSDC}/${a.usdc} USDC` +
        `  (primaryFundsSubs ${a.blockedBy.primaryFundsSubs}; strict by definition ${a.blockedBy.strict})`,
    );
  }
  if (report.cycles.length) {
    console.log(
      `cycles   ${report.cycles.map(([a, b]) => `${a}<->${b}`).join(", ")} (each direction is its own alias node)`,
    );
  }
  if (report.multiParent.length) {
    console.log(`shared   agents ${report.multiParent.join(", ")} have several parents (one alias per parent)`);
  }
  console.log(
    `jobs     ${report.primaries} primary jobs hired sub-agents; ${report.demoPrimaries} of them came from ` +
      `AgentHire's periodic force-all demo cascade (meta.demo: every trigger fires, synthetic buyer, nobody paid the ` +
      `primary), the rest from matched buyer bids`,
  );
  for (const n of report.notes) console.log(`note     ${n}`);
  const x = report.excluded;
  console.log(
    `excluded ${x.directHires} direct trigger hires, ${x.orphanHires} hires without their primary in the window; ` +
      `${x.soloJobs} single-agent jobs had no sub-agents`,
  );
  console.log(line);

  if (arg("json")) {
    await writeFile(arg("json")!, JSON.stringify(report, auditJsonReplacer, 2) + "\n", "utf8");
    console.error(`report written to ${arg("json")}`);
  }
  if (report.subPayments === 0) {
    console.error("no sub-agent hires captured; poll longer (--seconds) or check the sim is running");
    process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(`agenthire-audit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
