/**
 * Shadow-audit tests. The main fixture is a RECORDED capture of an unmodified
 * AgentHire (scripts/agenthire-up.sh + scripts/agenthire-audit.ts --save),
 * trimmed to 3 A2A jobs per flagship plus marketplace noise; small synthetic
 * event lists cover the edge cases (cycles inside one job, orphans, gaps).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  agentMerchant,
  aliasLabel,
  auditHeadline,
  auditJsonReplacer,
  collectSimEvents,
  linkPrimaryJobs,
  parseSimEvent,
  replayJob,
  runShadowAudit,
  scenarioCap,
  upperEstimate,
  usdcToMicro,
  type A2AWorkflowLike,
  type AgentHireQuoteLike,
  type AgentHireSimEvent,
  type PrimaryJob,
  type SimEventSource,
} from "./agenthire-audit";
import {
  AgentHireClient,
  AgentHireScreeningService,
  IncidentLedger,
  OperatorRegistry,
  agentHireMerchant,
  parseAgentHireMerchant,
  type FetchLike,
} from "./agenthire";

interface Fixture {
  events: unknown[];
  quotes: AgentHireQuoteLike[];
  workflows: A2AWorkflowLike[];
  directTrigger: { events: unknown[] };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/agenthire-sim-capture.json", import.meta.url), "utf8"),
) as Fixture;
const parse = (raw: unknown[]): AgentHireSimEvent[] =>
  raw.map(parseSimEvent).filter((e): e is AgentHireSimEvent => e !== null);
const recorded = parse(fixture.events);
const direct = parse(fixture.directTrigger.events);

let nextId = 1;
function ev(kind: string, agentId: number | null, amountUSDC: number, meta: Record<string, unknown> = {}, message = ""): AgentHireSimEvent {
  return { id: nextId++, ts: 1_790_000_000 + nextId, kind, agentId, message, amountUSDC, meta };
}
function hire(primaryId: number, subAgentId: number, amountUSDC: number, extra: Record<string, unknown> = {}): AgentHireSimEvent {
  return ev("a2a_hire", primaryId, amountUSDC, { primaryId, subAgentId, subAgentName: `agent${subAgentId}`, ...extra });
}

/* ---------------- parsing + linking (recorded) ---------------- */

test("parseSimEvent keeps AgentHire's wire shape and rejects junk", () => {
  assert.equal(recorded.length, fixture.events.length);
  assert.equal(parseSimEvent(null), null);
  assert.equal(parseSimEvent({ kind: "settle" }), null);
  const e = parseSimEvent({ id: 5, kind: "settle", agentId: 1, amountUSDC: "x", meta: [] });
  assert.deepEqual(e?.meta, {});
  assert.equal(e?.amountUSDC, 0);
  assert.equal(usdcToMicro(53.2652), 53_265200n);
  assert.equal(usdcToMicro(-1), 0n);
});

test("recorded capture: every hire links to its primary's preceding settle", () => {
  const linked = linkPrimaryJobs(recorded);
  assert.equal(linked.jobs.length, 12, "3 A2A jobs per flagship (1, 3, 4, 7)");
  assert.deepEqual([...new Set(linked.jobs.map((j) => j.primaryId))].sort((a, b) => a - b), [1, 3, 4, 7]);
  assert.equal(linked.jobs.flatMap((j) => j.hires).length, 21);
  assert.equal(linked.orphanHires.length, 0);
  assert.equal(linked.directHires.length, 0);
  assert.equal(linked.soloJobs, 4, "the solo settles in the noise hire nobody");
  for (const job of linked.jobs) {
    for (const h of job.hires) {
      assert.equal(h.hirerId, job.primaryId);
      assert.ok(h.eventId > job.settleEventId && h.eventId - job.settleEventId <= 4);
    }
  }
  // job2182: CodeReview Pro settled 9.59 USDC, then hired SecureAudit AI and TestingMaster.
  const cr = linked.jobs.find((j) => j.key === "job2182")!;
  assert.equal(cr.primaryName, "CodeReview Pro");
  assert.equal(cr.price, 9_590000n);
  assert.equal(cr.tokensUsed, 4795);
  assert.deepEqual(cr.hires.map((h) => [h.subAgentId, h.amount]), [[7, 53_265200n], [10, 14_321500n]]);
  assert.equal(cr.hires[0]!.trigger, "Security issues detected");
});

test("recorded direct trigger (POST /api/sim/trigger-direct) is excluded, not audited", () => {
  const linked = linkPrimaryJobs([...recorded, ...direct]);
  assert.equal(linked.jobs.length, 12);
  assert.equal(linked.directHires.length, 1);
  assert.equal(linked.directHires[0]!.subAgentId, 5);
  assert.equal(linked.directHires[0]!.amount, 250000n);
});

/* ---------------- the audit (recorded) ---------------- */

test("recorded capture: headline under AgentHire's Hard Spend Cap, strict total by definition, sensitivity, per-agent rows", async () => {
  const r = await runShadowAudit({ events: [...recorded, ...direct], quotes: fixture.quotes, workflows: fixture.workflows });
  assert.equal(r.simulated, true);
  assert.equal(r.primaries, 12);
  assert.equal(r.demoPrimaries, 12, "every recorded job is AgentHire's force-all demo cascade");
  assert.equal(r.organicOnly, false);
  assert.equal(r.subPayments, 21);
  // The headline is a number the replay decides: some payments fit under the cap, some do not.
  assert.equal(r.headlineScenario, "hardSpendCap");
  assert.equal(r.blocked, 3);
  assert.equal(r.blockedUSDC, "99.981600");
  assert.ok(r.blocked > 0 && r.blocked < r.subPayments);
  // Under strict every sub-agent fee is outside the buyer's authorization by definition.
  assert.equal(r.outsideAuthorization.payments, 21);
  assert.equal(r.outsideAuthorization.micro, r.totalSubMicro);
  assert.match(r.outsideAuthorization.definition, /BY DEFINITION/);
  assert.equal(r.totalSubUSDC, "455.253500");
  assert.equal(r.primaryUSDC, "685.452000");
  assert.equal(r.ratioSubToPrimary, 0.66);
  assert.equal(r.excluded.directHires, 1);
  assert.equal(r.excluded.directMicro, 250000n);
  assert.ok(r.notes.some((n) => /primary agent's wallet/i.test(n)));

  const s = Object.fromEntries(r.sensitivity.map((x) => [x.scenario, x]));
  assert.equal(s.strict!.blocked, 21);
  assert.equal(s.primaryFundsSubs!.blocked, 8);
  assert.equal(s.primaryFundsSubs!.blockedUSDC, "159.721600");
  assert.equal(s.hardSpendCap!.blocked, 3);
  assert.equal(s.hardSpendCap!.blockedUSDC, "99.981600");
  for (const x of r.sensitivity) assert.equal(x.subPayments, 21);

  const cr = r.byPrimary.find((p) => p.agentId === 1)!;
  assert.equal(r.byPrimary[0], cr, "CodeReview Pro has the worst sub-agent / revenue ratio");
  assert.equal(cr.ratio, 6.07);
  assert.deepEqual(cr.blockedBy, { strict: 6, primaryFundsSubs: 6, hardSpendCap: 3 });

  // Cycles and shared children are aliased per parent, never merged.
  assert.deepEqual(r.cycles, [[1, 7]]);
  assert.deepEqual(r.multiParent, [6]);
  const research = r.byAgent.find((a) => a.agentId === 6)!;
  assert.equal(research.name, "ResearchBot Pro");
  assert.deepEqual(research.parents, [3, 4]);
  assert.deepEqual(research.aliases.sort(), ["a6-via-a3", "a6-via-a4"]);
  assert.equal(r.byAgent.find((a) => a.agentId === 5)!.name, "WebCrawler X");

  const headline = auditHeadline(r);
  assert.match(headline, /^3 of 21 sub-agent payments would have been blocked even under AgentHire's own displayed Hard Spend Cap \(99\.981600 of 455\.253500 USDC unbudgeted\)/);
  assert.match(headline, /All 21 \(455\.253500 USDC\) were outside what the buyer authorized for the primary job, by definition/);
  assert.match(headline, /12 simulated primary jobs \(12 of them AgentHire's force-all demo cascade with no paying buyer\)/);
  assert.match(headline, /simulated AgentHire marketplace; assumption: buyer cap = AgentHire checkout's own displayed 'Hard Spend Cap'/);
  const json = JSON.parse(JSON.stringify(r, auditJsonReplacer)) as { blockedMicro: string; outsideAuthorization: { micro: string } };
  assert.equal(json.blockedMicro, "99981600");
  assert.equal(json.outsideAuthorization.micro, "455253500");
});

test("organicOnly drops AgentHire's demo-cascade jobs before the replay", async () => {
  const organic = await runShadowAudit({ events: [...recorded, ...direct], quotes: fixture.quotes, workflows: fixture.workflows, organicOnly: true });
  assert.equal(organic.organicOnly, true);
  assert.equal(organic.primaries, 0, "the recorded capture has no matched-bid A2A job");
  assert.equal(organic.droppedDemoPrimaries, 12);
  assert.equal(organic.subPayments, 0);

  const mixed = [
    ev("settle", 1, 10, { tokensUsed: 1000 }, "CodeReview Pro settled a 1000-token job"),
    hire(1, 7, 4),
    ev("settle", 3, 10, { tokensUsed: 1000, demo: true }, "DataSift Analytics settled a 1000-token job, now routing sub-calls"),
    hire(3, 5, 2),
  ];
  const r = await runShadowAudit({ events: mixed, organicOnly: true });
  assert.equal(r.primaries, 1);
  assert.equal(r.demoPrimaries, 0);
  assert.equal(r.droppedDemoPrimaries, 1);
  assert.equal(r.subPayments, 1);
  assert.match(auditHeadline(r), /1 simulated primary jobs \(0 of them AgentHire's force-all demo cascade with no paying buyer; 1 demo jobs dropped\)/);
});

test("hard spend cap = 1.25 x (tokens x quote maxPrice + sum est_cost_high), as AgentHire checkout shows it", async () => {
  const job = linkPrimaryJobs(recorded).jobs.find((j) => j.key === "job2182")!;
  const ctx = {
    quotes: new Map(fixture.quotes.map((q) => [q.agentId, q])),
    workflows: new Map(fixture.workflows.map((w) => [w.id, w])),
  };
  // 4795 tokens x 0.008 + (0.012 + 0.006) = 38.378 -> x1.25 = 47.9725
  assert.equal(upperEstimate(job, ctx), 38_378000n);
  assert.equal(scenarioCap(job, "hardSpendCap", ctx), 47_972500n);
  assert.equal(scenarioCap(job, "strict", ctx), job.price);
  // Without a quote the upper estimate never drops below what was charged.
  assert.equal(upperEstimate(job, {}), job.price);

  const replay = await replayJob(job, "hardSpendCap", ctx);
  // Primary paid 9.59 first -> 38.3825 left: SecureAudit's 53.27 is blocked, TestingMaster's 14.32 fits.
  assert.deepEqual(replay.payments.map((p) => [p.hire.subAgentId, p.record.outcome]), [
    [7, "BLOCKED_MANDATE"],
    [10, "SETTLED"],
  ]);
  const root = `${job.key}.shadow.eth`;
  assert.equal(replay.tree.available(root), 47_972500n - 9_590000n - 14_321500n);
  // The blocked alias was shrunk back to what it spent (nothing): no authority stranded.
  assert.equal(replay.tree.requireNode(`a7-via-a1.${root}`).mandate.budget, 0n);
  // Recording settlement saw only what pay() let through; nothing moved on any network.
  assert.deepEqual(replay.settlement.requests.map((q) => [q.merchant, q.amount]), [
    ["agenthire:1", 9_590000n],
    ["agenthire:10", 14_321500n],
  ]);
});

test("the replay names merchants like the adapters do, so AgentHire operator screening plugs in", async () => {
  const j = linkPrimaryJobs(recorded).jobs.find((x) => x.key === "job2182")!;
  assert.equal(parseAgentHireMerchant(agentMerchant(10)), 10);
  assert.equal(agentMerchant(10), agentHireMerchant(10));

  // A minimal AgentHire: three agents, three operators, clean reputations.
  const wallets: Record<number, string> = {
    1: "0x3a50cd20f4ef2c19f7616d2b81d9de784ea0d4fa",
    7: "0xf5aff70e7d78473ea14f7110af047fd144f638e4",
    10: "0xa34a8dcb86249dac8d611cfdd0713e672ba72143",
  };
  const fetch: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    const id = Number(/\/api\/agents\/(\d+)/.exec(path)?.[1]);
    const body = path.endsWith("/reputation")
      ? { score: 600, tier: 2, tasksCompleted: 10, incidentCount: 0, simulated: true }
      : path.endsWith("/stake")
        ? { stakedUSDC: "1", incidentCount: 0, banned: false, simulated: true }
        : { id, name: `agent${id}`, deployer_wallet: wallets[id] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new AgentHireClient("http://127.0.0.1:5055", fetch);
  const operators = new OperatorRegistry();
  const incidents = new IncidentLedger();
  await incidents.record(await operators.bindFromAgentHire(client, 10), { kind: "mandate_overspend", reason: "test" });
  const screening = new AgentHireScreeningService({ client, operators, incidents });
  const ctx = {
    quotes: new Map(fixture.quotes.map((q) => [q.agentId, q])),
    workflows: new Map(fixture.workflows.map((w) => [w.id, w])),
    screening,
  };

  const replay = await replayJob(j, "hardSpendCap", ctx);
  // 7 is over the cap (mandate); 10 would fit, but its operator has an incident (screening).
  assert.deepEqual(replay.payments.map((p) => [p.hire.subAgentId, p.record.outcome]), [
    [7, "BLOCKED_MANDATE"],
    [10, "BLOCKED_SCREENING"],
  ]);
  assert.match(replay.payments[1]!.record.reason ?? "", /operator 0xa34a8dcb86249dac8d611cfdd0713e672ba72143 .* has 1 Allowance incident/);
  const report = await runShadowAudit({ events: recorded, quotes: fixture.quotes, workflows: fixture.workflows, screening });
  assert.ok(report.blocked > 3, "operator screening blocks more than the cap alone");
});

/* ---------------- replay mechanics (synthetic) ---------------- */

function job(events: AgentHireSimEvent[]): PrimaryJob {
  const linked = linkPrimaryJobs(events);
  assert.equal(linked.jobs.length, 1);
  return linked.jobs[0]!;
}

test("strict: every payment runs through pay() and is blocked by the mandate", async () => {
  const j = job([ev("settle", 1, 10, { tokensUsed: 1000 }, "CodeReview Pro settled a 1000-token job"), hire(1, 7, 4), hire(1, 10, 3)]);
  const r = await replayJob(j, "strict");
  assert.deepEqual(r.payments.map((p) => p.record.outcome), ["BLOCKED_MANDATE", "BLOCKED_MANDATE"]);
  assert.match(r.payments[0]!.record.reason ?? "", /exceeds available 0/);
  const pays = r.tree.events.filter((e) => e.type === "PAYMENT");
  assert.deepEqual(pays.map((e) => [e.node.split(".")[0], e.result]), [
    ["main", "SETTLED"],
    ["a7-via-a1", "BLOCKED_MANDATE"],
    ["a10-via-a1", "BLOCKED_MANDATE"],
  ]);
  assert.equal(r.tree.available(`${j.key}.shadow.eth`), 0n);
});

test("primaryFundsSubs: first-come out of the primary's price, primary keeps the rest", async () => {
  const j = job([ev("settle", 4, 10), hire(4, 6, 4), hire(4, 11, 7), hire(4, 6, 3)]);
  const r = await replayJob(j, "primaryFundsSubs");
  assert.deepEqual(r.payments.map((p) => p.record.outcome), ["SETTLED", "BLOCKED_MANDATE", "SETTLED"]);
  const root = `${j.key}.shadow.eth`;
  // Same edge twice -> one alias node grown in place, not a second node.
  assert.equal(r.tree.requireNode(`a6-via-a4.${root}`).mandate.spentDirect, 7_000000n);
  assert.equal(r.tree.requireNode(`a11-via-a4.${root}`).mandate.budget, 0n);
  assert.equal(r.tree.requireNode(`main.${root}`).mandate.spentDirect, 3_000000n);
  assert.equal(r.tree.available(root), 0n);
});

test("cycle inside one job: 1 hires 7 and 7 hires 1 -> two alias nodes, neither is 'main'", async () => {
  // AgentHire's feed only nests one level (the cycle shows up across jobs, as in
  // the recorded capture), so build the nested job directly.
  const sub = (eventId: number, hirerId: number, subAgentId: number) => ({
    eventId,
    ts: 1_790_000_100,
    hirerId,
    subAgentId,
    amount: 5_000000n,
  });
  const j: PrimaryJob = {
    key: "job900",
    settleEventId: 900,
    primaryId: 1,
    ts: 1_790_000_000,
    price: 100_000000n,
    tokensUsed: null,
    demo: false,
    hires: [sub(901, 1, 7), sub(903, 7, 1)],
  };
  const r = await replayJob(j, "primaryFundsSubs");
  const names = r.tree.listNodes().map((n) => n.name.split(".")[0]);
  assert.deepEqual(names, ["job" + j.settleEventId, "a7-via-a1", "a1-via-a7", "main"]);
  assert.notEqual(aliasLabel(1, 7), aliasLabel(7, 1));
  assert.ok(r.payments.every((p) => p.record.outcome === "SETTLED"));
  // Aliases are merchant-scoped: a7-via-a1 may only pay agent 7.
  assert.deepEqual(r.tree.requireNode(`a7-via-a1.job${j.settleEventId}.shadow.eth`).mandate.allowedMerchants, ["agenthire:7"]);
});

test("linking: orphans, direct hires, stale settles and a2a_settle mirrors", () => {
  const events = [
    hire(3, 5, 1), // no settle of 3 before it -> orphan
    ev("settle", 3, 2, { tokensUsed: 10 }, "DataSift Analytics settled a 10-token job, now routing sub-calls"),
    hire(3, 5, 0.5),
    ev("a2a_settle", 5, 0.5, { primaryId: 3, primaryName: "DataSift Analytics" }),
    ev("settle", 3, 0.25, { direct: true, demo: true }, "DataSift Analytics initiating direct A2A payment to WebCrawler X"),
    hire(3, 5, 0.25, { direct: true }),
  ];
  const linked = linkPrimaryJobs(events);
  assert.equal(linked.jobs.length, 1);
  assert.equal(linked.jobs[0]!.primaryName, "DataSift Analytics");
  assert.equal(linked.jobs[0]!.hires.length, 1, "the a2a_settle mirror is not a second payment");
  assert.equal(linked.orphanHires.length, 1);
  assert.equal(linked.directHires.length, 1);

  // A hire far after its primary's last settle is not attributed to it.
  const far = [ev("settle", 1, 1)];
  nextId += 100;
  far.push(hire(1, 7, 1));
  const l2 = linkPrimaryJobs(far, { maxLinkGap: 24 });
  assert.equal(l2.jobs.length, 0);
  assert.equal(l2.orphanHires.length, 1);
});

/* ---------------- collection ---------------- */

test("collectSimEvents de-duplicates, counts ring-buffer gaps, and stops at the deadline", async () => {
  const pages: AgentHireSimEvent[][] = [
    [1, 2, 3].map((id) => ({ ...ev("bid_post", null, 0), id })),
    [3, 4].map((id) => ({ ...ev("bid_post", null, 0), id })),
    [9, 10].map((id) => ({ ...ev("bid_post", null, 0), id })), // 5..8 fell out of AgentHire's buffer
    [],
  ];
  const asked: number[] = [];
  const source: SimEventSource = {
    async eventsSince(since) {
      asked.push(since);
      return pages.shift() ?? [];
    },
  };
  let clock = 0;
  const out = await collectSimEvents(source, {
    durationMs: 3000,
    pollMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.deepEqual(out.events.map((e) => e.id), [1, 2, 3, 4, 9, 10]);
  assert.equal(out.missed, 4);
  assert.equal(out.polls, 4);
  assert.deepEqual(asked, [0, 3, 4, 10]);
});
