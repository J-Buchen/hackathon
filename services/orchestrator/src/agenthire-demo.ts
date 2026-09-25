/**
 * Allowance x AgentHire — the capital-market demo, run LIVE against a local,
 * unmodified AgentHire (github.com/shalpate/agenthire @ ab317f2) in keyless
 * mock mode.
 *
 * One tree:
 *
 *   fund.eth                              the fund (root, funded by a verified human)
 *   └── luckin-pm.fund.eth                capital mandate: trade LKNCY, hedge KWEB, buy data
 *       ├── scraper.luckin-pm.fund.eth    data sub-mandate: hire AgentHire's WebCrawler X (agent 5)
 *       │   ├── a6-via-a5.scraper…        WebCrawler X's own sub-hire of ResearchBot Pro (alias node)
 *       │   └── a3-via-a5.scraper…        WebCrawler X's own sub-hire of DataSift Analytics (alias node)
 *       └── spot-check.luckin-pm.fund.eth a 10-minute mandate, used to show the settlement guard
 *
 * The story, each step self-asserted like demo.ts:
 *   1. the fund funds its Luckin PM under a capital mandate;
 *   2. the PM sizes a data job from AgentHire's own quotes: main hire = the
 *      quote, sub-agent budgets pro rata into (cap - main), all delegated at once;
 *   3. the scraper hires WebCrawler X over x402; Allowance checks amount (= the
 *      quote), chain, token, recipient and permit lifetime, which AgentHire does not;
 *   4. acting for WebCrawler X (SCRIPTED by this demo), its alias node hires a
 *      sub-agent (A2A), then fires one more hire than its other allowance holds,
 *      all at once: the SerializedPayer lets exactly the ones that fit through;
 *   5. acting for WebCrawler X (SCRIPTED), the demo tries to overspend twice:
 *      blocked, and an INCIDENT (not a slash) lands in Allowance's incident
 *      record, keyed by agent and operator;
 *   6. a second buyer, with its own services and a ledger loaded from disk, is
 *      turned away by screening;
 *   7. operators: agents are bound to their deployer + a World ID (mock) nullifier;
 *   8. the PM funds the next scrape, then the drawdown ladder (the PM mandate's
 *      fixed stop-loss, the floor of the center book's risk-scaled rungs) stops
 *      the PM out on its virtual (synthetic) track record, and ONE tree.close()
 *      frees the PM's capital and kills the data budget while it still holds a
 *      full hire at every level;
 *   9. the shadow audit replays AgentHire's own A2A hires through Allowance.
 * On success it writes apps/web/public/agenthire-snapshot.json (core Snapshot
 * schema) and apps/web/public/agenthire-receipts.json (settlement receipts,
 * incidents, operators, ladder, audit). A run with a failed check writes
 * *.failed.json next to them instead, leaving the committed files alone.
 *
 * WHAT IS REAL AND WHAT IS SIMULATED
 *   - Real: the HTTP calls to AgentHire, its quotes, its 402 challenges, the
 *     EIP-3009 signatures (throwaway key, no funds), Allowance's checks.
 *   - Simulated: AgentHire's keyless x402 settlement (status "mock", realTx
 *     false: nothing moves on chain), its A2A route (/api/sim/trigger-direct),
 *     its marketplace simulation (the audit's input), and the PM's return path
 *     (a synthetic arena world). The operator nullifier comes from the World ID
 *     mock. WebCrawler X's sub-hires and overspend attempts are made by this
 *     script acting for agent 5; AgentHire's WebCrawler X never contacts Allowance.
 *   - AgentHire's escrow is off-chain in live flows: nothing here is escrow-protected.
 *
 * Run:
 *   bash scripts/agenthire-up.sh                  # 127.0.0.1:5301 (PORT=... for another)
 *   npm run demo:agenthire                        # AGENTHIRE_URL=http://127.0.0.1:<port> for another
 *   bash scripts/agenthire-down.sh
 *
 * Env: AGENTHIRE_URL (default http://127.0.0.1:5301), AGENTHIRE_SETTLE
 * (mock | fuji), AGENTHIRE_PAYER_KEY (optional funded payer key for the Fuji
 * path; env only, never written), AGENTHIRE_AUDIT_SECONDS (default 20),
 * ALLOWANCE_INCIDENTS_FILE (default .agenthire/allowance-demo-incidents.json,
 * emptied at the start of each run), ARENA_SEED (default 3, must be < 10000:
 * arena seeds at or above that are sealed for judging).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DelegationTree,
  formatAmount,
  parseAmount,
  writeSnapshotFile,
  type PaymentRecord,
} from "@allowance/core";
import {
  AgentHireClient,
  AgentHireScreeningService,
  AgentHireSettlementService,
  IncidentLedger,
  JsonFileIncidentStore,
  MockIdentityGate,
  MockPrincipalVerifier,
  MockScreeningService,
  OperatorRegistry,
  OverspendWatch,
  QuoteBook,
  SerializedPayer,
  agentHireMerchant,
  agentHireTreeHooks,
  aliasNodeLabel,
  aliasPayerAgentId,
  auditHeadline,
  auditJsonReplacer,
  collectSimEvents,
  createThrowawaySigner,
  delegateAll,
  linkPrimaryJobs,
  parseSimEvent,
  payerSignerFromEnv,
  planHire,
  recoverPermitSigner,
  runShadowAudit,
  settleModeFromEnv,
  type A2AWorkflowLike,
  type AgentHireAgent,
  type AgentHireQuote,
  type AgentHireQuoteLike,
  type AgentHireReceipt,
  type SimEventSource,
} from "@allowance/adapters";
import { ARENA_EVAL_FLOOR, RECOMMENDED_TIGER, makeWorld, runTiger, tigerPanel } from "@allowance/lab";
import { currentDrawdown, defaultCenterBookPolicy, nextLadderState, scaleLadder, type LadderState } from "@allowance/swarm";

/* ------------------------------------------------------------------ */
/* Console + assertion helpers (same shape as demo.ts)                 */
/* ------------------------------------------------------------------ */

const USDC = (v: bigint): string => `${formatAmount(v)} USDC`;

function header(step: string, eli5: string): void {
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${step}`);
  console.log(`  (ELI5) ${eli5}`);
  console.log("═".repeat(78));
}

function line(msg = ""): void {
  console.log(`   ${msg}`);
}

const failures: string[] = [];
let checks = 0;
function expect(what: string, actual: bigint | number | string | boolean, expected: bigint | number | string | boolean): void {
  checks += 1;
  const ok = actual === expected;
  line(`assert ${what}: ${ok ? "OK" : "FAIL"} (got ${String(actual)}, expected ${String(expected)})`);
  if (!ok) failures.push(`${what}: got ${String(actual)}, expected ${String(expected)}`);
}
function check(what: string, ok: boolean, detail = ""): void {
  checks += 1;
  line(`assert ${what}: ${ok ? "OK" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ""}`);
}

function verdict(label: string, r: PaymentRecord): void {
  line(`${label}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ""}`);
}

const sameAddr = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const nowS = (): number => Math.floor(Date.now() / 1000);

/** The port a base URL points at, for the start/stop hints. */
function portOf(base: string): string {
  const u = new URL(base);
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/* ------------------------------------------------------------------ */
/* Fixed story parameters                                             */
/* ------------------------------------------------------------------ */

const AGENTHIRE_PIN = "ab317f2b831a9a832898b88759b496c28a435ed4";
const DEFAULT_URL = "http://127.0.0.1:5301";

/** AgentHire agents in the story (ids from its seeded roster). */
const WEBCRAWLER_X = 5; // CrawlTech, "Web Scraping": pulls the Baidu Maps store list
const RESEARCHBOT_PRO = 6; // Cognify Research: city-name reconciliation
const DATASIFT = 3; // Analytical Minds: dedupe + count (DataSift itself hires WebCrawler X in AgentHire: a cycle)
const ALPHATRADER = 4; // QuantEdge Labs
const FINANCEGPT = 11; // QuantEdge Labs: same operator, different name

const ROOT = "fund.eth";
const PM = `luckin-pm.${ROOT}`;
const SCRAPER = `scraper.${PM}`;
const SPOT = `spot-check.${PM}`;
const A6_LABEL = aliasNodeLabel(WEBCRAWLER_X, RESEARCHBOT_PRO);
const A3_LABEL = aliasNodeLabel(WEBCRAWLER_X, DATASIFT);
const A6 = `${A6_LABEL}.${SCRAPER}`;
const A3 = `${A3_LABEL}.${SCRAPER}`;
const BUYER2 = "second-buyer.eth";

const FUND_AUM = parseAmount("1000000");
const PM_CAPITAL = parseAmount("250000");

/** The PM's policy: room for one and a half calls of each agent, as surge headroom. */
const policyCap = (main: bigint, w6: bigint, w3: bigint): bigint => ((main + w6 + w3) * 3n + 1n) / 2n;

const SCRIPTED = "scripted by the Allowance demo acting for agent 5 (AgentHire's WebCrawler X did not make these attempts itself)";

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const base = (process.env.AGENTHIRE_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const host = new URL(base).hostname;
  const port = portOf(base);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  if (!loopback && process.env.AGENTHIRE_ALLOW_REMOTE !== "1") {
    throw new Error(`refusing non-loopback AgentHire at ${base}: its money routes are unauthenticated (AGENTHIRE_ALLOW_REMOTE=1 overrides)`);
  }
  const stopHint = `PORT=${port} bash scripts/agenthire-down.sh`;
  const mode = settleModeFromEnv();
  const auditSeconds = Number(process.env.AGENTHIRE_AUDIT_SECONDS ?? 20);
  const arenaSeed = Number(process.env.ARENA_SEED ?? 3);
  if (!Number.isInteger(arenaSeed) || arenaSeed < 1 || arenaSeed >= ARENA_EVAL_FLOOR) {
    throw new Error(`ARENA_SEED must be an integer in [1, ${ARENA_EVAL_FLOOR}) (higher seeds are sealed for judging)`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  const incidentFile = resolve(process.env.ALLOWANCE_INCIDENTS_FILE ?? resolve(repoRoot, ".agenthire/allowance-demo-incidents.json"));

  console.log("");
  console.log("┌────────────────────────────────────────────────────────────────────────┐");
  console.log("│  ALLOWANCE x AGENTHIRE — a fund's PM hires a scraper; one close()      │");
  console.log("│  stops the PM out and kills the data budget with it.                   │");
  console.log("└────────────────────────────────────────────────────────────────────────┘");

  const client = new AgentHireClient(base);
  let info;
  try {
    info = await client.onchainInfo();
  } catch (err) {
    console.error(`\nCannot reach AgentHire at ${base}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Start it first:  PORT=${port} bash scripts/agenthire-up.sh`);
    process.exit(1);
  }
  const { signer, source: payerSource } = payerSignerFromEnv();

  /* ── 0) What we are talking to ─────────────────────────────────────────── */
  header(
    "0. The marketplace: an unmodified AgentHire on this machine, keyless",
    "We open a real agent shop on our own computer. Its till is a toy till: it writes receipts but moves no money.",
  );
  line(`AgentHire ${base} (shalpate/agenthire @ ${AGENTHIRE_PIN.slice(0, 7)}), chain ${info.chainId} (${info.chain ?? "?"})`);
  if (!loopback) line("WARNING: not a loopback address (AGENTHIRE_ALLOW_REMOTE=1): AgentHire's money routes are unauthenticated.");
  line(`MockUSDC ${info.contracts.MockUSDC}   EscrowPayment ${info.contracts.EscrowPayment}`);
  line(`settlement mode: ${mode}` + (mode === "mock" ? " (POST /api/x402/pay answers status \"mock\", realTx false: SIMULATED)" : ""));
  line(`payer: ${signer.address} (${payerSource === "throwaway" ? "throwaway in-memory wallet, no funds" : "from AGENTHIRE_PAYER_KEY, env only, never written"})`);
  if (mode === "fuji") {
    line("AGENTHIRE_SETTLE=fuji: the same signed permit goes out as X-Payment on /api/x402/demo-execute/:id.");
    line("To settle, AgentHire needs its facilitator key and a reachable Fuji RPC, AND the payer must hold Mock USDC on");
    line("Fuji (transferWithAuthorization moves the permit's value out of permit.from, onchain.py:431-441). This sandbox has");
    line("none of the three, so this path has NOT been run here." + (payerSource === "throwaway" ? " With a throwaway payer it cannot settle anywhere: set" : ""));
    if (payerSource === "throwaway") line("AGENTHIRE_PAYER_KEY to a key that holds Fuji Mock USDC (env only) to try it.");
    line("A permit AgentHire does not confirm is still charged (UNCONFIRMED): it stays redeemable until validBefore.");
    line("On chain, contracts/contracts/SpendCapHook.sol enforces the cap at swap time (a view-style beforeSwap check");
    line("against MandateRegistry.canSpend); the same check in front of transferWithAuthorization is not built.");
  }
  line("No escrow claim: AgentHire's live flows never call EscrowPayment.depositFunds; completion and refunds only");
  line("change its database (app.py:2899-2915). Nothing below is escrow-protected.");

  const agent5: AgentHireAgent = await client.getAgent(WEBCRAWLER_X);
  line(`WebCrawler X = agent ${agent5.id} "${agent5.name}" by ${agent5.seller}, use case ${agent5.use_case}, deployer ${agent5.deployer_wallet}`);

  /* Services shared by every step. */
  await rm(incidentFile, { force: true });
  const incidents = new IncidentLedger(new JsonFileIncidentStore(incidentFile));
  line(`incident record: ${relative(repoRoot, incidentFile)} (a local JSON file on the Allowance side, emptied at the start`);
  line("of each run so the story repeats; any process that opens it sees the same incidents)");
  const tree = new DelegationTree();
  const quotes = new QuoteBook();
  const operators = new OperatorRegistry();
  const screening = new AgentHireScreeningService({ client, operators, incidents, inner: new MockScreeningService() });
  const settlement = new AgentHireSettlementService({
    client,
    signer,
    ...agentHireTreeHooks(tree),
    payerAgentIdOf: aliasPayerAgentId,
    mode,
    quotes,
  });
  const payer = new SerializedPayer({ identity: new MockIdentityGate(), screening, settlement });
  const expiry = nowS() + 30 * 24 * 3600;

  /* ── 1) The fund funds its Luckin PM ────────────────────────────────────── */
  header(
    "1. A verified human funds fund.eth; the fund gives its Luckin PM a capital mandate",
    "Grandma puts money in the family fund. The fund gives one trader an envelope: trade Luckin, hedge, and buy data. Nothing else.",
  );
  const human = await new MockPrincipalVerifier().verify({ action: "fund-root", signal: ROOT });
  tree.fundRoot({ principal: "fund", rootName: ROOT, mandate: { budget: FUND_AUM, expiry }, principalVerified: human.verified });
  line(`World IDKit (MOCK) verified the principal: ${human.verified} [nullifier ${human.nullifierHash?.slice(0, 18)}…]`);
  const pmMerchants = ["otc:LKNCY", "etf:KWEB", agentHireMerchant(WEBCRAWLER_X), agentHireMerchant(RESEARCHBOT_PRO), agentHireMerchant(DATASIFT)];
  await payer.run(tree, ROOT, () => tree.delegate(ROOT, "luckin-pm", { budget: PM_CAPITAL, allowedMerchants: pmMerchants, expiry }));
  line(`${ROOT} ${USDC(FUND_AUM)} -> ${PM} ${USDC(PM_CAPITAL)}`);
  line(`PM may pay: ${pmMerchants.join(", ")}`);
  line(`fund.eth available: ${USDC(tree.available(ROOT))}`);

  /* ── 2) Size the data job from AgentHire's own quotes ───────────────────── */
  header(
    "2. The PM opens a data budget for the scraper, sized from AgentHire's own quotes",
    "Before hiring, ask the shop for today's price. The helper gets exactly that price, and its own helpers share what is left.",
  );
  // The QuoteBook reads GET /api/pricing/quote itself: the only way a quote gets on file.
  const [e5, e6, e3] = await Promise.all([
    quotes.fetch(client, SCRAPER, WEBCRAWLER_X),
    quotes.fetch(client, A6, RESEARCHBOT_PRO),
    quotes.fetch(client, A3, DATASIFT),
  ]);
  const show = (name: string, q: Readonly<AgentHireQuote>) =>
    line(
      `GET /api/pricing/quote/${q.agentId}  ${name.padEnd(18)} currentPrice ${q.currentPrice} USDC ` +
        `(band ${q.minPrice}-${q.maxPrice}, surge x${q.surgeMultiplier}${q.surgeActive ? " active" : ""})`,
    );
  show("WebCrawler X", e5.quote);
  show("ResearchBot Pro", e6.quote);
  show("DataSift Analytics", e3.quote);
  line("A hire is one billing unit at AgentHire's currentPrice (WebCrawler X bills per minute): the quote IS the amount.");
  const mainQuote = e5.micro;
  const w6 = e6.micro;
  const w3 = e3.micro;
  const cap = policyCap(mainQuote, w6, w3);
  const plan = planHire({
    cap,
    main: mainQuote,
    subs: [
      { key: A6_LABEL, weight: w6 },
      { key: A3_LABEL, weight: w3 },
    ],
  });
  const aliasMerchant = { [A6_LABEL]: agentHireMerchant(RESEARCHBOT_PRO), [A3_LABEL]: agentHireMerchant(DATASIFT) };
  // The scraper and both aliases in ONE all-or-nothing write: every node is
  // checked (the aliases against the scraper as it will be) before any is created.
  await payer.run(tree, PM, () =>
    delegateAll(tree, PM, [
      {
        label: "scraper",
        mandate: {
          budget: cap,
          allowedMerchants: [agentHireMerchant(WEBCRAWLER_X), agentHireMerchant(RESEARCHBOT_PRO), agentHireMerchant(DATASIFT)],
          expiry,
        },
        children: plan.subs.map((s) => ({ label: s.key, mandate: { budget: s.budget, allowedMerchants: [aliasMerchant[s.key]!], expiry } })),
      },
    ]),
  );
  line(`cap = 1.5 x (${formatAmount(mainQuote)} + ${formatAmount(w6)} + ${formatAmount(w3)}) = ${USDC(cap)}   (a policy multiple of quotes, not a typed number)`);
  line(`main: WebCrawler X gets exactly its quote, ${USDC(mainQuote)}`);
  for (const s of plan.subs) {
    line(`sub:  ${s.key.padEnd(10)} ${USDC(s.budget).padEnd(16)} = (cap - main) x ${formatAmount(s.weight)} / ${formatAmount(w6 + w3)}   (pro rata to its quote)`);
  }
  line("All three nodes were checked first and written together (delegateAll): the tree cannot end up half-built.");
  line("Aliases: one node per (hirer, sub-agent) edge. DataSift (3) hires WebCrawler X (5) inside AgentHire, and here 5 hires 3:");
  line("a cycle. a3-via-a5 and any a5-via-a3 stay separate nodes, so neither parent's budget leaks into the other's.");
  expect("sub-agent budgets sum to cap - main", plan.subs.reduce((s, x) => s + x.budget, 0n), cap - mainQuote);
  expect("scraper available == the main quote", tree.available(SCRAPER), mainQuote);

  /* ── 3) The scraper hires WebCrawler X over x402 ────────────────────────── */
  header(
    "3. The scraper hires WebCrawler X at its quote, paying over x402 (EIP-3009 on Mock USDC)",
    "The shop says 'pay me'. Before signing, we check the price is the quote, the coin is the right coin, the shop is the right shop, and the IOU expires before our envelope does.",
  );
  const hire = await payer.pay(tree, { node: SCRAPER, merchant: agentHireMerchant(WEBCRAWLER_X), amount: mainQuote, purpose: "baidu-maps-store-count" });
  verdict(`scraper pays WebCrawler X ${USDC(mainQuote)}`, hire);
  const hireReceipt = settlement.receipts.at(-1)!;
  if (hire.screening) line(`screening: ${hire.screening.approved ? "APPROVED" : "BLOCKED"} — ${hire.screening.reason ?? ""}`);
  if (hireReceipt.challenge && hireReceipt.permit) {
    const ch = hireReceipt.challenge;
    const p = hireReceipt.permit;
    line(`402 challenge: ${ch.resourceId}, amountMicro ${ch.amountMicro}, chain ${ch.chainId}, token ${ch.token}, recipient ${ch.recipient}`);
    line(`permit (signed by ${signer.address}): value ${p.value} to ${p.to}, validBefore ${p.validBefore} <= mandate expiry ${expiry}, own nonce ${p.nonce.slice(0, 12)}…`);
    line(`AgentHire answered on ${hireReceipt.route}: session ${String(hireReceipt.sessionId)}, realTx ${hireReceipt.realTx}, simulated ${hireReceipt.simulated}`);
    line(`note: ${hireReceipt.note ?? ""}`);
  }
  expect("step 3 outcome", hire.outcome, "SETTLED");
  check("AgentHire confirmed it (not charged as UNCONFIRMED)", hireReceipt.unconfirmed !== true, hireReceipt.unconfirmed ? hireReceipt.note : "");
  // Two different AgentHire routes agree: the 402 it priced (after its own
  // float decoding) is the quote the QuoteBook read from /api/pricing/quote.
  expect("AgentHire's 402 amountMicro == the quote AgentHire served for agent 5", hireReceipt.challenge?.amountMicro ?? "none", e5.micro.toString());
  expect("signed permit value == AgentHire's 402 amountMicro", hireReceipt.permit?.value ?? "none", hireReceipt.challenge?.amountMicro ?? "none");
  expect("challenge chainId", hireReceipt.challenge?.chainId ?? -1, 43113);
  check("token == MockUSDC from /api/onchain/info", sameAddr(hireReceipt.challenge?.token, info.contracts.MockUSDC));
  check("recipient == EscrowPayment from /api/onchain/info", sameAddr(hireReceipt.challenge?.recipient, info.contracts.EscrowPayment));
  check("permit validBefore <= mandate expiry", (hireReceipt.permit?.validBefore ?? Infinity) <= expiry);
  check(
    "permit signature recovers to our signer",
    hireReceipt.permit !== undefined && sameAddr(recoverPermitSigner(hireReceipt.permit, info.contracts.MockUSDC, info.chainId), signer.address),
  );
  if (mode === "mock") expect("labelled simulated (keyless AgentHire)", hireReceipt.simulated, true);

  header(
    "3b. What AgentHire does not check, Allowance does (on a 10-minute mandate)",
    "AgentHire would take an IOU for a millionth of a dollar against a 5-dollar job, or one that already expired. We will not even sign those.",
  );
  line("AgentHire's require_x402 never compares permit.value with the price and never checks validBefore or the");
  line("nonce (x402.py:215-246): an expired 1-micro-USDC permit unlocked a 5 USDC resource.");
  const spot = await quotes.fetch(client, SPOT, WEBCRAWLER_X);
  await payer.run(tree, PM, () => tree.delegate(PM, "spot-check", { budget: spot.micro, allowedMerchants: [agentHireMerchant(WEBCRAWLER_X)], expiry: nowS() + 600 }));
  const receiptsBefore = settlement.receipts.length;
  const typed = await payer.pay(tree, { node: SPOT, merchant: agentHireMerchant(WEBCRAWLER_X), amount: 1n });
  verdict("pay 1 micro-USDC (a typed amount, not the quote)", typed);
  const early = await payer.pay(tree, { node: SPOT, merchant: agentHireMerchant(WEBCRAWLER_X), amount: spot.micro });
  verdict(`pay the quote ${USDC(spot.micro)} from a mandate that ends in 10 minutes`, early);
  check("typed amount refused against the quote", typed.outcome === "BLOCKED_MANDATE" && /amount 1 != AgentHire quote/.test(typed.reason ?? ""), typed.reason);
  check("permit that outlives the mandate refused", early.outcome === "BLOCKED_MANDATE" && /outlives the mandate/.test(early.reason ?? ""), early.reason);
  check(
    "nothing was signed or sent for either",
    settlement.receipts.slice(receiptsBefore).every((r) => r.permit === undefined && !r.settled),
  );

  /* ── 4) WebCrawler X hires a sub-agent (A2A) ────────────────────────────── */
  header(
    "4. WebCrawler X's alias hires ResearchBot Pro out of its OWN allowance (A2A; scripted by this demo, SIMULATED route)",
    "The helper hires its own helper, but only with the small envelope it was handed, not with the fund's money.",
  );
  line("This demo acts for agent 5 through its alias node; AgentHire's WebCrawler X itself never contacts Allowance.");
  const sub = await payer.pay(tree, { node: A6, merchant: agentHireMerchant(RESEARCHBOT_PRO), amount: w6, purpose: "city-name-reconciliation" });
  verdict(`a6-via-a5 pays ResearchBot Pro ${USDC(w6)}`, sub);
  const subReceipt = settlement.receipts.at(-1)!;
  const tag = `allowance:${A6}#${sub.seq}`;
  line(`POST /api/sim/trigger-direct ${WEBCRAWLER_X} -> ${RESEARCHBOT_PRO}, reason "${subReceipt.a2a?.reason ?? "?"}", events ${subReceipt.a2a?.eventIds.join(", ") ?? "-"} (SIMULATED route)`);
  expect("step 4 outcome", sub.outcome, "SETTLED");
  expect("A2A tagged with the PAYMENT event's seq", subReceipt.a2a?.reason ?? "", tag);
  const firstEventId = Math.min(...(subReceipt.a2a?.eventIds ?? [1]));
  const logged = (await client.simEvents(Math.max(0, firstEventId - 1), 50)).events.find(
    (e) => e.kind === "a2a_hire" && e.meta.trigger === tag,
  );
  check("AgentHire's own event log carries the tag", logged !== undefined, logged ? `event ${logged.id}: ${logged.message}` : "not found");
  line(`WebCrawler X's ResearchBot Pro allowance left: ${USDC(tree.available(A6))}`);

  header(
    "4b. WebCrawler X's other alias fires several DataSift hires at the same instant, one more than it holds (scripted)",
    "Two hands reach into the same envelope at once. Only one at a time is allowed in, so the last one finds it empty.",
  );
  const room = tree.available(A3) / w3; // whole DataSift calls the alias can pay for
  const burst = Number(room) + 1;
  const racing = await Promise.all(
    Array.from({ length: burst }, () => payer.pay(tree, { node: A3, merchant: agentHireMerchant(DATASIFT), amount: w3, purpose: "dedupe-and-count" })),
  );
  racing.forEach((r, i) => verdict(`concurrent hire ${i + 1}/${burst}`, r));
  line("Every SerializedPayer on this tree shares fund.eth's queue, so each payment sees the spend booked before it.");
  line("Core pay() alone checks the budget, then awaits settlement: concurrent calls could all pass the check (unit-tested).");
  expect("concurrent hires that settled", racing.filter((r) => r.outcome === "SETTLED").length, Number(room));
  expect("concurrent hires blocked (the extra one)", racing.filter((r) => r.outcome === "BLOCKED_MANDATE").length, 1);
  check("a3-via-a5 never went below zero", tree.available(A3) >= 0n, USDC(tree.available(A3)));

  /* ── 5) WebCrawler X overspends: blocked twice -> incident ──────────────── */
  header(
    "5. SIMULATED behaviour, scripted by this demo acting for agent 5: 10 more ResearchBot Pro calls at once, twice",
    "The helper keeps asking for more than its envelope holds. It is stopped each time, and after the second try it gets a note in its file. A note, not a fine.",
  );
  line("These two over-mandate attempts are made by this script through agent 5's alias node, not by AgentHire's");
  line("WebCrawler X. They show what Allowance does when an agent keeps pushing past its mandate.");
  const markEvents = (await client.simEvents(0, 500)).events;
  const mark = markEvents.length ? Math.max(...markEvents.map((e) => e.id)) : 0;
  const repBefore = await client.reputation(WEBCRAWLER_X);
  const stakeBefore = await client.stake(WEBCRAWLER_X);
  const watch = new OverspendWatch({ ledger: incidents, operators, threshold: 2, note: SCRIPTED, report: { client, affectedUser: signer.address } });
  const greedy = w6 * 10n;
  const o1 = await payer.pay(tree, { node: A6, merchant: agentHireMerchant(RESEARCHBOT_PRO), amount: greedy });
  verdict(`attempt 1: ${USDC(greedy)}`, o1);
  const i1 = await watch.observe(o1, WEBCRAWLER_X);
  const o2 = await payer.pay(tree, { node: A6, merchant: agentHireMerchant(RESEARCHBOT_PRO), amount: greedy });
  verdict(`attempt 2: ${USDC(greedy)}`, o2);
  const incident = await watch.observe(o2, WEBCRAWLER_X);
  const repAfter = await client.reputation(WEBCRAWLER_X);
  const stakeAfter = await client.stake(WEBCRAWLER_X);
  const simSlashes = (await client.simEvents(mark, 500)).events.filter((e) => e.kind === "slash" && e.agentId === WEBCRAWLER_X).length;
  if (incident) {
    line(`INCIDENT ${incident.id}: agent ${incident.agentId}, operator ${incident.deployerWallet} (World ID MOCK nullifier ${incident.operator.slice(0, 18)}…)`);
    line(`   ${incident.kind}: ${incident.reason}`);
    line(`   provenance: ${incident.note ?? "-"}`);
    line(`   stored in ${relative(repoRoot, incidentFile)} (Allowance-side)`);
    const rep = incident.agentHireReport;
    line(`   sent to AgentHire ${rep?.route}: ${rep?.ok ? rep.status : `failed: ${rep?.error}`}${rep?.note ? ` — "${rep.note}"` : ""}`);
  }
  line("AgentHire has no keyless route that adds an incident without slashing: every incident counter it has moves");
  line("only inside a slash (sim_engine.py:713-737, simulation.py:162-185, reached via /api/sim/slash-agent). Slashing");
  line("is for misconduct, and this agent was stopped by its mandate, so the incident is kept Allowance-side, keyed by");
  line("agent AND operator. It was also sent to AgentHire's /api/dispute/submit, which without keys only prints it to");
  line("its server log and answers pending_review (no ModerationReport row, no incident counter change). Allowance");
  line("slashed nothing.");
  line(
    `AgentHire's own record for agent 5 (its SIMULATED DB mirror): incidents ${repBefore.incidentCount} -> ${repAfter.incidentCount}, ` +
      `stake ${stakeBefore.stakedUSDC} -> ${stakeAfter.stakedUSDC} micro-USDC` +
      (simSlashes ? ` (its own simulator slashed agent 5 ${simSlashes}x meanwhile)` : ""),
  );
  expect("attempt 1", o1.outcome, "BLOCKED_MANDATE");
  expect("attempt 2", o2.outcome, "BLOCKED_MANDATE");
  check("blocked by the budget check", /exceeds available/.test(o1.reason ?? "") && /exceeds available/.test(o2.reason ?? ""));
  expect("no incident after one attempt", i1 === null, true);
  expect("incident kind", incident?.kind ?? "none", "mandate_overspend");
  check("incident keyed by WebCrawler X's operator", sameAddr(incident?.deployerWallet, agent5.deployer_wallet ?? undefined), incident?.deployerWallet);
  expect("AgentHire's dispute route answered (log only)", incident?.agentHireReport?.status ?? "none", "pending_review");
  expect("AgentHire incident count moved only by its own sim slashes", repAfter.incidentCount - repBefore.incidentCount, simSlashes);
  if (simSlashes === 0) expect("AgentHire stake untouched (no slash)", stakeAfter.stakedUSDC, stakeBefore.stakedUSDC);

  /* ── 6) A second buyer is turned away ───────────────────────────────────── */
  header(
    "6. A second buyer, in a different tree with its own services, tries to hire WebCrawler X",
    "Another family wants the same helper. The note in its file says it keeps overspending, so the door stays shut.",
  );
  // Nothing is shared with the first buyer except the incident FILE: a new
  // operator registry, a new ledger that loads the file from disk (as another
  // process or a restart would), new screening, settlement and quote book.
  const ledger2 = new IncidentLedger(new JsonFileIncidentStore(incidentFile));
  const screening2 = new AgentHireScreeningService({ client, operators: new OperatorRegistry(), incidents: ledger2, inner: new MockScreeningService() });
  const tree2 = new DelegationTree();
  tree2.fundRoot({ principal: "second buyer", rootName: BUYER2, mandate: { budget: parseAmount("50"), allowedMerchants: [agentHireMerchant(WEBCRAWLER_X)], expiry } });
  const quotes2 = new QuoteBook();
  const settlement2 = new AgentHireSettlementService({ client, signer: createThrowawaySigner(), ...agentHireTreeHooks(tree2), mode, quotes: quotes2 });
  const payer2 = new SerializedPayer({ identity: new MockIdentityGate(), screening: screening2, settlement: settlement2 });
  const e5b = await quotes2.fetch(client, BUYER2, WEBCRAWLER_X);
  line(`its own ledger loads ${relative(repoRoot, incidentFile)} from disk; its own operator registry re-binds agent 5 from AgentHire`);
  const refused = await payer2.pay(tree2, { node: BUYER2, merchant: agentHireMerchant(WEBCRAWLER_X), amount: e5b.micro });
  verdict(`${BUYER2} pays WebCrawler X ${USDC(e5b.micro)}`, refused);
  expect("step 6 outcome", refused.outcome, "BLOCKED_SCREENING");
  check("refused because of the operator's incident", sameAddr(/operator (0x[0-9a-f]{40})/.exec(refused.reason ?? "")?.[1], agent5.deployer_wallet ?? undefined), refused.reason);
  expect("the second buyer's ledger read the incident from disk", ledger2.countForAgent(WEBCRAWLER_X), 1);
  expect("nothing was signed or sent to AgentHire", settlement2.receipts.length, 0);

  /* ── 7) Operators ───────────────────────────────────────────────────────── */
  header(
    "7. Operators: every agent is bound to its deployer wallet and a World ID (MOCK) nullifier",
    "Two shops with different names but the same owner are one owner. A note about the owner follows every shop they run.",
  );
  const b4 = await operators.bindFromAgentHire(client, ALPHATRADER);
  const b11 = await operators.bindFromAgentHire(client, FINANCEGPT);
  const [a4, a11] = await Promise.all([client.getAgent(ALPHATRADER), client.getAgent(FINANCEGPT)]);
  for (const b of operators.list()) {
    line(`agent ${String(b.agentId).padEnd(3)} deployer ${b.deployerWallet}  nullifier ${b.worldIdNullifier.slice(0, 18)}…  (World ID MOCK)`);
  }
  line(`"${a4.name}" (${ALPHATRADER}) and "${a11.name}" (${FINANCEGPT}) are both run by ${a4.seller}: one counterparty.`);
  const crawltechAgents: number[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const list = await client.listAgents({ page, per_page: 50 });
    pages = Math.ceil(list.total / list.per_page);
    for (const a of list.agents) if (sameAddr(a.deployer_wallet ?? undefined, agent5.deployer_wallet ?? undefined)) crawltechAgents.push(a.id);
  }
  line(`${agent5.seller} runs ${crawltechAgents.length} agent(s) in AgentHire's roster (${crawltechAgents.join(", ")}); any agent bound to its`);
  line("wallet resolves to the same nullifier and inherits its incidents (unit-tested on Prism Labs' TestSmith -> StackTracer).");
  check("QuantEdge Labs' two agents are one counterparty", operators.sameCounterparty(ALPHATRADER, FINANCEGPT) && b4.worldIdNullifier === b11.worldIdNullifier);
  check("WebCrawler X and ResearchBot Pro are different counterparties", !operators.sameCounterparty(WEBCRAWLER_X, RESEARCHBOT_PRO));
  expect("incidents on WebCrawler X's operator", incidents.countForOperator(operators.counterpartyOf(WEBCRAWLER_X) ?? ""), 1);

  /* ── 8) The allocator stops the PM out ──────────────────────────────────── */
  const world = makeWorld(arenaSeed);
  header(
    `8. The allocator watches the PM's track record (VIRTUAL: synthetic arena world #${arenaSeed}) and stops it out`,
    "The trader's practice scores go bad. The fund takes the envelope back, and the scraper's envelope inside it disappears in the same move, even though it still had money for the next job.",
  );
  // The next scrape: without it, step 3 and 4b leave every data node below one
  // hire, and the close would only reclaim leftovers too small to use.
  const [n5, n6, n3] = await Promise.all([
    quotes.fetch(client, SCRAPER, WEBCRAWLER_X),
    quotes.fetch(client, A6, RESEARCHBOT_PRO),
    quotes.fetch(client, A3, DATASIFT),
  ]);
  const nextPlan = planHire({
    cap: policyCap(n5.micro, n6.micro, n3.micro),
    main: n5.micro,
    subs: [
      { key: A6_LABEL, weight: n6.micro },
      { key: A3_LABEL, weight: n3.micro },
    ],
  });
  const aliasNode = (label: string): string => `${label}.${SCRAPER}`;
  await payer.run(tree, PM, () => {
    // Checked first so the three resizes cannot stop halfway: the scraper grows
    // by the whole cap out of the PM, the aliases by their share out of that.
    if (tree.available(PM) < nextPlan.cap) throw new Error(`PM cannot fund the next scrape (${nextPlan.cap} > ${tree.available(PM)})`);
    tree.resize(SCRAPER, tree.requireNode(SCRAPER).mandate.budget + nextPlan.cap);
    for (const s of nextPlan.subs) tree.resize(aliasNode(s.key), tree.requireNode(aliasNode(s.key)).mandate.budget + s.budget);
  });
  line(`The PM re-quotes and funds the scraper's NEXT scrape (planHire again, ${USDC(nextPlan.cap)}): WebCrawler X ${USDC(n5.micro)},`);
  line(`ResearchBot Pro ${USDC(n6.micro)}, DataSift ${USDC(n3.micro)} per hire.`);
  const nextHires: Array<{ node: string; agentId: number; quote: bigint }> = [
    { node: SCRAPER, agentId: WEBCRAWLER_X, quote: n5.micro },
    { node: A6, agentId: RESEARCHBOT_PRO, quote: n6.micro },
    { node: A3, agentId: DATASIFT, quote: n3.micro },
  ];
  const dataNodes = [SCRAPER, A6, A3];
  const dataUnspent = (): bigint =>
    tree.requireNode(SCRAPER).mandate.budget - dataNodes.reduce((s, n) => s + tree.requireNode(n).mandate.spentDirect, 0n);
  for (const h of nextHires) {
    check(
      `${h.node.split(".")[0]} holds a full hire at its quote before the stop-out`,
      tree.available(h.node) >= h.quote,
      `available ${USDC(tree.available(h.node))} >= quote ${USDC(h.quote)}`,
    );
  }

  const { panel, events } = tigerPanel(world);
  const run = runTiger(panel, events, { ...RECOMMENDED_TIGER, hedgeSymbol: "VIDX" }, { from: 60, to: panel.dates.length - 1 });
  const policy = defaultCenterBookPolicy();
  // The PM mandate's own stop-loss: the fixed rungs, which are also the floor
  // of the center book's risk-scaled ladder. The center book only ever widens
  // them (never past ddStopMax); what it would do to this path is printed too.
  const thresholds = { ddCut: policy.ddCut, ddRecover: policy.ddRecover, ddStop: policy.ddStop };
  const scaled = scaleLadder(run.ret, {
    ...thresholds,
    ddStopVol: policy.ddStopVol,
    volWindow: policy.window,
    ddStopMax: policy.ddStopMax,
  });
  line(`PM return path: the Tiger overlay (packages/lab) on ${panel.primary} in synthetic arena world #${arenaSeed}, ${run.ret.length} days.`);
  line(
    `This is a SIMULATED path, not market data. Ladder (swarm nextLadderState) on the PM mandate's own fixed stop-loss: ` +
      (thresholds.ddCut === undefined ? "no cut rung," : `cut at ${thresholds.ddCut * 100}% drawdown,`),
  );
  line(
    (thresholds.ddCut === undefined ? "" : `restore below ${(thresholds.ddRecover ?? 0) * 100}%, `) +
      `stop out at ${thresholds.ddStop * 100}%. (The center book's risk-scaled default would widen these ×${scaled.scale.toFixed(2)}`,
  );
  const capped = scaled.ddStop >= policy.ddStopMax - 1e-12;
  // Replay the same path under the center book's own rungs, for the record.
  let centerState: LadderState = "active";
  for (let t = 1; t <= run.ret.length && centerState !== "stopped"; t++) {
    centerState = nextLadderState(centerState, run.ret.slice(0, t), {
      ...thresholds,
      ddStopVol: policy.ddStopVol,
      volWindow: policy.window,
      ddStopMax: policy.ddStopMax,
    });
  }
  line(`for the full path's ${(scaled.vol * 100).toFixed(0)}% vol at its high-water mark, to a ${(scaled.ddStop * 100).toFixed(0)}% stop` +
    `${capped ? " (its ceiling)" : ` (ceiling ${policy.ddStopMax * 100}%)`}; the fixed rungs are its floor. Under those rungs this path ends ${centerState.toUpperCase()}.)`);
  let state: LadderState = "active";
  const transitions: Array<{ day: number; date: string; from: LadderState; to: LadderState; drawdown: number; pmBudget: string }> = [];
  const cutBudget = (PM_CAPITAL * BigInt(Math.round((policy.cutFactor ?? 1) * 1000))) / 1000n;
  let freed = 0n;
  let rootBefore = 0n;
  let rootAfter = 0n;
  let pmBudgetAtStop = 0n;
  let subtreeSpent = 0n;
  let dataBefore = 0n;
  let dataAfter = -1n;
  for (let t = 1; t <= run.ret.length; t++) {
    const path = run.ret.slice(0, t);
    const next = nextLadderState(state, path, thresholds);
    if (next === state) continue;
    const dd = currentDrawdown(path);
    const date = run.dates[t - 1] ?? `day ${t}`;
    if (next === "cut") {
      await payer.run(tree, PM, () => tree.resize(PM, cutBudget));
      line(`day ${String(t).padStart(3)} (${date}) drawdown ${(dd * 100).toFixed(1)}% -> CUT: resize ${PM} to ${USDC(cutBudget)}`);
    } else if (next === "active") {
      await payer.run(tree, PM, () => tree.resize(PM, PM_CAPITAL));
      line(`day ${String(t).padStart(3)} (${date}) drawdown ${(dd * 100).toFixed(1)}% -> RESTORED: resize ${PM} to ${USDC(PM_CAPITAL)}`);
    } else {
      rootBefore = tree.available(ROOT);
      pmBudgetAtStop = tree.requireNode(PM).mandate.budget;
      subtreeSpent = [PM, SCRAPER, A6, A3, SPOT].reduce((s, n) => s + tree.requireNode(n).mandate.spentDirect, 0n);
      dataBefore = dataUnspent();
      line(`day ${String(t).padStart(3)} (${date}) drawdown ${(dd * 100).toFixed(1)}% -> STOP-OUT`);
      line(`   before: fund.eth available ${USDC(rootBefore)}; data subtree unspent ${USDC(dataBefore)} ` +
        `(scraper ${USDC(tree.available(SCRAPER))}, a6-via-a5 ${USDC(tree.available(A6))}, a3-via-a5 ${USDC(tree.available(A3))})`);
      freed = await payer.close(tree, PM);
      rootAfter = tree.available(ROOT);
      dataAfter = dataUnspent();
      line(`   tree.close("${PM}") freed ${USDC(freed)} back to fund.eth (the subtree keeps only the ${USDC(subtreeSpent)} it spent)`);
      line(`   after:  fund.eth available ${USDC(rootAfter)} (+${USDC(rootAfter - rootBefore)}); data subtree unspent ${USDC(dataAfter)}`);
    }
    transitions.push({ day: t, date, from: state, to: next, drawdown: dd, pmBudget: tree.requireNode(PM).mandate.budget.toString() });
    state = next;
    if (state === "stopped") break;
  }
  expect("the ladder stopped the PM out", state, "stopped");
  expect("fund.eth available rose by exactly the freed amount", rootAfter - rootBefore, freed);
  expect("freed == PM budget - everything its subtree spent", freed, pmBudgetAtStop - subtreeSpent);
  check("the data subtree still held unspent budget when the PM was stopped out", dataBefore > 0n, USDC(dataBefore));
  expect("data subtree unspent after close", dataAfter, 0n);
  for (const n of [PM, SCRAPER, A6, A3]) expect(`${n.split(".")[0]} available after close`, tree.available(n), 0n);
  const afterClose: PaymentRecord[] = [];
  for (const h of nextHires) {
    const r = await payer.pay(tree, { node: h.node, merchant: agentHireMerchant(h.agentId), amount: h.quote });
    verdict(`${h.node.split(".")[0]} tries its next hire at the quote ${USDC(h.quote)}`, r);
    expect(`${h.node.split(".")[0]} quote-priced hire after close`, r.outcome, "REVOKED");
    afterClose.push(r);
  }

  /* ── 9) Shadow audit of AgentHire's own A2A hires ───────────────────────── */
  header(
    `9. SHADOW AUDIT: AgentHire's own agent-to-agent hires, replayed through Allowance`,
    "We watch the shop's pretend market for a while and ask: if every helper-of-a-helper had needed an envelope, how many would have been stopped?",
  );
  let status = await client.simStatus();
  if (!status.running) status = await client.simStart();
  const originalTick = typeof status.tickRealSeconds === "number" ? status.tickRealSeconds : null;
  await client.setSimSpeed(0.1);
  line(`AgentHire sim tick set to 0.1s via its own POST /api/sim/speed (was ${originalTick ?? "?"}s); restored afterwards.`);
  const source: SimEventSource = {
    async eventsSince(sinceId, limit) {
      const page = await client.simEvents(sinceId, limit);
      return page.events.map(parseSimEvent).filter((e): e is NonNullable<typeof e> => e !== null);
    },
  };
  let collected;
  try {
    collected = await collectSimEvents(source, { durationMs: auditSeconds * 1000, pollMs: 1000, limit: 500 });
  } finally {
    if (originalTick !== null) await client.setSimSpeed(originalTick).catch((e: unknown) => line(`warning: could not restore sim speed: ${String(e)}`));
  }
  const linked = linkPrimaryJobs(collected.events);
  const primaryIds = [...new Set(linked.jobs.map((j) => j.primaryId))].sort((a, b) => a - b);
  const auditQuotes: AgentHireQuoteLike[] = [];
  for (const id of primaryIds) {
    const q = await client.quote(id);
    auditQuotes.push({ agentId: q.agentId, minPrice: q.minPrice, maxPrice: q.maxPrice, currentPrice: q.currentPrice });
  }
  const workflows: A2AWorkflowLike[] = (await client.a2aCandidates()).flagships.map((f) => ({
    id: f.id,
    name: f.name,
    subAgents: f.subAgents.map((s) => ({ id: s.id, name: s.name, estCostHigh: s.estCostHigh ?? null })),
  }));
  const report = await runShadowAudit({
    events: collected.events,
    quotes: auditQuotes,
    workflows,
    source: `${base} /api/sim/events: retained buffer + ${auditSeconds}s live polling (simulated marketplace)`,
  });
  const o = report.outsideAuthorization;
  line(
    `captured ${report.window.events} events (ids ${report.window.firstEventId}..${report.window.lastEventId}): AgentHire's retained buffer ` +
      `(its last 500) plus ${auditSeconds}s of live polling, ${collected.missed ? `${collected.missed} ids missed between polls` : "no gaps"}`,
  );
  line(`budget assumption (headline): ${report.assumption}`);
  line(`sizing: ${report.sizing}`);
  console.log("");
  line(
    `HEADLINE  ${report.blocked} of ${report.subPayments} sub-agent payments would have been blocked even under AgentHire's own displayed`,
  );
  line(`          Hard Spend Cap (${report.blockedUSDC} of ${report.totalSubUSDC} USDC unbudgeted).`);
  line(`          All ${o.payments} (${o.usdc} USDC) were outside what the buyer authorized for the primary job, BY DEFINITION:`);
  line("          AgentHire pays sub-agents on top of the primary's price, and books them from the primary agent's wallet.");
  line(
    `          Priced at ${report.primaryUSDC} USDC for ${report.primaries} simulated primary jobs, ${report.demoPrimaries} of them AgentHire's` +
      " force-all demo cascade with no paying buyer.",
  );
  line("          [all of it is AgentHire's SIMULATED marketplace; nothing was settled or moved]");
  console.log("");
  line("same payments under each buyer cap:");
  for (const s of report.sensitivity) {
    line(
      `  ${s.scenario.padEnd(17)} ${String(s.blocked).padStart(4)} of ${s.subPayments} ${s.scenario === "strict" ? "outside the buyer's authorization (by definition)" : "blocked by the replay"}, ${s.blockedUSDC} USDC`,
    );
  }
  const worst = report.byPrimary[0];
  if (worst) line(`largest sub-agent / revenue ratio: ${worst.name ?? `agent ${worst.agentId}`} ${worst.ratio}x (${worst.subUSDC} of sub-agent fees on ${worst.priceUSDC} of simulated revenue)`);
  if (report.cycles.length) line(`cycles in AgentHire's hiring graph: ${report.cycles.map(([a, b]) => `${a}<->${b}`).join(", ")} (one alias node per direction)`);
  if (report.multiParent.length) line(`sub-agents with several parents: ${report.multiParent.join(", ")} (one alias per parent)`);
  line(
    `excluded: ${report.excluded.directHires} direct trigger hires (incl. this demo's own A2A hires from steps 4 and 4b), ` +
      `${report.excluded.orphanHires} hires whose primary fell outside the window`,
  );
  expect("audit data is labelled simulated", report.simulated, true);
  check("audit replayed at least one sub-agent payment", report.subPayments > 0, `${report.subPayments} replayed`);
  // Independent of the replay: count the linked hires that carry a fee. Under
  // strict every one of them must come out outside the buyer's authorization.
  const feeHires = linked.jobs.flatMap((j) => j.hires).filter((h) => h.amount > 0n).length;
  expect("strict = every sub-agent fee, by definition (replay agrees with the linker)", o.payments, feeHires);

  /* ── Summary, snapshot, receipts ────────────────────────────────────────── */
  header("SUMMARY — the spend tree after the whole story", "How much is left in every envelope, and which ones are closed.");
  for (const node of tree.listNodes()) {
    const m = node.mandate;
    line(
      `${node.name.padEnd(38)} budget ${USDC(m.budget).padEnd(20)} spent ${USDC(m.spentDirect).padEnd(14)} ` +
        `available ${USDC(tree.available(node.name)).padEnd(20)}` +
        (m.revoked ? " [CLOSED]" : tree.isRevokedInChain(node.name) ? " [dead: ancestor closed]" : ""),
    );
  }

  // Honesty notes come from what this run actually did.
  const receipts: AgentHireReceipt[] = [...settlement.receipts, ...settlement2.receipts];
  const x402Sent = receipts.filter((r) => r.permit !== undefined && (r.route === "x402-pay" || r.route === "x402-execute"));
  const mockAnswers = x402Sent.filter((r) => r.settled && !r.unconfirmed && r.simulated).length;
  const realTx = receipts.filter((r) => r.realTx).length;
  const unconfirmed = receipts.filter((r) => r.unconfirmed === true).length;
  const a2aSim = receipts.filter((r) => r.route === "trigger-direct" && r.settled && r.simulated).length;
  const settlementSimulated = receipts.every((r) => !r.realTx);
  const honesty = [
    `AgentHire at ${base} (${loopback ? "loopback" : "NOT loopback, AGENTHIRE_ALLOW_REMOTE=1"}), settlement mode ${mode}. ` +
      `${x402Sent.length} x402 payment(s) sent a signed permit: ${mockAnswers} answered status "mock" (realTx false, nothing moved on chain), ` +
      `${realTx} reported a real tx (not verified here), ${unconfirmed} UNCONFIRMED (charged to the mandate, not confirmed by AgentHire). ` +
      `${a2aSim} A2A hire(s) used AgentHire's simulation route /api/sim/trigger-direct.`,
    "AgentHire's escrow is off-chain in live flows (completion and refunds are DB-only), so nothing here is escrow-protected.",
    `WebCrawler X's sub-hires (steps 4, 4b) and overspend attempts (step 5) were made by this demo acting for agent 5 (SIMULATED behaviour); AgentHire's WebCrawler X never contacted Allowance.`,
    `Incidents are recorded Allowance-side in ${relative(repoRoot, incidentFile)} (a local JSON file, emptied at the start of each demo run). ` +
      "They were sent to AgentHire's /api/dispute/submit, which keyless only prints them to its server log (pending_review): nothing is stored on AgentHire's side, and AgentHire has no keyless incident route that does not slash.",
    "Operator World ID nullifiers come from the World ID mock (MockPrincipalVerifier), seeded by the deployer wallet.",
    `The PM's return path is the Tiger overlay on synthetic arena world #${arenaSeed}, not market data; the ladder stop-out is simulated.`,
    "The shadow audit replays AgentHire's simulated marketplace events; its headline assumption is stated in audit.report.assumption, and the strict total is by definition.",
  ];
  const ok = failures.length === 0;
  const suffix = ok ? "" : ".failed";
  const asOf = nowS();
  const snapshotPath = resolve(repoRoot, `apps/web/public/agenthire-snapshot${suffix}.json`);
  const receiptsPath = resolve(repoRoot, `apps/web/public/agenthire-receipts${suffix}.json`);
  await mkdir(dirname(snapshotPath), { recursive: true });
  const snapshot = await writeSnapshotFile(tree, snapshotPath, { asOf });
  const sidecar = {
    asOf,
    // The shadow audit and the PM's return path are always simulated;
    // `settlementSimulated` says whether any payment reported a real tx.
    simulated: true,
    settlementSimulated,
    honesty,
    checks: { total: checks, failed: failures.length },
    agenthire: { base, loopback, pin: AGENTHIRE_PIN, mode, chainId: info.chainId, contracts: info.contracts },
    signer: {
      payer: signer.address,
      source: payerSource,
      note:
        payerSource === "throwaway"
          ? "throwaway in-memory wallets, no funds, keys never written"
          : "payer key read from AGENTHIRE_PAYER_KEY (env only, never written); the second buyer used a throwaway",
    },
    quotes: [...quotes.list(), ...quotes2.list()],
    plan,
    nextPlan,
    receipts,
    unconfirmedReceipts: unconfirmed,
    payments: { hire, typed, early, sub, concurrent: racing, overspend: [o1, o2], secondBuyer: refused, afterClose },
    incidentStore: { file: relative(repoRoot, incidentFile), persistent: incidents.persistent },
    incidents: incidents.list(),
    operators: operators.list(),
    agentHireRecord: { agentId: WEBCRAWLER_X, simulated: true, before: { reputation: repBefore, stake: stakeBefore }, after: { reputation: repAfter, stake: stakeAfter }, simSlashesInWindow: simSlashes },
    ladder: { arenaSeed, synthetic: true, instrument: panel.primary, days: run.ret.length, thresholds, rungs: "fixed per-mandate stop-loss", centerBookScaled: { ddCut: scaled.ddCut, ddStop: scaled.ddStop, vol: scaled.vol, scale: scaled.scale, ddStopMax: policy.ddStopMax, finalState: centerState }, transitions, freed, rootBefore, rootAfter, dataUnspentBefore: dataBefore, dataUnspentAfter: dataAfter },
    audit: { headline: auditHeadline(report), missed: collected.missed, polls: collected.polls, report },
  };
  await writeFile(receiptsPath, JSON.stringify(sidecar, auditJsonReplacer, 2) + "\n", "utf8");

  console.log("");
  line(`Snapshot written -> ${snapshotPath}`);
  line(`   ${snapshot.nodes.length} nodes, ${snapshot.events.length} events, asOf=${snapshot.asOf}.`);
  line(`Receipts sidecar -> ${receiptsPath}`);
  line(`   ${sidecar.receipts.length} settlement attempts (${unconfirmed} unconfirmed), ${sidecar.incidents.length} incident(s), ${sidecar.operators.length} operator bindings.`);

  if (!ok) {
    console.error("");
    console.error(`AGENTHIRE DEMO FAILED — ${failures.length} of ${checks} check(s) did not match (outputs went to *.failed.json;`);
    console.error("the committed dashboard files were left alone):");
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`Stop AgentHire with: ${stopHint}`);
    process.exit(1);
  }
  console.log("");
  console.log(`✓ AgentHire demo complete. All ${checks} checks passed. Stop AgentHire with: ${stopHint}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("AgentHire demo crashed:", err);
  process.exit(1);
});
