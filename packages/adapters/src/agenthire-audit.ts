/**
 * AgentHire SHADOW AUDIT — replay AgentHire's own agent-to-agent (A2A) hires
 * through Allowance and count how many sub-agent payments a mandate would have
 * blocked.
 *
 * WHAT IS REPLAYED. AgentHire (github.com/shalpate/agenthire) runs a live
 * marketplace SIMULATION (sim_engine.py). Its event feed, GET /api/sim/events,
 * carries SimEvents `{id, ts, kind, agentId, message, amountUSDC, meta}`. When a
 * composable "flagship" agent finishes a job, the engine logs, in this order:
 *
 *   settle    agentId = primary P, amountUSDC = what the buyer paid P
 *   a2a_hire  agentId = P, meta.primaryId = P, meta.subAgentId = S, amount paid S
 *   a2a_settle agentId = S (the mirror of the hire; not a second payment)
 *   ...one hire/settle pair per sub-agent the job triggered
 *
 * (sim_engine.py `_progress_sessions` / `_fire_demo_a2a_flow` → `_fire_a2a_
 * subagent_calls`). So a sub-agent hire belongs to the most recent `settle` of
 * its `meta.primaryId`. `fire_direct_a2a` (POST /api/sim/trigger-direct) logs a
 * pseudo-settle with `meta.direct` whose "price" is the hire itself; those have
 * no buyer-priced primary job, so they are reported separately, not audited.
 * All of this is SIMULATED marketplace activity, and the report says so.
 *
 * WHY. AgentHire credits the primary its full price AND pays sub-agents on top:
 * the sub-agent fees are not debited from, or capped by, the primary job.
 * Checkout shows a "Hard Spend Cap … Enforced" badge, but the sim's sub-agent
 * fees are never checked against it.
 *
 * THE SHADOW TREE (one per primary job, per budget scenario):
 *
 *   job<id>.shadow.eth                 buyer root, cap = the scenario's budget
 *   ├── main.job<id>.shadow.eth        the primary's own charge (merchant: P)
 *   └── a<S>-via-a<P>.job<id>…         ONE ALIAS NODE PER (hirer, sub-agent)
 *
 * Aliases are keyed by the hiring edge, never by the sub-agent alone: AgentHire's
 * A2A graph has cycles (1 hires 7, 7 hires 1) and shared children (6 is hired by
 * both 3 and 4), and a shared node would merge two parents' budgets.
 *
 * Every sub-agent payment then goes through core `pay()` (identity → mandate →
 * screening → settlement) with the offline MockIdentityGate, a screening port
 * (MockScreening by default; pass `screening` to plug in, e.g.,
 * AgentHireScreeningService, which screens by reputation and operator
 * incidents) and a RECORDING settlement (no network, no funds). Merchants are
 * named exactly as the settlement adapter names them (`agenthire:<id>`).
 * Sizing is FIRST-COME and holds nothing back: each alias is granted
 * min(amount, root's remaining budget) just before its payment, and a blocked
 * alias is shrunk back so the unused authority returns to the root. A payment
 * is therefore blocked only when it exceeds everything still left under the
 * buyer's cap at that moment.
 *
 * BUDGET SCENARIOS (the assumption is always printed next to the number):
 *   hardSpendCap    (HEADLINE) cap = 1.25 × upper estimate: AgentHire checkout's
 *                   own displayed "Hard Spend Cap", badged "Enforced"
 *                   (templates/checkout.html: (base × tokens + Σ sub
 *                   est_cost_high) × 1.25), with the job's actual token count and
 *                   the quote's maxPrice as the base; the primary is paid its
 *                   price first. The replay decides this count: some sub-agent
 *                   payments fit under the cap and some do not.
 *   primaryFundsSubs cap = the primary's price, but sub-agents are paid out of it
 *                   first and the primary keeps the remainder: AgentHire's own
 *                   description ("Primary earns per-call fee split by eating it
 *                   out of its own settle", sim_engine.py) taken at its word.
 *                   Also decided by the replay.
 *   strict          cap = the primary's price, paid to the primary in full first.
 *                   Nothing is left, so EVERY sub-agent fee is outside the
 *                   buyer's authorization BY DEFINITION. It is reported as that
 *                   total ("M payments, X USDC outside the buyer's
 *                   authorization"), never as a replay finding.
 *
 * WHAT THE "PRIMARY JOBS" ARE. Almost all of them come from AgentHire's
 * periodic demo cascade (sim_engine.py `_fire_demo_a2a_flow`, every 20 ticks,
 * `force_all=True`): every sub-agent trigger fires, the buyer is a synthetic
 * `demo-buyer-<tick>` hash, and the primary's "settle" is only a log line with
 * a synthetic price (tokens × min_price), no settle ChainTransaction. AgentHire
 * books each A2A fee as paid from the PRIMARY agent's wallet (sim_engine.py:842).
 * The report counts them (`demoPrimaries`); `organicOnly` drops them.
 *
 * This module is pure (no I/O): feed it events + quotes; `collectSimEvents`
 * polls any `SimEventSource`, so it does not depend on a particular HTTP client.
 */

import type {
  PaymentAdapters,
  PaymentRecord,
  ScreeningService,
  SettlementRequest,
  SettlementResult,
  SettlementService,
} from "@allowance/core";
import { DelegationTree, formatAmount, pay } from "@allowance/core";
import { MockIdentityGate } from "./world";
import { MockScreeningService } from "./intercepta";
import { agentHireMerchant, aliasNodeLabel } from "./agenthire";

/* ------------------------------------------------------------------ */
/* Input shapes (minimal, so any AgentHire client can feed the audit)  */
/* ------------------------------------------------------------------ */

/** One AgentHire SimEvent, as served by GET /api/sim/events (SimEvent.to_dict). */
export interface AgentHireSimEvent {
  id: number;
  /** Simulated unix seconds (AgentHire's sim clock, jittered by < 60s). */
  ts: number;
  kind: string;
  agentId: number | null;
  message: string;
  /** Float USDC, rounded by AgentHire to 4 decimals. */
  amountUSDC: number;
  meta: Record<string, unknown>;
}

/** Anything that can page through AgentHire's sim event feed. */
export interface SimEventSource {
  /** Events with `id > sinceId`, oldest first (GET /api/sim/events?since=&limit=). */
  eventsSince(sinceId: number, limit: number): Promise<AgentHireSimEvent[]>;
}

/** The fields of GET /api/pricing/quote/:id the audit uses (USDC per token). */
export interface AgentHireQuoteLike {
  agentId: number;
  minPrice: number;
  maxPrice: number;
  currentPrice?: number;
}

/** One flagship from GET /api/sim/a2a-candidates (its published sub-agent cost band). */
export interface A2AWorkflowLike {
  id: number;
  name?: string;
  subAgents: Array<{ id: number; name?: string; estCostHigh?: number | null }>;
}

/* ------------------------------------------------------------------ */
/* Parsing + linking                                                  */
/* ------------------------------------------------------------------ */

/** Validate one raw event from the wire; returns null for anything malformed. */
export function parseSimEvent(raw: unknown): AgentHireSimEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.kind !== "string") return null;
  const agentId = typeof r.agentId === "number" ? r.agentId : null;
  const amount = typeof r.amountUSDC === "number" && Number.isFinite(r.amountUSDC) ? r.amountUSDC : 0;
  const meta =
    typeof r.meta === "object" && r.meta !== null && !Array.isArray(r.meta)
      ? (r.meta as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    ts: typeof r.ts === "number" ? r.ts : 0,
    kind: r.kind,
    agentId,
    message: typeof r.message === "string" ? r.message : "",
    amountUSDC: amount,
    meta,
  };
}

/** Float USDC → integer micro-USDC (AgentHire's own `int(x * 1_000_000)` scale). */
export function usdcToMicro(usdc: number): bigint {
  if (!Number.isFinite(usdc) || usdc <= 0) return 0n;
  return BigInt(Math.round(usdc * 1_000_000));
}

/** One sub-agent payment made on behalf of a primary job. */
export interface SubHire {
  eventId: number;
  ts: number;
  hirerId: number;
  subAgentId: number;
  subAgentName?: string;
  amount: bigint;
  trigger?: string;
  billing?: string;
}

/** A buyer-priced primary job and the sub-agent hires it spawned. */
export interface PrimaryJob {
  /** Stable key, `job<settleEventId>`. */
  key: string;
  settleEventId: number;
  primaryId: number;
  primaryName?: string;
  ts: number;
  /** What the buyer paid the primary, micro-USDC. */
  price: bigint;
  tokensUsed: number | null;
  /** True for the engine's periodic flagship cascade (`meta.demo`). */
  demo: boolean;
  hires: SubHire[];
}

export interface LinkedEvents {
  /** Primary jobs that hired at least one sub-agent. */
  jobs: PrimaryJob[];
  /** Settles seen with no sub-agent hire (plain single-agent jobs). */
  soloJobs: number;
  /** Hires with no preceding settle of their primary in the window (not audited). */
  orphanHires: SubHire[];
  /** Hires from POST /api/sim/trigger-direct (no buyer-priced primary; not audited). */
  directHires: SubHire[];
  names: Map<number, string>;
}

export interface LinkOptions {
  /**
   * A hire links to its primary's latest settle only if it follows it within
   * this many event ids (AgentHire logs them back to back). Default 24.
   */
  maxLinkGap?: number;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Group AgentHire SimEvents into primary jobs with their sub-agent hires.
 * Input order does not matter (events are de-duplicated and sorted by id).
 */
export function linkPrimaryJobs(
  events: readonly AgentHireSimEvent[],
  opts: LinkOptions = {},
): LinkedEvents {
  const maxGap = opts.maxLinkGap ?? 24;
  const sorted = dedupeSorted(events);
  const names = new Map<number, string>();
  const allJobs: PrimaryJob[] = [];
  const lastSettle = new Map<number, PrimaryJob | "direct">();
  const orphanHires: SubHire[] = [];
  const directHires: SubHire[] = [];

  for (const e of sorted) {
    if (e.kind === "settle" && e.agentId !== null) {
      const m = /^(.*?) (settled|initiating) /.exec(e.message);
      if (m?.[1]) names.set(e.agentId, m[1]);
      if (e.meta.direct === true) {
        lastSettle.set(e.agentId, "direct");
        continue;
      }
      const job: PrimaryJob = {
        key: `job${e.id}`,
        settleEventId: e.id,
        primaryId: e.agentId,
        primaryName: names.get(e.agentId),
        ts: e.ts,
        price: usdcToMicro(e.amountUSDC),
        tokensUsed: num(e.meta.tokensUsed) ?? null,
        demo: e.meta.demo === true,
        hires: [],
      };
      allJobs.push(job);
      lastSettle.set(e.agentId, job);
      continue;
    }
    if (e.kind === "a2a_settle") {
      const pid = num(e.meta.primaryId);
      const pname = str(e.meta.primaryName);
      if (pid !== undefined && pname) names.set(pid, pname);
      continue;
    }
    if (e.kind !== "a2a_hire") continue;

    const hirerId = num(e.meta.primaryId) ?? e.agentId;
    const subAgentId = num(e.meta.subAgentId);
    if (hirerId === null || hirerId === undefined || subAgentId === undefined) continue;
    const subAgentName = str(e.meta.subAgentName);
    if (subAgentName) names.set(subAgentId, subAgentName);
    const hire: SubHire = {
      eventId: e.id,
      ts: e.ts,
      hirerId,
      subAgentId,
      subAgentName,
      amount: usdcToMicro(e.amountUSDC),
      trigger: str(e.meta.trigger) ?? triggerFromMessage(e.message),
      billing: str(e.meta.billing),
    };
    if (e.meta.direct === true) {
      directHires.push(hire);
      continue;
    }
    const job = lastSettle.get(hirerId);
    if (!job || job === "direct" || e.id - job.settleEventId > maxGap) {
      orphanHires.push(hire);
      continue;
    }
    job.hires.push(hire);
  }

  for (const job of allJobs) job.primaryName ??= names.get(job.primaryId);
  const jobs = allJobs.filter((j) => j.hires.length > 0);
  return { jobs, soloJobs: allJobs.length - jobs.length, orphanHires, directHires, names };
}

function triggerFromMessage(message: string): string | undefined {
  const m = /\(([^()]*)\)\s*$/.exec(message);
  return m?.[1];
}

function dedupeSorted(events: readonly AgentHireSimEvent[]): AgentHireSimEvent[] {
  const byId = new Map<number, AgentHireSimEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/* ------------------------------------------------------------------ */
/* Shadow replay                                                      */
/* ------------------------------------------------------------------ */

export type BudgetScenario = "strict" | "primaryFundsSubs" | "hardSpendCap";

export const BUDGET_SCENARIOS: readonly BudgetScenario[] = [
  "hardSpendCap",
  "primaryFundsSubs",
  "strict",
];

/** The scenario the headline count comes from: one the replay actually decides. */
export const HEADLINE_SCENARIO: BudgetScenario = "hardSpendCap";

/** The assumption behind each scenario, printed next to its number. */
export const SCENARIO_ASSUMPTIONS: Record<BudgetScenario, string> = {
  hardSpendCap:
    "buyer cap = AgentHire checkout's own displayed 'Hard Spend Cap' (badged 'Enforced'): " +
    "1.25 x (tokens x quote maxPrice + sum of sub-agent est_cost_high); the primary is paid its price first " +
    "and every sub-agent fee must fit in what is left",
  primaryFundsSubs:
    "buyer cap = the primary's price, sub-agents paid out of it first and the primary keeps the rest " +
    "(AgentHire's own claim that the primary 'eats' sub-agent fees out of its settle)",
  strict:
    "buyer cap = the primary's price, paid to the primary in full first, so nothing is left: " +
    "every sub-agent fee is outside the buyer's authorization BY DEFINITION (a total, not a replay finding)",
};

/** A settlement port that records requests and settles nothing (shadow mode). */
export class RecordingSettlement implements SettlementService {
  readonly requests: SettlementRequest[] = [];

  async settle(req: SettlementRequest): Promise<SettlementResult> {
    this.requests.push(req);
    return {
      settled: true,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut: req.amount,
      reference: `shadow-${this.requests.length}`,
      reason: "shadow replay: recorded, not settled",
    };
  }
}

/**
 * Build the offline adapter bundle the replay uses: mock identity, the given
 * screening port (MockScreeningService by default) and a recorder.
 */
export function shadowAdapters(
  settlement: SettlementService = new RecordingSettlement(),
  screening: ScreeningService = new MockScreeningService(),
): PaymentAdapters {
  return {
    identity: new MockIdentityGate(),
    screening,
    settlement,
  };
}

/**
 * Merchant id Allowance uses for an AgentHire agent: `agenthire:<id>`, the same
 * id the AgentHire settlement and screening adapters parse, so either can be
 * plugged into the replay.
 */
export function agentMerchant(agentId: number): string {
  return agentHireMerchant(agentId);
}

/** Alias label for a sub-agent under a given hirer: one node per parent, never shared. */
export function aliasLabel(hirerId: number, subAgentId: number): string {
  return aliasNodeLabel(hirerId, subAgentId);
}

export interface ReplayContext {
  quotes?: ReadonlyMap<number, AgentHireQuoteLike>;
  workflows?: ReadonlyMap<number, A2AWorkflowLike>;
  /**
   * Screening port for the replay's pay() calls (default MockScreeningService).
   * With AgentHireScreeningService, a payment to an agent whose operator has an
   * Allowance incident is blocked at screening, and counts as blocked.
   */
  screening?: ScreeningService;
}

/** Cap for one job under one scenario, micro-USDC. */
export function scenarioCap(job: PrimaryJob, scenario: BudgetScenario, ctx: ReplayContext = {}): bigint {
  if (scenario !== "hardSpendCap") return job.price;
  return (upperEstimate(job, ctx) * 125n) / 100n;
}

/**
 * AgentHire checkout's "upper estimate" for this job: base × tokens + Σ sub-agent
 * est_cost_high (checkout.html uses a typical 50 tokens; we use the job's actual
 * token count), never below what the primary actually charged.
 */
export function upperEstimate(job: PrimaryJob, ctx: ReplayContext = {}): bigint {
  const quote = ctx.quotes?.get(job.primaryId);
  let base = job.price;
  if (quote && job.tokensUsed !== null) {
    const byQuote = usdcToMicro(job.tokensUsed * quote.maxPrice);
    if (byQuote > base) base = byQuote;
  }
  const wf = ctx.workflows?.get(job.primaryId);
  let subHigh = 0n;
  for (const s of wf?.subAgents ?? []) subHigh += usdcToMicro(s.estCostHigh ?? 0);
  return base + subHigh;
}

/** Outcome of one sub-agent payment in one scenario. */
export interface ShadowPayment {
  hire: SubHire;
  node: string;
  record: PaymentRecord;
  blocked: boolean;
}

export interface ShadowReplay {
  job: PrimaryJob;
  scenario: BudgetScenario;
  cap: bigint;
  tree: DelegationTree;
  payments: ShadowPayment[];
  settlement: RecordingSettlement;
}

const DAY = 86_400;

/**
 * Replay one primary job through a fresh shadow DelegationTree under a budget
 * scenario. Every sub-agent payment runs through core `pay()`.
 */
export async function replayJob(
  job: PrimaryJob,
  scenario: BudgetScenario,
  ctx: ReplayContext = {},
): Promise<ShadowReplay> {
  const settlement = new RecordingSettlement();
  const adapters = shadowAdapters(settlement, ctx.screening);
  const tree = new DelegationTree();
  const cap = scenarioCap(job, scenario, ctx);
  const rootName = `${job.key}.shadow.eth`;
  const expiry = Math.max(job.ts, ...job.hires.map((h) => h.ts)) + DAY;
  const primaryMerchant = agentMerchant(job.primaryId);
  tree.fundRoot({
    principal: `agenthire-buyer:${job.key}`,
    rootName,
    mandate: { budget: cap, expiry },
  });
  const mainName = `main.${rootName}`;
  const payMain = async (amount: bigint, budget: bigint): Promise<void> => {
    tree.delegate(rootName, "main", { budget, allowedMerchants: [primaryMerchant], expiry });
    if (amount > 0n) {
      await pay(tree, { node: mainName, merchant: primaryMerchant, amount, purpose: "primary-job" }, adapters, {
        now: job.ts,
      });
    }
  };

  // The primary is paid first (AgentHire logs its settle before any hire)...
  if (scenario !== "primaryFundsSubs") await payMain(job.price, job.price);

  const payments: ShadowPayment[] = [];
  for (const hire of job.hires) {
    const label = aliasLabel(hire.hirerId, hire.subAgentId);
    const name = `${label}.${rootName}`;
    const merchant = agentMerchant(hire.subAgentId);
    const rootLeft = tree.available(rootName);
    const grant = hire.amount < rootLeft ? hire.amount : rootLeft;
    const existing = tree.getNode(name);
    if (!existing) {
      tree.delegate(rootName, label, { budget: grant, allowedMerchants: [merchant], expiry });
    } else if (grant > 0n) {
      tree.resize(name, existing.mandate.budget + grant);
    }
    const record = await pay(
      tree,
      { node: name, merchant, amount: hire.amount, purpose: "a2a-subagent" },
      adapters,
      { now: hire.ts },
    );
    const blocked = record.outcome !== "SETTLED";
    if (blocked) {
      // Hand the unused slice back to the root so later hires can still use it.
      const node = tree.requireNode(name);
      const committed = node.mandate.spentDirect + tree.reserved(name);
      if (node.mandate.budget > committed) tree.resize(name, committed);
    }
    payments.push({ hire, node: name, record, blocked });
  }

  // ...or, under AgentHire's own "primary eats sub-agent fees" claim, keeps the rest.
  if (scenario === "primaryFundsSubs") {
    const rest = tree.available(rootName);
    await payMain(rest, rest);
  }
  return { job, scenario, cap, tree, payments, settlement };
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

export interface ScenarioSummary {
  scenario: BudgetScenario;
  assumption: string;
  subPayments: number;
  blocked: number;
  blockedMicro: bigint;
  blockedUSDC: string;
  /** Primary jobs in which at least one sub-agent payment was blocked. */
  jobsWithBlocks: number;
}

export interface AgentAuditRow {
  agentId: number;
  name?: string;
  /** Distinct hirers (more than one = a shared child, aliased per parent). */
  parents: number[];
  /** Alias node labels this agent appeared as. */
  aliases: string[];
  payments: number;
  usdcMicro: bigint;
  usdc: string;
  /** Headline scenario (`HEADLINE_SCENARIO`, AgentHire's own Hard Spend Cap). */
  blocked: number;
  blockedMicro: bigint;
  blockedUSDC: string;
  /** Blocked count per scenario. */
  blockedBy: Record<BudgetScenario, number>;
}

export interface EdgeRow {
  hirerId: number;
  subAgentId: number;
  payments: number;
  usdcMicro: bigint;
  usdc: string;
}

/** One hiring (primary) agent: its revenue vs. the sub-agent fees its jobs spent. */
export interface PrimaryAuditRow {
  agentId: number;
  name?: string;
  jobs: number;
  priceMicro: bigint;
  priceUSDC: string;
  subMicro: bigint;
  subUSDC: string;
  /** Sub-agent fees / primary revenue for this agent's jobs (2 decimals). */
  ratio: number;
  subPayments: number;
  blockedBy: Record<BudgetScenario, number>;
}

export interface ShadowAuditReport {
  /** Everything here was replayed from AgentHire's simulated marketplace. */
  simulated: true;
  source: string;
  /** The scenario `blocked` / `blockedUSDC` come from (AgentHire's own Hard Spend Cap). */
  headlineScenario: BudgetScenario;
  /** The headline scenario's assumption, printed next to the number. */
  assumption: string;
  sizing: string;
  /** True when AgentHire's demo-cascade jobs (`meta.demo`) were dropped before the replay. */
  organicOnly: boolean;
  primaries: number;
  /**
   * How many of those jobs came from AgentHire's periodic demo cascade
   * (`meta.demo`, fired every 20 sim ticks with force_all: every sub-agent
   * trigger fires, the buyer is synthetic, and nobody pays for the primary).
   */
  demoPrimaries: number;
  /** Demo-cascade jobs dropped by `organicOnly` (0 otherwise). */
  droppedDemoPrimaries: number;
  primaryMicro: bigint;
  primaryUSDC: string;
  subPayments: number;
  /** Headline: sub-agent payments the replay blocked under `headlineScenario`. */
  blocked: number;
  blockedMicro: bigint;
  blockedUSDC: string;
  /**
   * Under `strict` (buyer cap = the primary's price, paid to the primary in
   * full) every sub-agent fee is outside the buyer's authorization by
   * definition. This is that total, not a replay result.
   */
  outsideAuthorization: { payments: number; micro: bigint; usdc: string; definition: string };
  totalSubMicro: bigint;
  totalSubUSDC: string;
  /** Plain-language caveats that travel with the numbers. */
  notes: string[];
  /** Σ sub-agent fees / Σ primary prices over the audited jobs (2 decimals). */
  ratioSubToPrimary: number;
  byAgent: AgentAuditRow[];
  /** Per hiring agent, largest sub-agent / revenue ratio first. */
  byPrimary: PrimaryAuditRow[];
  edges: EdgeRow[];
  /** Hiring-graph cycles seen, as [a, b] with a < b (a hired b and b hired a). */
  cycles: Array<[number, number]>;
  /** Sub-agents hired by more than one parent. */
  multiParent: number[];
  sensitivity: ScenarioSummary[];
  excluded: {
    directHires: number;
    directMicro: bigint;
    orphanHires: number;
    orphanMicro: bigint;
    soloJobs: number;
  };
  window: { events: number; firstEventId: number | null; lastEventId: number | null; fromTs: number | null; toTs: number | null };
  jobs: Array<{
    key: string;
    primaryId: number;
    primaryName?: string;
    demo: boolean;
    priceUSDC: string;
    subUSDC: string;
    caps: Record<BudgetScenario, string>;
    blocked: Record<BudgetScenario, number>;
    hires: number;
  }>;
}

export interface AuditInput {
  events: readonly AgentHireSimEvent[];
  quotes?: Iterable<AgentHireQuoteLike>;
  workflows?: Iterable<A2AWorkflowLike>;
  link?: LinkOptions;
  /** Free-text provenance (e.g. the AgentHire base URL + capture window). */
  source?: string;
  /** Drop AgentHire's demo-cascade jobs (`meta.demo`) and audit only matched-bid jobs. */
  organicOnly?: boolean;
  /** Screening port for the replay (default MockScreeningService); see `ReplayContext.screening`. */
  screening?: ScreeningService;
}

const sumMicro = (xs: Iterable<bigint>): bigint => {
  let s = 0n;
  for (const x of xs) s += x;
  return s;
};

/** Ratio a/b as a number with 2 decimals (0 when b is 0). */
function ratio2(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number((a * 100n) / b) / 100;
}

/** Run the full shadow audit over a batch of AgentHire SimEvents. */
export async function runShadowAudit(input: AuditInput): Promise<ShadowAuditReport> {
  const allLinked = linkPrimaryJobs(input.events, input.link);
  const organicOnly = input.organicOnly === true;
  const linked: LinkedEvents = organicOnly
    ? { ...allLinked, jobs: allLinked.jobs.filter((j) => !j.demo) }
    : allLinked;
  const droppedDemoPrimaries = allLinked.jobs.length - linked.jobs.length;
  const ctx: ReplayContext = {
    quotes: new Map([...(input.quotes ?? [])].map((q) => [q.agentId, q])),
    workflows: new Map([...(input.workflows ?? [])].map((w) => [w.id, w])),
  };
  if (input.screening) ctx.screening = input.screening;

  const summaries = new Map<BudgetScenario, ScenarioSummary>();
  for (const s of BUDGET_SCENARIOS) {
    summaries.set(s, {
      scenario: s,
      assumption: SCENARIO_ASSUMPTIONS[s],
      subPayments: 0,
      blocked: 0,
      blockedMicro: 0n,
      blockedUSDC: "0.000000",
      jobsWithBlocks: 0,
    });
  }
  const agents = new Map<number, AgentAuditRow>();
  const edges = new Map<string, EdgeRow>();
  const jobRows: ShadowAuditReport["jobs"] = [];

  for (const job of linked.jobs) {
    const caps = {} as Record<BudgetScenario, string>;
    const blockedPerScenario = {} as Record<BudgetScenario, number>;
    for (const scenario of BUDGET_SCENARIOS) {
      const replay = await replayJob(job, scenario, ctx);
      const summary = summaries.get(scenario)!;
      let jobBlocked = 0;
      for (const p of replay.payments) {
        summary.subPayments += 1;
        const row = agentRow(agents, p.hire, linked.names);
        if (p.blocked) {
          jobBlocked += 1;
          summary.blocked += 1;
          summary.blockedMicro += p.hire.amount;
          row.blockedBy[scenario] += 1;
          if (scenario === HEADLINE_SCENARIO) {
            row.blocked += 1;
            row.blockedMicro += p.hire.amount;
          }
        }
        // Every scenario replays the same payments; count them once.
        if (scenario === HEADLINE_SCENARIO) {
          row.payments += 1;
          row.usdcMicro += p.hire.amount;
          const label = aliasLabel(p.hire.hirerId, p.hire.subAgentId);
          if (!row.aliases.includes(label)) row.aliases.push(label);
          if (!row.parents.includes(p.hire.hirerId)) row.parents.push(p.hire.hirerId);
          const ek = `${p.hire.hirerId}->${p.hire.subAgentId}`;
          const edge = edges.get(ek) ?? {
            hirerId: p.hire.hirerId,
            subAgentId: p.hire.subAgentId,
            payments: 0,
            usdcMicro: 0n,
            usdc: "",
          };
          edge.payments += 1;
          edge.usdcMicro += p.hire.amount;
          edges.set(ek, edge);
        }
      }
      if (jobBlocked > 0) summary.jobsWithBlocks += 1;
      caps[scenario] = formatAmount(replay.cap);
      blockedPerScenario[scenario] = jobBlocked;
    }
    jobRows.push({
      key: job.key,
      primaryId: job.primaryId,
      primaryName: job.primaryName,
      demo: job.demo,
      priceUSDC: formatAmount(job.price),
      subUSDC: formatAmount(sumMicro(job.hires.map((h) => h.amount))),
      caps,
      blocked: blockedPerScenario,
      hires: job.hires.length,
    });
  }

  for (const s of summaries.values()) s.blockedUSDC = formatAmount(s.blockedMicro);
  for (const r of agents.values()) {
    r.usdc = formatAmount(r.usdcMicro);
    r.blockedUSDC = formatAmount(r.blockedMicro);
    r.parents.sort((a, b) => a - b);
  }
  for (const e of edges.values()) e.usdc = formatAmount(e.usdcMicro);

  const edgeList = [...edges.values()].sort((a, b) => a.hirerId - b.hirerId || a.subAgentId - b.subAgentId);
  const cycles: Array<[number, number]> = [];
  for (const e of edgeList) {
    if (e.hirerId < e.subAgentId && edges.has(`${e.subAgentId}->${e.hirerId}`)) {
      cycles.push([e.hirerId, e.subAgentId]);
    }
  }
  const byAgent = [...agents.values()].sort(
    (a, b) => (b.usdcMicro > a.usdcMicro ? 1 : b.usdcMicro < a.usdcMicro ? -1 : a.agentId - b.agentId),
  );

  const primaries = new Map<number, PrimaryAuditRow>();
  for (const [i, job] of linked.jobs.entries()) {
    const row = primaries.get(job.primaryId) ?? {
      agentId: job.primaryId,
      name: job.primaryName,
      jobs: 0,
      priceMicro: 0n,
      priceUSDC: "",
      subMicro: 0n,
      subUSDC: "",
      ratio: 0,
      subPayments: 0,
      blockedBy: { strict: 0, primaryFundsSubs: 0, hardSpendCap: 0 },
    };
    row.jobs += 1;
    row.priceMicro += job.price;
    row.subMicro += sumMicro(job.hires.map((h) => h.amount));
    row.subPayments += job.hires.length;
    for (const s of BUDGET_SCENARIOS) row.blockedBy[s] += jobRows[i]!.blocked[s];
    primaries.set(job.primaryId, row);
  }
  for (const r of primaries.values()) {
    r.priceUSDC = formatAmount(r.priceMicro);
    r.subUSDC = formatAmount(r.subMicro);
    r.ratio = ratio2(r.subMicro, r.priceMicro);
  }
  const byPrimary = [...primaries.values()].sort((a, b) => b.ratio - a.ratio || a.agentId - b.agentId);

  const headline = summaries.get(HEADLINE_SCENARIO)!;
  const strict = summaries.get("strict")!;
  const primaryMicro = sumMicro(linked.jobs.map((j) => j.price));
  const totalSubMicro = sumMicro(linked.jobs.flatMap((j) => j.hires.map((h) => h.amount)));
  const sorted = dedupeSorted(input.events);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const directMicro = sumMicro(linked.directHires.map((h) => h.amount));
  const orphanMicro = sumMicro(linked.orphanHires.map((h) => h.amount));
  const demoPrimaries = linked.jobs.filter((j) => j.demo).length;

  return {
    simulated: true,
    source: input.source ?? "AgentHire /api/sim/events (simulated marketplace)",
    headlineScenario: HEADLINE_SCENARIO,
    assumption: SCENARIO_ASSUMPTIONS[HEADLINE_SCENARIO],
    sizing:
      "first-come, nothing held back: each sub-agent alias (one per hiring parent) is granted " +
      "min(amount, what is left under the cap) just before its payment and shrunk back if blocked, " +
      "so a payment is blocked only when it exceeds everything left under the buyer's cap",
    organicOnly,
    primaries: linked.jobs.length,
    demoPrimaries,
    droppedDemoPrimaries,
    primaryMicro,
    primaryUSDC: formatAmount(primaryMicro),
    subPayments: headline.subPayments,
    blocked: headline.blocked,
    blockedMicro: headline.blockedMicro,
    blockedUSDC: headline.blockedUSDC,
    outsideAuthorization: {
      payments: strict.blocked,
      micro: strict.blockedMicro,
      usdc: strict.blockedUSDC,
      definition: SCENARIO_ASSUMPTIONS.strict,
    },
    totalSubMicro,
    totalSubUSDC: formatAmount(totalSubMicro),
    notes: [
      "All input is AgentHire's SIMULATED marketplace (sim_engine.py); nothing was settled or moved.",
      `${demoPrimaries} of ${linked.jobs.length} audited primary jobs are AgentHire's force-all demo cascade ` +
        "(every sub-agent trigger fires, synthetic buyer, the primary's price is a log line nobody paid)" +
        (organicOnly ? `; ${droppedDemoPrimaries} such jobs were dropped (organic only)` : ""),
      "AgentHire books every A2A fee as paid from the PRIMARY agent's wallet (sim_engine.py:842), on top of the primary's price.",
    ],
    ratioSubToPrimary: ratio2(totalSubMicro, primaryMicro),
    byAgent,
    byPrimary,
    edges: edgeList,
    cycles,
    multiParent: byAgent.filter((r) => r.parents.length > 1).map((r) => r.agentId).sort((a, b) => a - b),
    sensitivity: [...summaries.values()],
    excluded: {
      directHires: linked.directHires.length,
      directMicro,
      orphanHires: linked.orphanHires.length,
      orphanMicro,
      soloJobs: linked.soloJobs,
    },
    window: {
      events: sorted.length,
      firstEventId: first?.id ?? null,
      lastEventId: last?.id ?? null,
      fromTs: first?.ts ?? null,
      toTs: last?.ts ?? null,
    },
    jobs: jobRows,
  };
}

function agentRow(rows: Map<number, AgentAuditRow>, hire: SubHire, names: Map<number, string>): AgentAuditRow {
  let row = rows.get(hire.subAgentId);
  if (!row) {
    row = {
      agentId: hire.subAgentId,
      name: hire.subAgentName ?? names.get(hire.subAgentId),
      parents: [],
      aliases: [],
      payments: 0,
      usdcMicro: 0n,
      usdc: "",
      blocked: 0,
      blockedMicro: 0n,
      blockedUSDC: "",
      blockedBy: { strict: 0, primaryFundsSubs: 0, hardSpendCap: 0 },
    };
    rows.set(hire.subAgentId, row);
  }
  return row;
}

/** Human name of each scenario, for the headline. */
const SCENARIO_LABEL: Record<BudgetScenario, string> = {
  hardSpendCap: "AgentHire's own displayed Hard Spend Cap",
  primaryFundsSubs: "a cap of the primary's price that the primary shares with its sub-agents",
  strict: "a cap of the primary's price",
};

/**
 * The headline: "N of M sub-agent payments would have been blocked …" under the
 * replay-decided headline scenario, the by-definition total outside the
 * buyer's authorization, what the primary jobs were, and the assumption.
 */
export function auditHeadline(r: ShadowAuditReport): string {
  const o = r.outsideAuthorization;
  return (
    `${r.blocked} of ${r.subPayments} sub-agent payments would have been blocked even under ` +
    `${SCENARIO_LABEL[r.headlineScenario]} (${r.blockedUSDC} of ${r.totalSubUSDC} USDC unbudgeted). ` +
    `All ${o.payments} (${o.usdc} USDC) were outside what the buyer authorized for the primary job, by definition: ` +
    `AgentHire pays sub-agents on top of the primary's price, from the primary agent's wallet. ` +
    `Sub-agent spend = ${r.ratioSubToPrimary}x the ${r.primaryUSDC} USDC priced for ${r.primaries} simulated primary jobs ` +
    `(${r.demoPrimaries} of them AgentHire's force-all demo cascade with no paying buyer` +
    (r.organicOnly ? `; ${r.droppedDemoPrimaries} demo jobs dropped` : "") +
    `) [simulated AgentHire marketplace; assumption: ${r.assumption}]`
  );
}

/** JSON.stringify replacer that renders bigints as decimal strings. */
export function auditJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/* ------------------------------------------------------------------ */
/* Collection                                                         */
/* ------------------------------------------------------------------ */

export interface CollectOptions {
  /** How long to poll. */
  durationMs: number;
  /** Delay between polls. Default 1000. */
  pollMs?: number;
  /** Page size per poll. AgentHire keeps the last 500 events. Default 500. */
  limit?: number;
  /** Start after this event id (0 = everything still in AgentHire's buffer). */
  sinceId?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onPoll?: (info: { newEvents: number; total: number; lastId: number }) => void;
}

export interface CollectedEvents {
  events: AgentHireSimEvent[];
  /** Event ids skipped between polls (buffer overflow); 0 means a gap-free capture. */
  missed: number;
  polls: number;
}

/**
 * Poll a SimEventSource for `durationMs`, de-duplicating by id and counting any
 * ids that fell out of AgentHire's ring buffer between polls.
 */
export async function collectSimEvents(source: SimEventSource, opts: CollectOptions): Promise<CollectedEvents> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 1000;
  const limit = opts.limit ?? 500;
  const deadline = now() + opts.durationMs;
  const byId = new Map<number, AgentHireSimEvent>();
  let lastId = opts.sinceId ?? 0;
  let missed = 0;
  let polls = 0;

  for (;;) {
    const batch = (await source.eventsSince(lastId, limit))
      .filter((e) => e.id > lastId)
      .sort((a, b) => a.id - b.id);
    polls += 1;
    const firstNew = batch[0];
    if (firstNew && polls > 1 && firstNew.id > lastId + 1) missed += firstNew.id - lastId - 1;
    for (const e of batch) byId.set(e.id, e);
    const lastNew = batch[batch.length - 1];
    if (lastNew) lastId = lastNew.id;
    opts.onPoll?.({ newEvents: batch.length, total: byId.size, lastId });
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  return { events: [...byId.values()].sort((a, b) => a.id - b.id), missed, polls };
}
