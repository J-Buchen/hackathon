/**
 * AgentHire — the agent marketplace that Allowance pays through.
 *
 * AgentHire (https://github.com/shalpate/agenthire, pinned at ab317f2b) is a
 * Python/Flask marketplace where buyers hire AI agents over x402 (HTTP 402 +
 * EIP-3009 `transferWithAuthorization` on Mock USDC, Avalanche Fuji 43113) and
 * agents hire each other ("A2A"). Its money routes have no caller auth, and the
 * x402 server does not check what it is paid: `require_x402` never compares
 * `permit.value` with the price, never checks `validBefore`, and never checks
 * the nonce (x402.py:215-246). This module puts Allowance in front of it, so
 * those checks happen on the payer's side before anything is signed.
 *
 * Ships:
 *   - `AgentHireClient`             typed HTTP client (quote, x402, reputation, sim events, disputes)
 *   - `AgentHireSettlementService`  core `SettlementService`: validates the 402 challenge against
 *                                   the mandate, signs EIP-3009 with an injected wallet, pays
 *   - `AgentHireScreeningService`   core `ScreeningService`: reputation, stake, and operator incidents
 *   - `OperatorRegistry`            agentId -> operator (deployer wallet + World ID nullifier)
 *   - `IncidentLedger` (+ `JsonFileIncidentStore`), `OverspendWatch`, `pushIncidentReport`   the incident loop
 *   - `SerializedPayer`             core `pay()` run one-at-a-time per root mandate
 *   - `QuoteBook`, `planHire`, `delegateAll`, `aliasNodeLabel`   hire sizing: the amount is the
 *                                   quote, sub-agents split (cap - main) pro rata, all-or-nothing
 *
 * HONESTY NOTES (read before quoting a result):
 *   - In keyless mode AgentHire's POST /api/x402/pay records an Order and answers
 *     `{status:"mock", realTx:false}`: nothing moves on chain. Receipts from that
 *     path are labelled `simulated: true`.
 *   - A2A hires go through /api/sim/trigger-direct, a simulation route. Also simulated.
 *   - AgentHire's "escrow" is off-chain in live flows (completion and refunds only
 *     change its database). Nothing here claims escrow protection.
 *   - Once a signed permit (or a trigger-direct request) has been SENT, a timeout,
 *     5xx or unexpected answer is not a refusal: AgentHire may already have
 *     booked it, and a permit is a bearer authorization until `validBefore`. Such
 *     a payment is charged to the mandate and its receipt is marked
 *     `unconfirmed` for reconciliation. Only a refusal before anything was sent
 *     (or a 4xx from trigger-direct, which refuses before booking) is `settled:false`.
 *   - `AGENTHIRE_SETTLE=fuji` sends the same signed permit as `X-Payment` on the
 *     x402-gated route. That needs a facilitator key and a reachable Fuji RPC on
 *     the AgentHire side, AND a payer whose address holds Mock USDC on Fuji
 *     (`transferWithAuthorization` moves `value` out of `permit.from`); a
 *     throwaway signer holds none. It is unit-tested with a fake fetch only; it
 *     has not been run against Fuji from this sandbox. The on-chain form of the
 *     cap is contracts/contracts/SpendCapHook.sol, which enforces it at swap time
 *     (a view-style `beforeSwap` check against MandateRegistry); the same check
 *     in front of `transferWithAuthorization` is not built.
 *   - The operator's World ID nullifier comes from the World ID MOCK
 *     (`MockPrincipalVerifier`), seeded by the deployer wallet. It shows the
 *     binding, not a real proof of personhood.
 *   - Incidents live in Allowance's `IncidentLedger` (in memory, or a local JSON
 *     file via `JsonFileIncidentStore`), not in AgentHire: keyless AgentHire's
 *     dispute route only prints what it is sent to its server log.
 *
 * MONEY: Allowance amounts are micro-USDC bigints (6 decimals). AgentHire
 * speaks float USDC and converts with Python's `int(x * 1_000_000)`, which
 * truncates about 1.2% of 6-decimal amounts one micro low (0.000249 -> 248).
 * `encodeUsdcParam` picks a decimal string that AgentHire decodes to exactly
 * the intended micro amount, and settlement still checks
 * `challenge.amountMicro === req.amount` (that echo only proves AgentHire
 * decoded the amount as sent; what binds the amount is the quote check).
 */

import {
  Signature,
  Wallet,
  getAddress,
  hexlify,
  isAddress,
  randomBytes,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import type {
  AgentNode,
  DelegateOptions,
  DelegationTree,
  MandateInput,
  PaymentAdapters,
  PaymentRecord,
  PaymentRequest,
  PayOptions,
  PrincipalVerifier,
  ScreeningRequest,
  ScreeningResult,
  ScreeningService,
  SettlementRequest,
  SettlementResult,
  SettlementService,
} from "@allowance/core";
import {
  AttenuationError,
  DuplicateNodeError,
  checkAttenuation,
  childName,
  formatAmount,
  leftLabel,
  pay,
} from "@allowance/core";
import { MockPrincipalVerifier } from "./worldidkit";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** Avalanche Fuji, the only chain AgentHire is deployed on. */
export const AGENTHIRE_CHAIN_ID = 43113;
/** EIP-712 domain name and version of AgentHire's Mock USDC. */
export const MOCK_USDC_DOMAIN_NAME = "Mock USDC";
export const MOCK_USDC_DOMAIN_VERSION = "1";
/** The x402 scheme AgentHire's challenges carry. */
export const AGENTHIRE_X402_SCHEME = "x402/eip-3009";

/** EIP-3009 TransferWithAuthorization, exactly as AgentHire signs it (x402.py:262-279). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, TypedDataField[]> = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** The EIP-712 domain for Mock USDC at `usdc` on `chainId`. */
export function mockUsdcDomain(usdc: string, chainId: number = AGENTHIRE_CHAIN_ID): TypedDataDomain {
  return {
    name: MOCK_USDC_DOMAIN_NAME,
    version: MOCK_USDC_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(usdc),
  };
}

/* ------------------------------------------------------------------ */
/* Merchant ids + money                                               */
/* ------------------------------------------------------------------ */

/** Allowance merchant id for an AgentHire agent, e.g. `agenthire:5`. */
export function agentHireMerchant(agentId: number): string {
  return `agenthire:${agentId}`;
}

/** Parse `agenthire:<id>` back to the agent id; undefined for anything else. */
export function parseAgentHireMerchant(merchant: string): number | undefined {
  const m = /^agenthire:(\d+)$/.exec(merchant);
  if (!m) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Convert a float USDC amount REPORTED by AgentHire (quote.currentPrice, ...)
 * to micro-USDC. AgentHire rounds prices to 6 decimals, so rounding is exact.
 */
export function usdcToMicro(usdc: number): bigint {
  if (!Number.isFinite(usdc) || usdc < 0) {
    throw new RangeError(`usdcToMicro: not a non-negative finite USDC amount: ${usdc}`);
  }
  return BigInt(Math.round(usdc * 1_000_000));
}

/** The micro amount of a quote's current price. Size hires from this, never from a typed number. */
export function quoteMicro(quote: AgentHireQuote): bigint {
  return usdcToMicro(quote.currentPrice);
}

/**
 * What AgentHire's Python computes for a USDC value it receives:
 * `int(float(x) * 1_000_000)` (x402.py:62, sim_engine.py:239). JS numbers are
 * the same IEEE-754 doubles, and both languages parse decimals with correct
 * rounding, so this matches AgentHire bit for bit.
 */
export function agentHireMicroOf(usdc: string | number): bigint {
  const x = typeof usdc === "number" ? usdc : Number(usdc);
  if (!Number.isFinite(x)) throw new RangeError(`agentHireMicroOf: not a number: ${usdc}`);
  return BigInt(Math.trunc(x * 1_000_000));
}

/**
 * Encode a micro-USDC amount as the decimal string AgentHire expects in
 * `amountUSDC` so that its truncating conversion yields exactly `micro`.
 * Usually that is just the plain decimal ("0.29"). When the double sits just
 * below the true value (0.000249 -> 248.99999...), a trailing `...0001` beyond
 * the 6th decimal nudges it over without changing the micro amount.
 */
export function encodeUsdcParam(micro: bigint): string {
  if (micro < 0n) throw new RangeError(`encodeUsdcParam: negative amount ${micro}`);
  const fixed = formatAmount(micro); // e.g. "0.000249"
  const plain = fixed.replace(/0+$/, "").replace(/\.$/, "");
  if (agentHireMicroOf(plain) === micro) return plain;
  for (let digits = 4; digits <= 10; digits++) {
    const nudged = fixed + "0".repeat(digits - 1) + "1";
    if (agentHireMicroOf(nudged) === micro) return nudged;
  }
  throw new RangeError(`encodeUsdcParam: ${micro} micro-USDC cannot be represented exactly for AgentHire`);
}

/* ------------------------------------------------------------------ */
/* Hire sizing: quotes, pro-rata sub-agent budgets, all-or-nothing     */
/* ------------------------------------------------------------------ */

/** One AgentHire quote a paying node may settle against. Frozen once filed. */
export interface QuoteEntry {
  readonly node: string;
  readonly agentId: number;
  /** `quoteMicro(quote)`: the exact amount a payment must carry. */
  readonly micro: bigint;
  readonly quote: Readonly<AgentHireQuote>;
  /** Unix seconds the quote was read (the book's own clock, not the caller's). */
  readonly at: number;
  /** The AgentHire instance the quote was read from (`AgentHireClient.baseUrl`). */
  readonly baseUrl: string;
}

/**
 * The AgentHire quotes each paying node sized its hires from, keyed by
 * (node, agent). Give it to `AgentHireSettlementService` (`quotes`) and a
 * payment settles only when its amount IS the quote: never a buyer-typed
 * number, never a stale quote.
 *
 * The only way to add an entry is `fetch()`, which reads GET
 * /api/pricing/quote/:id itself and stamps the entry with the book's clock and
 * the AgentHire base URL it read from. Settlement also requires that base URL
 * to be the AgentHire it pays, so every entry it accepts provably came from
 * that AgentHire; a caller cannot file a made-up or backdated quote.
 */
export class QuoteBook {
  private readonly entries_ = new Map<string, QuoteEntry>();
  private readonly now_: () => number;

  /** @param opts.now  unix-seconds clock that stamps entries (default: the wall clock). */
  constructor(opts: { now?: () => number } = {}) {
    this.now_ = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private static key(node: string, agentId: number): string {
    return `${agentId}@${node}`;
  }

  /**
   * Read agent `agentId`'s quote from AgentHire (GET /api/pricing/quote/:id)
   * and file it for `node`, replacing any older quote for the same agent.
   * Throws `AgentHireError` when AgentHire cannot be read or quotes another agent.
   */
  async fetch(client: AgentHireClient, node: string, agentId: number): Promise<QuoteEntry> {
    const quote = await client.quote(agentId);
    if (quote.agentId !== agentId) {
      throw new AgentHireError("shape", `/api/pricing/quote/${agentId}`, `quote is for agent ${quote.agentId}, not ${agentId}`);
    }
    const entry: QuoteEntry = Object.freeze({
      node,
      agentId,
      micro: quoteMicro(quote),
      quote: Object.freeze({ ...quote }),
      at: this.now_(),
      baseUrl: client.baseUrl,
    });
    this.entries_.set(QuoteBook.key(node, agentId), entry);
    return entry;
  }

  get(node: string, agentId: number): QuoteEntry | undefined {
    return this.entries_.get(QuoteBook.key(node, agentId));
  }

  /**
   * Why `node` may not pay `amount` to agent `agentId` at `now`, or null when
   * it may. With `baseUrl`, the quote must also have been read from that AgentHire.
   */
  check(node: string, agentId: number, amount: bigint, now: number, maxAgeSeconds: number, baseUrl?: string): string | null {
    const q = this.get(node, agentId);
    if (!q) {
      return `no AgentHire quote on file for "${node}" -> agent ${agentId} (hires are sized from /api/pricing/quote, never from a typed amount)`;
    }
    if (baseUrl !== undefined && q.baseUrl !== baseUrl) {
      return `the quote on file for agent ${agentId} was read from ${q.baseUrl}, not from the AgentHire being paid (${baseUrl})`;
    }
    const age = now - q.at;
    if (age > maxAgeSeconds) return `AgentHire quote for agent ${agentId} is ${age}s old (max ${maxAgeSeconds}s); re-quote before paying`;
    if (amount !== q.micro) return `amount ${amount} != AgentHire quote ${q.micro} micro-USDC for agent ${agentId}`;
    return null;
  }

  list(): QuoteEntry[] {
    return [...this.entries_.values()];
  }
}

export interface HirePlanSub {
  /** Caller's key (e.g. the alias label `a6-via-a5`). */
  key: string;
  /** Pro-rata weight, normally the sub-agent's own quote in micro-USDC. */
  weight: bigint;
}

export interface HirePlan {
  /** The buyer's cap for the whole hire. */
  cap: bigint;
  /** The main agent's quote: paid in full, first claim on the cap. */
  main: bigint;
  /** cap - main: what the sub-agents split. */
  pool: bigint;
  /** Budgets in input order; they sum to exactly `pool`. */
  subs: Array<HirePlanSub & { budget: bigint }>;
}

/**
 * Size one hire. The main agent gets exactly its quote; the sub-agents split
 * what is left of the cap (cap - main) pro rata to their weights. Budgets are
 * whole micro-USDC and sum to exactly `pool` (largest-remainder rounding, ties
 * to the earlier sub), so delegating them all can never run out partway.
 * Throws RangeError, before anything is written, when the cap does not cover
 * the main quote. All-zero weights split the pool equally.
 */
export function planHire(input: { cap: bigint; main: bigint; subs: readonly HirePlanSub[] }): HirePlan {
  const { cap, main } = input;
  if (main < 0n || cap < 0n) throw new RangeError(`planHire: negative cap ${cap} or main ${main}`);
  if (cap < main) throw new RangeError(`planHire: cap ${cap} does not cover the main quote ${main}`);
  const seen = new Set<string>();
  for (const s of input.subs) {
    if (s.weight < 0n) throw new RangeError(`planHire: negative weight for "${s.key}"`);
    if (seen.has(s.key)) throw new RangeError(`planHire: duplicate sub key "${s.key}"`);
    seen.add(s.key);
  }
  const pool = cap - main;
  const n = input.subs.length;
  if (n === 0) return { cap, main, pool, subs: [] };
  let weights = input.subs.map((s) => s.weight);
  let total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) {
    weights = weights.map(() => 1n);
    total = BigInt(n);
  }
  const base = weights.map((w) => (pool * w) / total);
  const rem = weights.map((w) => (pool * w) % total);
  let leftover = pool - base.reduce((a, b) => a + b, 0n); // < n
  const order = [...base.keys()].sort((i, j) => (rem[j]! > rem[i]! ? 1 : rem[j]! < rem[i]! ? -1 : i - j));
  for (const i of order) {
    if (leftover === 0n) break;
    base[i] = base[i]! + 1n;
    leftover -= 1n;
  }
  return { cap, main, pool, subs: input.subs.map((s, i) => ({ ...s, budget: base[i]! })) };
}

/** One node for `delegateAll`, optionally with its own children (a whole subtree). */
export interface ChildGrant {
  label: string;
  mandate: MandateInput;
  opts?: DelegateOptions;
  /** Grandchildren, delegated from this node once it exists. */
  children?: readonly ChildGrant[];
}

/**
 * Delegate a set of children of `parentName`, each with an optional subtree of
 * its own, ALL OR NOTHING. Every node is checked first: its name must be new
 * and unique, and it must pass attenuation against what its parent will have
 * left after the siblings before it. A child's own children are checked against
 * the child as it will be created. Only when every node passes is anything
 * written.
 *
 * A failing node records the same DELEGATE / ATTENUATION_REJECTED event that
 * `tree.delegate` would, then throws. No node is created. The function is
 * synchronous, so no payment can interleave; when payments are live, run it
 * inside `SerializedPayer.run`. It returns the created nodes in pre-order.
 */
export function delegateAll(tree: DelegationTree, parentName: string, children: readonly ChildGrant[]): AgentNode[] {
  const parent = tree.requireNode(parentName);
  checkGrants(tree, parent, tree.available(parentName), children, new Set());
  const created: AgentNode[] = [];
  const grant = (from: string, grants: readonly ChildGrant[]): void => {
    for (const c of grants) {
      const node = tree.delegate(from, c.label, c.mandate, c.opts);
      created.push(node);
      if (c.children?.length) grant(node.name, c.children);
    }
  };
  grant(parentName, children);
  return created;
}

function checkGrants(
  tree: DelegationTree,
  parent: AgentNode,
  available: bigint,
  grants: readonly ChildGrant[],
  names: Set<string>,
): void {
  let left = available;
  for (const c of grants) {
    const name = childName(parent.name, c.label);
    if (tree.getNode(name) || names.has(name)) throw new DuplicateNodeError(name);
    names.add(name);
    const decision = checkAttenuation(parent, c.mandate, left);
    if (!decision.ok) {
      tree.recordEvent({
        type: "DELEGATE",
        node: name,
        detail: `attenuation rejected (${decision.reason}): ${decision.message} (delegateAll: nothing was created)`,
        result: "ATTENUATION_REJECTED",
        amount: c.mandate.budget,
        merchant: null,
      });
      throw new AttenuationError(decision.reason, decision.message);
    }
    left -= c.mandate.budget;
    if (c.children?.length) {
      // The child as it will exist: nothing spent, nothing delegated yet.
      const planned: AgentNode = {
        name,
        parent: parent.name,
        identityStatus: c.opts?.identityStatus ?? "verified",
        mandate: {
          budget: c.mandate.budget,
          spentDirect: 0n,
          allowedMerchants: c.mandate.allowedMerchants,
          allowedPurposes: c.mandate.allowedPurposes,
          expiry: c.mandate.expiry,
          revoked: false,
        },
      };
      checkGrants(tree, planned, c.mandate.budget, c.children, names);
    }
  }
}

/**
 * The alias label of a sub-agent hire: one node per (hirer, sub-agent) edge,
 * never a node shared between parents (AgentHire's A2A graph has cycles and
 * shared children). Same convention as the shadow audit.
 */
export function aliasNodeLabel(hirerId: number, subAgentId: number): string {
  return `a${subAgentId}-via-a${hirerId}`;
}

/** Parse `a<sub>-via-a<hirer>` (a label or a full node name); undefined otherwise. */
export function parseAliasLabel(nameOrLabel: string): { subAgentId: number; hirerId: number } | undefined {
  const m = /^a(\d+)-via-a(\d+)$/.exec(leftLabel(nameOrLabel));
  if (!m) return undefined;
  return { subAgentId: Number(m[1]), hirerId: Number(m[2]) };
}

/**
 * `payerAgentIdOf` for trees that use alias nodes: an alias node pays AS its
 * hirer (an AgentHire agent), so its payments are A2A hires.
 */
export function aliasPayerAgentId(node: string): number | undefined {
  return parseAliasLabel(node)?.hirerId;
}

/* ------------------------------------------------------------------ */
/* Wire types (as served by AgentHire @ ab317f2)                      */
/* ------------------------------------------------------------------ */

/** GET /api/agents/:id (app.py:4169-4187). Extra fields are passed through. */
export interface AgentHireAgent {
  id: number;
  name: string;
  category: string;
  use_case: string;
  billing: string;
  min_price: number;
  max_price: number;
  current_price: number;
  seller: string;
  verified: boolean;
  /** The operator's wallet. Present for every seeded agent. */
  deployer_wallet?: string | null;
  [key: string]: unknown;
}

/** GET /api/agents */
export interface AgentHireAgentList {
  agents: AgentHireAgent[];
  total: number;
  page: number;
  per_page: number;
}

/** GET /api/pricing/quote/:id (app.py:2541-2567, simulation.py:122-140). */
export interface AgentHireQuote {
  agentId: number;
  minPrice: number;
  maxPrice: number;
  /** Surge-adjusted price in float USDC (rounded to 6 decimals). */
  currentPrice: number;
  surgeMultiplier: number;
  surgeActive: boolean;
  utilization: number;
  demand: number;
}

/** GET /api/onchain/info */
export interface AgentHireOnchainInfo {
  chainId: number;
  chainIdHex?: string;
  chain?: string;
  rpcUrl?: string;
  explorer?: string;
  contracts: { MockUSDC: string; EscrowPayment: string; [name: string]: string };
}

/** GET /api/agents/:id/reputation (simulation.py:421-443). `simulated:true` = DB mirror, not chain. */
export interface AgentHireReputation {
  score: number;
  tier: number;
  tasksCompleted: number;
  incidentCount: number;
  lastDecayTs?: number;
  projectedScore?: number;
  simulated?: boolean;
}

/** GET /api/agents/:id/stake (simulation.py:446-457). `stakedUSDC` is micro-USDC as a string. */
export interface AgentHireStake {
  stakedUSDC: string;
  stakedUSDCDisplay?: number;
  incidentCount: number;
  banned: boolean;
  unstakeRequest?: { amount: string; availableAt: number };
  simulated?: boolean;
}

/** The 402 challenge body from the x402-gated route (x402.py:56-103). */
export interface X402Challenge {
  scheme: string;
  version: string;
  resourceId: string;
  chain: { chainId: number; name?: string };
  token: { address: string; symbol?: string; decimals?: number };
  price: { amountUSDC: number; amountMicro: number | string; perCall?: boolean };
  recipient: string;
  permit: {
    type?: string;
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    template: {
      from?: string;
      to: string;
      value: string | number;
      validAfter?: number;
      validBefore: number;
      nonce?: string;
    };
  };
  notes?: string;
}

/** A signed EIP-3009 permit in AgentHire's flat JSON format (x402.py:306-319). */
export interface X402Permit {
  from: string;
  to: string;
  /** micro-USDC as a decimal string. */
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  v: number;
  r: string;
  s: string;
  agentId: number;
  tokenBudget: string;
  categoryId: number;
}

/** POST /api/x402/pay. Keyless mode: `{sessionId, agentId, status:"mock", realTx:false, note}`. */
export interface X402PayResult {
  sessionId: string | number | null;
  agentId?: number;
  status?: string;
  realTx?: boolean;
  note?: string;
  [key: string]: unknown;
}

/** The x402-gated route answered 200 to an X-Payment retry. */
export interface X402ExecuteResult {
  status: number;
  body: Record<string, unknown>;
  /** Parsed X-Payment-Receipt header, when present. */
  receipt: { sessionId?: unknown; txHashes?: Record<string, string> | null; snowtrace?: unknown } | null;
}

/** One entry of GET /api/sim/events (sim_engine.py:61-81). `amountUSDC` is rounded to 4 decimals. */
export interface AgentHireSimEvent {
  id: number;
  ts: number;
  realTs?: number;
  kind: string;
  agentId: number | null;
  message: string;
  amountUSDC: number;
  meta: Record<string, unknown>;
}

export interface AgentHireSimEventsPage {
  events: AgentHireSimEvent[];
  status: Record<string, unknown>;
}

/** GET /api/sim/status (sim_engine.py `status()`). */
export interface AgentHireSimStatus {
  running: boolean;
  tickRealSeconds?: number;
  tickCount?: number;
  [key: string]: unknown;
}

/** GET /api/sim/a2a-candidates: flagships (agents that hire sub-agents) and their sub-agent cost bands. */
export interface AgentHireA2ACandidates {
  flagships: Array<{
    id: number;
    name?: string;
    subAgents: Array<{ id: number; name?: string; estCostLow?: number | null; estCostHigh?: number | null; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
}

export interface TriggerDirectInput {
  fromId: number;
  toId: number;
  amountMicro: bigint;
  /** Lands in the a2a_hire event's `meta.trigger`. */
  reason?: string;
  tokens?: number;
  buyerWallet?: string;
}

/** POST /api/sim/trigger-direct (app.py:3224-3329). */
export interface TriggerDirectResult {
  triggered?: boolean;
  ok?: boolean;
  fromId: number;
  toId: number;
  amountUSDC: number;
  newEvents: AgentHireSimEvent[];
  count?: number;
  orderId?: string | null;
  realTxHash?: string | null;
  [key: string]: unknown;
}

export interface DisputeInput {
  agentId: number;
  /** AgentHire accepts 1 or 2. */
  severity: 1 | 2;
  reason: string;
  /** The buyer the incident affected (0x address). */
  affectedUser: string;
}

/**
 * POST /api/dispute/submit (app.py:2046-2079). Keyless mode only logs the
 * dispute server-side and answers `{status:"pending_review", note}`; it does
 * NOT change any incident counter and does NOT slash.
 */
export interface DisputeResult {
  status?: string;
  note?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                        */
/* ------------------------------------------------------------------ */

/** The slice of `fetch` the client uses. The global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type AgentHireErrorKind = "network" | "http" | "non_json" | "shape";

/** Any failure talking to AgentHire. Settlement and screening turn these into refusals. */
export class AgentHireError extends Error {
  readonly kind: AgentHireErrorKind;
  readonly status: number | null;
  readonly path: string;
  readonly bodySnippet?: string;

  constructor(kind: AgentHireErrorKind, path: string, message: string, status: number | null = null, body?: string) {
    super(`AgentHire ${path}: ${message}`);
    this.name = "AgentHireError";
    this.kind = kind;
    this.path = path;
    this.status = status;
    this.bodySnippet = body === undefined ? undefined : body.slice(0, 200);
  }
}

interface JsonResponse<T> {
  status: number;
  headers: { get(name: string): string | null };
  json: T;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Typed client for AgentHire's HTTP API. Every method either returns the typed
 * body or throws `AgentHireError`; a non-JSON body (Flask-Limiter answers 429
 * with an HTML page) is an error, never a value.
 *
 * AgentHire's money routes are unauthenticated: only point this at an instance
 * bound to 127.0.0.1.
 */
export class AgentHireClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly payTimeoutMs: number;

  /**
   * @param baseUrl    e.g. `http://127.0.0.1:5055`
   * @param fetchImpl  defaults to the global `fetch`
   * @param opts.timeoutMs  per-request deadline for reads (default 15s), so a
   *   hung AgentHire cannot hold a root's payment queue forever.
   * @param opts.payTimeoutMs  deadline for the requests that move money
   *   (/api/x402/pay, the X-Payment retry, /api/sim/trigger-direct). Default
   *   150s: longer than AgentHire's 30s facilitator call (app.py:2009), its
   *   120s wait for the transfer's receipt (onchain.py:443) and gunicorn's 120s
   *   worker timeout, so a slow confirmation is not cut short. A payment request
   *   that times out anyway is charged as UNCONFIRMED, never treated as refused.
   */
  constructor(baseUrl: string, fetchImpl?: FetchLike, opts: { timeoutMs?: number; payTimeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const f = fetchImpl ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
    if (!f) throw new Error("AgentHireClient: no fetch implementation available");
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.payTimeoutMs = opts.payTimeoutMs ?? 150_000;
  }

  /* ---- catalog / pricing ---- */

  async getAgent(id: number): Promise<AgentHireAgent> {
    const path = `/api/agents/${agentPathId(id)}`;
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { id: "number", name: "string" });
    return json as unknown as AgentHireAgent;
  }

  async listAgents(params: { category?: string; use_case?: string; q?: string; page?: number; per_page?: number } = {}): Promise<AgentHireAgentList> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const query = qs.toString();
    const path = `/api/agents${query ? `?${query}` : ""}`;
    const { json } = await this.request<JsonObject>("GET", path);
    if (!Array.isArray(json.agents)) throw new AgentHireError("shape", path, "missing agents[]");
    return json as unknown as AgentHireAgentList;
  }

  /** The surge-adjusted quote. Allowance sizes hires from this, never from a buyer-typed number. */
  async quote(id: number): Promise<AgentHireQuote> {
    const path = `/api/pricing/quote/${agentPathId(id)}`;
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { agentId: "number", currentPrice: "number", minPrice: "number", maxPrice: "number" });
    return json as unknown as AgentHireQuote;
  }

  async onchainInfo(): Promise<AgentHireOnchainInfo> {
    const path = "/api/onchain/info";
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { chainId: "number" });
    if (!isObject(json.contracts)) throw new AgentHireError("shape", path, "missing contracts");
    requireFields(path, json.contracts, { MockUSDC: "string", EscrowPayment: "string" });
    return json as unknown as AgentHireOnchainInfo;
  }

  /* ---- reputation / stake ---- */

  async reputation(id: number): Promise<AgentHireReputation> {
    const path = `/api/agents/${agentPathId(id)}/reputation`;
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { score: "number", tier: "number", incidentCount: "number" });
    return json as unknown as AgentHireReputation;
  }

  async stake(id: number): Promise<AgentHireStake> {
    const path = `/api/agents/${agentPathId(id)}/stake`;
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { banned: "boolean", incidentCount: "number" });
    return json as unknown as AgentHireStake;
  }

  /* ---- x402 ---- */

  /**
   * Fetch the HTTP 402 challenge from AgentHire's x402-gated route
   * `GET /api/x402/demo-execute/:agentId?amountUSDC=` (app.py:3884-3963) for a
   * micro-USDC amount. Anything but a 402 with a challenge body is an error.
   */
  async x402Challenge(agentId: number, amountMicro: bigint): Promise<X402Challenge> {
    const path = this.x402RoutePath(agentId, amountMicro);
    const { json } = await this.request<JsonObject>("GET", path, { expect: [402] });
    const ch = json.challenge;
    if (!isObject(ch)) throw new AgentHireError("shape", path, "402 without a challenge body");
    requireFields(path, ch, { scheme: "string", recipient: "string" });
    for (const key of ["chain", "token", "price", "permit"] as const) {
      if (!isObject(ch[key])) throw new AgentHireError("shape", path, `challenge.${key} missing`);
    }
    const permit = ch.permit as JsonObject;
    if (!isObject(permit.domain) || !isObject(permit.template)) {
      throw new AgentHireError("shape", path, "challenge.permit.domain/template missing");
    }
    return ch as unknown as X402Challenge;
  }

  /**
   * FUJI PATH: retry the x402-gated route with the signed permit in
   * `X-Payment`. AgentHire then calls MockUSDC.transferWithAuthorization via
   * its facilitator; that needs keys on its side plus a reachable Fuji RPC.
   * A 402 here means AgentHire refused or failed the payment.
   */
  async x402Execute(agentId: number, amountMicro: bigint, permit: X402Permit): Promise<X402ExecuteResult> {
    const path = this.x402RoutePath(agentId, amountMicro);
    const res = await this.request<JsonObject>("GET", path, {
      headers: { "X-Payment": JSON.stringify(permit) },
      timeoutMs: this.payTimeoutMs,
    });
    const raw = res.headers.get("X-Payment-Receipt");
    let receipt: X402ExecuteResult["receipt"] = null;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        receipt = isObject(parsed) ? (parsed as X402ExecuteResult["receipt"]) : null;
      } catch {
        throw new AgentHireError("shape", path, "unparseable X-Payment-Receipt header", res.status, raw);
      }
    }
    return { status: res.status, body: res.json, receipt };
  }

  /** POST /api/x402/pay with a signed permit. Keyless AgentHire answers `status:"mock"`. */
  async x402Pay(permit: X402Permit): Promise<X402PayResult> {
    const path = "/api/x402/pay";
    const { json } = await this.request<JsonObject>("POST", path, { body: permit, timeoutMs: this.payTimeoutMs });
    if (!("sessionId" in json)) throw new AgentHireError("shape", path, "no sessionId in response");
    return json as unknown as X402PayResult;
  }

  /* ---- simulation (A2A) ---- */

  /** POST /api/sim/trigger-direct: a direct, SIMULATED agent-to-agent payment. */
  async triggerDirect(input: TriggerDirectInput): Promise<TriggerDirectResult> {
    const path = "/api/sim/trigger-direct";
    const body: JsonObject = {
      fromId: input.fromId,
      toId: input.toId,
      amountUSDC: encodeUsdcParam(input.amountMicro),
    };
    if (input.reason !== undefined) body.reason = input.reason;
    if (input.tokens !== undefined) body.tokens = input.tokens;
    if (input.buyerWallet !== undefined) body.buyerWallet = input.buyerWallet;
    const { json } = await this.request<JsonObject>("POST", path, { body, timeoutMs: this.payTimeoutMs });
    if (!Array.isArray(json.newEvents)) throw new AgentHireError("shape", path, "missing newEvents[]");
    return json as unknown as TriggerDirectResult;
  }

  /** GET /api/sim/events?since= — the simulator's event ring (a2a_hire, settle, slash, ...). */
  async simEvents(sinceId = 0, limit?: number): Promise<AgentHireSimEventsPage> {
    const path = `/api/sim/events?since=${Math.max(0, Math.floor(sinceId))}${limit === undefined ? "" : `&limit=${Math.floor(limit)}`}`;
    const { json } = await this.request<JsonObject>("GET", path);
    if (!Array.isArray(json.events)) throw new AgentHireError("shape", path, "missing events[]");
    return json as unknown as AgentHireSimEventsPage;
  }

  /** GET /api/sim/status — is the simulator running, and how fast. */
  async simStatus(): Promise<AgentHireSimStatus> {
    const path = "/api/sim/status";
    const { json } = await this.request<JsonObject>("GET", path);
    requireFields(path, json, { running: "boolean" });
    return json as unknown as AgentHireSimStatus;
  }

  /** POST /api/sim/start — start AgentHire's simulator (a no-op when it already runs). */
  async simStart(): Promise<AgentHireSimStatus> {
    const path = "/api/sim/start";
    const { json } = await this.request<JsonObject>("POST", path, { body: {} });
    return json as unknown as AgentHireSimStatus;
  }

  /** POST /api/sim/speed — AgentHire's own sim tick, in real seconds. */
  async setSimSpeed(tickRealSeconds: number): Promise<AgentHireSimStatus> {
    if (!Number.isFinite(tickRealSeconds) || tickRealSeconds <= 0) {
      throw new RangeError(`setSimSpeed: tick must be a positive number of seconds, got ${tickRealSeconds}`);
    }
    const path = "/api/sim/speed";
    const { json } = await this.request<JsonObject>("POST", path, { body: { tickRealSeconds } });
    return json as unknown as AgentHireSimStatus;
  }

  /** GET /api/sim/a2a-candidates — the composable flagships and their published sub-agent cost bands. */
  async a2aCandidates(): Promise<AgentHireA2ACandidates> {
    const path = "/api/sim/a2a-candidates";
    const { json } = await this.request<JsonObject>("GET", path);
    if (!Array.isArray(json.flagships)) throw new AgentHireError("shape", path, "missing flagships[]");
    return json as unknown as AgentHireA2ACandidates;
  }

  /* ---- incidents ---- */

  /**
   * POST /api/dispute/submit — AgentHire's buyer dispute route, the only
   * keyless route a buyer can use to tell AgentHire about an agent. Keyless it
   * only prints the dispute to AgentHire's server log and answers
   * `pending_review` (app.py:2073-2079): no ModerationReport row is created, no
   * incident counter moves and no stake is slashed. (With a gatekeeper key it
   * would sign an on-chain incident instead.) This client deliberately has no
   * wrapper for /api/sim/slash-agent: slashing is for misconduct, not for an
   * agent that was stopped by its own mandate.
   */
  async submitDispute(input: DisputeInput): Promise<DisputeResult> {
    const path = "/api/dispute/submit";
    const { json } = await this.request<JsonObject>("POST", path, { body: { ...input } });
    return json as DisputeResult;
  }

  /* ---- plumbing ---- */

  private x402RoutePath(agentId: number, amountMicro: bigint): string {
    return `/api/x402/demo-execute/${agentPathId(agentId)}?amountUSDC=${encodeURIComponent(encodeUsdcParam(amountMicro))}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; expect?: number[]; timeoutMs?: number } = {},
  ): Promise<JsonResponse<T>> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    const controller = new AbortController();
    const init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal } = {
      method,
      headers,
      signal: controller.signal,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    let res: Awaited<ReturnType<FetchLike>>;
    let text: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const exchange = (async () => {
        const r = await this.fetchImpl(this.baseUrl + path, init);
        return { r, body: await r.text() };
      })();
      ({ r: res, body: text } = await Promise.race([exchange, deadline]));
    } catch (err) {
      throw new AgentHireError("network", path, errorMessage(err));
    } finally {
      clearTimeout(timer);
    }
    const contentType = res.headers.get("content-type") ?? "";
    let json: unknown;
    let parsed = false;
    if (/\bjson\b/i.test(contentType)) {
      try {
        json = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed) {
      throw new AgentHireError(
        "non_json",
        path,
        `HTTP ${res.status} with a non-JSON body (${contentType || "no content-type"})`,
        res.status,
        text,
      );
    }
    const ok = opts.expect ? opts.expect.includes(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) {
      const detail = isObject(json)
        ? [json.error, json.detail].filter((x) => typeof x === "string" && x).join(": ")
        : "";
      throw new AgentHireError("http", path, `HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, text);
    }
    if (!isObject(json)) throw new AgentHireError("shape", path, "expected a JSON object", res.status, text);
    return { status: res.status, headers: res.headers, json: json as T };
  }
}

function agentPathId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError(`not an AgentHire agent id: ${id}`);
  return String(id);
}

function requireFields(path: string, obj: JsonObject, fields: Record<string, "number" | "string" | "boolean">): void {
  for (const [key, type] of Object.entries(fields)) {
    if (typeof obj[key] !== type) {
      throw new AgentHireError("shape", path, `field ${key} should be a ${type}, got ${JSON.stringify(obj[key])}`);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b);
}

function toBigIntOrNull(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/* ------------------------------------------------------------------ */
/* Settlement                                                         */
/* ------------------------------------------------------------------ */

/** `mock` pays via POST /api/x402/pay; `fuji` sends X-Payment on the x402-gated route. */
export type AgentHireSettleMode = "mock" | "fuji";

/** Read `AGENTHIRE_SETTLE` (`mock` by default, `fuji` to use the real payment route). */
export function settleModeFromEnv(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): AgentHireSettleMode {
  const raw = (env.AGENTHIRE_SETTLE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "mock") return "mock";
  if (raw === "fuji") return "fuji";
  throw new Error(`AGENTHIRE_SETTLE must be "mock" or "fuji", got "${env.AGENTHIRE_SETTLE}"`);
}

/** Signs EIP-712 typed data. An ethers `Wallet` (or `HDNodeWallet`) satisfies this. */
export interface TypedDataSigner {
  readonly address: string;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * A fresh random wallet that lives only in memory, for signing demo permits.
 * It holds no funds and its key is never written anywhere.
 */
export function createThrowawaySigner(): TypedDataSigner {
  return Wallet.createRandom();
}

/**
 * The payer's signer. `AGENTHIRE_PAYER_KEY` (a 0x private key, read from the
 * environment only, never logged or written) opts in to a real payer; without
 * it this is a throwaway wallet. On the Fuji path the payer must hold Mock USDC:
 * AgentHire's facilitator calls `transferWithAuthorization`, which moves the
 * permit's `value` out of `permit.from` (onchain.py:431-441), so a throwaway
 * signer can never settle there.
 */
export function payerSignerFromEnv(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): { signer: TypedDataSigner; source: "AGENTHIRE_PAYER_KEY" | "throwaway" } {
  const key = (env.AGENTHIRE_PAYER_KEY ?? "").trim();
  if (!key) return { signer: createThrowawaySigner(), source: "throwaway" };
  try {
    return { signer: new Wallet(key), source: "AGENTHIRE_PAYER_KEY" };
  } catch {
    // Never echo the value: it is meant to be a secret.
    throw new Error("AGENTHIRE_PAYER_KEY is set but is not a valid private key");
  }
}

export interface AgentHireSettlementConfig {
  client: AgentHireClient;
  /** Throwaway signer for the permits. Never a wallet holding real funds. */
  signer: TypedDataSigner;
  /**
   * Expiry (unix seconds) of the paying node's mandate. The signed permit may
   * not outlive it: the challenge's `validBefore` must be <= this. Use
   * `agentHireTreeHooks(tree)`.
   */
  mandateExpiry: (node: string) => number | undefined;
  /** Merchant -> AgentHire agent id. Default: `parseAgentHireMerchant` (`agenthire:<id>`). */
  agentIdOf?: (merchant: string) => number | undefined;
  /**
   * When the PAYING node is itself an AgentHire agent (a sub-agent hire), its
   * agent id. Such payments settle through /api/sim/trigger-direct with reason
   * `allowance:<node>#<seq>`. Return undefined for ordinary buyer nodes.
   */
  payerAgentIdOf?: (node: string) => number | undefined;
  /**
   * Sequence tag for A2A reasons. `() => tree.nextSeq` makes it the PAYMENT
   * event's seq, as long as nothing else writes to the tree while the payment
   * is in flight (run payments through `SerializedPayer`). Default: a local counter.
   */
  nextSeq?: () => number;
  /** Default: `settleModeFromEnv()`. */
  mode?: AgentHireSettleMode;
  /** Expected chain id. Default 43113 (Fuji). */
  chainId?: number;
  /** Unix seconds. Default `Date.now()/1000`. */
  now?: () => number;
  /** 32-byte hex nonce for EIP-3009. Default: crypto-random. */
  nonce?: () => string;
  /**
   * AgentHire's x402 route lets the caller name the price (`?amountUSDC=`) and
   * echoes it back, so the challenge alone binds nothing. Settlement therefore
   * ALWAYS requires the amount to equal, to the micro-USDC, AgentHire's own
   * GET /api/pricing/quote for the agent being paid:
   *   - with `quotes` (see `QuoteBook`): the quote the hire was sized from,
   *     read by the book from this same AgentHire and at most
   *     `quoteMaxAgeSeconds` old. With no quote on file the payment is refused;
   *   - without `quotes`: the live quote, read by settlement itself just
   *     before it signs. Surge pricing moves it, so size from the same quote.
   */
  quotes?: QuoteBook;
  /** Oldest quote (seconds) a payment may still be sized from. Default 900. */
  quoteMaxAgeSeconds?: number;
}

/** One settlement attempt, JSON-ready (amounts are micro-USDC strings). */
export interface AgentHireReceipt {
  at: number;
  node: string;
  merchant: string;
  agentId: number | null;
  amountMicro: string;
  /** The AgentHire quote the amount was checked against. */
  quoteMicro?: string;
  /** Where that quote came from: the `QuoteBook` entry, or a live read at settle time. */
  quoteSource?: "quote-book" | "live";
  route: "x402-pay" | "x402-execute" | "trigger-direct" | "none";
  mode: AgentHireSettleMode | "a2a";
  /** True when the mandate was charged (confirmed OR unconfirmed). */
  settled: boolean;
  /**
   * True when the payment request had been sent but AgentHire's answer did not
   * confirm it (timeout, 5xx, refusal after a signed permit was handed over,
   * unexpected shape). The mandate WAS charged; reconcile before releasing it.
   */
  unconfirmed?: boolean;
  reason?: string;
  reference?: string;
  sessionId?: string | number | null;
  /** The signed permit, when one was signed (throwaway key, no secrets). */
  permit?: X402Permit;
  challenge?: { resourceId: string; amountMicro: string; recipient: string; token: string; chainId: number; validBefore: number };
  a2a?: { fromId: number; toId: number; reason: string; eventIds: number[] };
  /** AgentHire said `realTx:true`. Not independently verified from here. */
  realTx: boolean;
  /** True when nothing moved on chain (mock or simulation route). */
  simulated: boolean;
  note?: string;
}

/** `mandateExpiry` and `nextSeq` wired to a delegation tree. */
export function agentHireTreeHooks(tree: DelegationTree): {
  mandateExpiry: (node: string) => number | undefined;
  nextSeq: () => number;
} {
  return {
    // Attenuation keeps a child's expiry <= its parent's, so the node's own
    // expiry is the binding one for the whole chain.
    mandateExpiry: (node) => tree.getNode(node)?.mandate.expiry,
    nextSeq: () => tree.nextSeq,
  };
}

/**
 * AgentHire as a core `SettlementService`.
 *
 * For every payment to `agenthire:<id>`:
 *   0. the amount must equal AgentHire's own quote for agent <id>, to the
 *      micro-USDC (the `QuoteBook` entry the hire was sized from, or a live
 *      GET /api/pricing/quote read now). This is what binds the amount:
 *      AgentHire's x402 route prices whatever `?amountUSDC=` it is asked for.
 * Then, for a buyer node:
 *   1. read /api/onchain/info (cached) for MockUSDC + EscrowPayment,
 *   2. fetch the 402 challenge for exactly `req.amount`,
 *   3. refuse unless: chainId 43113 (challenge, domain, info), token and domain
 *      verifyingContract = MockUSDC, recipient and template.to = EscrowPayment,
 *      EIP-712 domain "Mock USDC" v1, validBefore in the future and <= the
 *      mandate's expiry, and amountMicro = template.value = req.amount (an echo
 *      of what was asked: it only proves AgentHire decoded the amount exactly),
 *   4. sign EIP-3009 TransferWithAuthorization with the injected signer,
 *   5. `mock`: POST /api/x402/pay; `fuji`: send the permit as X-Payment on the
 *      x402-gated route.
 * For a node that is itself an AgentHire agent (`payerAgentIdOf`), it fires
 * /api/sim/trigger-direct with reason `allowance:<node>#<seq>` and checks the
 * echoed amount and parties.
 *
 * Refused vs UNCONFIRMED: everything up to step 4 is a refusal
 * (`settled:false`, nothing charged, nothing was sent). Once the signed permit
 * (step 5) or the trigger-direct request has been sent, a timeout, a 5xx, a
 * refusal of the permit or an answer that does not match is UNCONFIRMED:
 * AgentHire may already have booked it (on Fuji it may already have run
 * `transferWithAuthorization`), and the permit stays redeemable until
 * `validBefore`. Such a payment returns `settled:true`, so core `pay()` charges
 * the mandate and the node cannot pay the same authority twice; its receipt
 * says `unconfirmed: true` and its reference starts `agenthire-unconfirmed:`.
 * The one post-send refusal is a 4xx from trigger-direct, which AgentHire
 * answers before it books anything (app.py:3230-3264, sim_engine.py:231-241).
 *
 * `settle()` NEVER throws: every refusal is `settled:false` with a reason that
 * starts with `settlement:`. Every attempt is appended to `receipts`.
 */
export class AgentHireSettlementService implements SettlementService {
  readonly mode: AgentHireSettleMode;
  readonly chainId: number;
  /** Every attempt, in order. Write these to the demo's receipts sidecar. */
  readonly receipts: AgentHireReceipt[] = [];

  private readonly client: AgentHireClient;
  private readonly signer: TypedDataSigner;
  private readonly mandateExpiry: (node: string) => number | undefined;
  private readonly agentIdOf: (merchant: string) => number | undefined;
  private readonly payerAgentIdOf?: (node: string) => number | undefined;
  private readonly nextSeq: () => number;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly quotes?: QuoteBook;
  private readonly quoteMaxAge: number;
  private info_: Promise<AgentHireOnchainInfo> | null = null;
  private localSeq_ = 0;
  /** Receipts whose payment request has left this process (see "Refused vs UNCONFIRMED"). */
  private readonly sent_ = new WeakSet<AgentHireReceipt>();

  constructor(config: AgentHireSettlementConfig) {
    this.quotes = config.quotes;
    this.quoteMaxAge = config.quoteMaxAgeSeconds ?? 900;
    this.client = config.client;
    this.signer = config.signer;
    this.mandateExpiry = config.mandateExpiry;
    this.agentIdOf = config.agentIdOf ?? parseAgentHireMerchant;
    this.payerAgentIdOf = config.payerAgentIdOf;
    this.nextSeq = config.nextSeq ?? (() => this.localSeq_++);
    this.mode = config.mode ?? settleModeFromEnv();
    this.chainId = config.chainId ?? AGENTHIRE_CHAIN_ID;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.nonce = config.nonce ?? (() => hexlify(randomBytes(32)));
  }

  async settle(req: SettlementRequest): Promise<SettlementResult> {
    const receipt: AgentHireReceipt = {
      at: 0,
      node: req.node,
      merchant: req.merchant,
      agentId: null,
      amountMicro: req.amount.toString(),
      route: "none",
      mode: this.mode,
      settled: false,
      realTx: false,
      simulated: true,
    };
    let result: SettlementResult;
    try {
      receipt.at = this.now();
      result = await this.settleInner(req, receipt);
    } catch (err) {
      result = this.sent_.has(receipt)
        ? this.unconfirmed(req, receipt, `unexpected error after the payment was sent: ${errorMessage(err)}`)
        : this.refuse(req, `unexpected error: ${errorMessage(err)}`);
    }
    receipt.settled = result.settled;
    if (result.reason !== undefined) receipt.reason = result.reason;
    if (result.reference !== undefined) receipt.reference = result.reference;
    this.receipts.push(receipt);
    return result;
  }

  /** Receipts charged to a mandate without AgentHire confirming them: reconcile these. */
  get unconfirmedReceipts(): AgentHireReceipt[] {
    return this.receipts.filter((r) => r.unconfirmed === true);
  }

  private refuse(req: SettlementRequest, why: string): SettlementResult {
    return {
      settled: false,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: 0n,
      amountOut: 0n,
      reason: `settlement: ${why}`,
    };
  }

  /**
   * The payment request has been sent, but AgentHire did not confirm it.
   * Charged to the mandate (`settled:true`, so pay() books it), with
   * `amountOut` 0n because delivery is unknown; the receipt is marked for
   * reconciliation.
   */
  private unconfirmed(req: SettlementRequest, receipt: AgentHireReceipt, why: string): SettlementResult {
    receipt.unconfirmed = true;
    receipt.note =
      `UNCONFIRMED: ${why}. The payment had already been sent to AgentHire` +
      (receipt.permit ? " (a signed permit, redeemable until validBefore)" : "") +
      ", so it is charged to the mandate; reconcile against AgentHire before releasing that authority.";
    const tag = receipt.permit ? receipt.permit.nonce.slice(0, 18) : (receipt.a2a?.reason ?? String(receipt.at));
    return {
      settled: true,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut: 0n,
      reference: `agenthire-unconfirmed:${receipt.route}:${tag}`,
      reason: `settlement: UNCONFIRMED (charged to the mandate, reconcile): ${why}`,
    };
  }

  /**
   * Why `req.amount` is not AgentHire's quote for `agentId`, or null when it is.
   * With a `QuoteBook`: the entry the hire was sized from (read from this
   * AgentHire, fresh). Without one: a live GET /api/pricing/quote, read now.
   */
  private async quoteProblem(req: SettlementRequest, agentId: number, now: number, receipt: AgentHireReceipt): Promise<string | null> {
    if (this.quotes) {
      const problem = this.quotes.check(req.node, agentId, req.amount, now, this.quoteMaxAge, this.client.baseUrl);
      if (problem) return problem;
      receipt.quoteMicro = this.quotes.get(req.node, agentId)!.micro.toString();
      receipt.quoteSource = "quote-book";
      return null;
    }
    let live: AgentHireQuote;
    try {
      live = await this.client.quote(agentId);
    } catch (err) {
      return `could not read AgentHire's quote for agent ${agentId}: ${errorMessage(err)}`;
    }
    if (live.agentId !== agentId) return `AgentHire quoted agent ${live.agentId}, not ${agentId}`;
    const micro = quoteMicro(live);
    receipt.quoteMicro = micro.toString();
    receipt.quoteSource = "live";
    if (req.amount !== micro) {
      return (
        `amount ${req.amount} != AgentHire's live quote ${micro} micro-USDC for agent ${agentId} ` +
        `(hires are sized from /api/pricing/quote, never from a typed amount)`
      );
    }
    return null;
  }

  private ok(req: SettlementRequest, reference: string): SettlementResult {
    return {
      settled: true,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut: req.amount,
      reference,
    };
  }

  private async settleInner(req: SettlementRequest, receipt: AgentHireReceipt): Promise<SettlementResult> {
    if (req.amount <= 0n) return this.refuse(req, `amount must be positive, got ${req.amount}`);
    if (req.payerToken !== "USDC" || req.merchantToken !== "USDC") {
      return this.refuse(req, `AgentHire settles USDC only (payer ${req.payerToken}, merchant ${req.merchantToken})`);
    }
    const agentId = this.agentIdOf(req.merchant);
    if (agentId === undefined) return this.refuse(req, `merchant "${req.merchant}" is not an AgentHire agent`);
    receipt.agentId = agentId;
    const expiry = this.mandateExpiry(req.node);
    if (expiry === undefined) return this.refuse(req, `no mandate expiry known for "${req.node}"`);
    const now = this.now();
    if (now >= expiry) return this.refuse(req, `mandate of "${req.node}" expired at ${expiry} (now ${now})`);
    const quoteProblem = await this.quoteProblem(req, agentId, now, receipt);
    if (quoteProblem) return this.refuse(req, quoteProblem);

    const payerAgentId = this.payerAgentIdOf?.(req.node);
    if (payerAgentId !== undefined) return this.settleA2A(req, receipt, payerAgentId, agentId);
    return this.settleX402(req, receipt, agentId, expiry, now);
  }

  private async onchainInfo(): Promise<AgentHireOnchainInfo> {
    if (!this.info_) {
      this.info_ = this.client.onchainInfo();
      // Do not cache a failure: the next attempt retries.
      this.info_.catch(() => (this.info_ = null));
    }
    return this.info_;
  }

  private async settleX402(
    req: SettlementRequest,
    receipt: AgentHireReceipt,
    agentId: number,
    expiry: number,
    now: number,
  ): Promise<SettlementResult> {
    let info: AgentHireOnchainInfo;
    try {
      info = await this.onchainInfo();
    } catch (err) {
      return this.refuse(req, `could not read AgentHire deployment: ${errorMessage(err)}`);
    }
    if (info.chainId !== this.chainId) {
      return this.refuse(req, `AgentHire deployment is on chain ${info.chainId}, expected ${this.chainId}`);
    }
    const usdc = info.contracts.MockUSDC;
    const escrow = info.contracts.EscrowPayment;
    if (!isAddress(usdc) || !isAddress(escrow)) {
      return this.refuse(req, `AgentHire deployment has no valid MockUSDC/EscrowPayment addresses`);
    }

    let ch: X402Challenge;
    try {
      ch = await this.client.x402Challenge(agentId, req.amount);
    } catch (err) {
      return this.refuse(req, `no x402 challenge: ${errorMessage(err)}`);
    }
    const problem = checkChallenge(ch, { amount: req.amount, chainId: this.chainId, usdc, escrow, expiry, now });
    if (problem) return this.refuse(req, `challenge rejected: ${problem}`);
    const validBefore = Number(ch.permit.template.validBefore);
    receipt.challenge = {
      resourceId: String(ch.resourceId),
      amountMicro: String(ch.price.amountMicro),
      recipient: ch.recipient,
      token: ch.token.address,
      chainId: ch.chain.chainId,
      validBefore,
    };

    // Sign the permit ourselves: our own nonce, our own validity window (the
    // challenge's, already checked against the mandate), value = the mandate-
    // checked amount. AgentHire's template nonce is ignored on purpose.
    const permit = await signTransferWithAuthorization(this.signer, {
      usdc,
      chainId: this.chainId,
      to: escrow,
      value: req.amount,
      validBefore,
      nonce: this.nonce(),
      agentId,
    });
    receipt.permit = permit;

    // From here on the signed permit leaves this process. It is a bearer
    // authorization until validBefore, so nothing below is a refusal: a
    // failure is UNCONFIRMED and charged (see the class comment).
    if (this.mode === "fuji") {
      receipt.route = "x402-execute";
      this.sent_.add(receipt);
      let res: X402ExecuteResult;
      try {
        res = await this.client.x402Execute(agentId, req.amount, permit);
      } catch (err) {
        return this.unconfirmed(req, receipt, `AgentHire did not confirm the X-Payment permit: ${errorMessage(err)}`);
      }
      const hashes = res.receipt?.txHashes ?? null;
      const txHash = hashes ? (hashes.permit ?? hashes.settlement ?? Object.values(hashes)[0]) : undefined;
      receipt.sessionId = (res.receipt?.sessionId as string | number | null | undefined) ?? null;
      receipt.realTx = typeof txHash === "string" && txHash.length > 0;
      receipt.simulated = !receipt.realTx;
      if (!receipt.realTx) return this.unconfirmed(req, receipt, "the x402 route answered 200 without a tx hash");
      receipt.note = "AgentHire reported an on-chain transferWithAuthorization; not independently verified here";
      return this.ok(req, `agenthire-fuji:${txHash}`);
    }

    receipt.route = "x402-pay";
    this.sent_.add(receipt);
    let paid: X402PayResult;
    try {
      paid = await this.client.x402Pay(permit);
    } catch (err) {
      return this.unconfirmed(req, receipt, `AgentHire /api/x402/pay did not confirm: ${errorMessage(err)}`);
    }
    if (paid.sessionId === null || paid.sessionId === undefined || paid.sessionId === "") {
      return this.unconfirmed(req, receipt, `AgentHire /api/x402/pay returned no sessionId`);
    }
    receipt.sessionId = paid.sessionId;
    if (paid.agentId !== undefined && Number(paid.agentId) !== agentId) {
      return this.unconfirmed(req, receipt, `AgentHire booked the payment for agent ${String(paid.agentId)}, not ${agentId}`);
    }
    receipt.realTx = paid.realTx === true;
    receipt.simulated = paid.status === "mock" || paid.realTx !== true;
    receipt.note = receipt.simulated
      ? "AgentHire mock mode: Order recorded in its DB, no on-chain transfer"
      : "AgentHire reported a real transfer; not independently verified here";
    return this.ok(req, `agenthire-x402-${receipt.simulated ? "mock" : "tx"}:${paid.sessionId}`);
  }

  private async settleA2A(
    req: SettlementRequest,
    receipt: AgentHireReceipt,
    fromId: number,
    toId: number,
  ): Promise<SettlementResult> {
    receipt.mode = "a2a";
    receipt.route = "trigger-direct";
    if (fromId === toId) return this.refuse(req, `agent ${fromId} cannot hire itself`);
    const reason = `allowance:${req.node}#${this.nextSeq()}`;
    receipt.a2a = { fromId, toId, reason, eventIds: [] };
    this.sent_.add(receipt);
    let res: TriggerDirectResult;
    try {
      res = await this.client.triggerDirect({ fromId, toId, amountMicro: req.amount, reason });
    } catch (err) {
      // AgentHire answers a 4xx (bad fields, unknown agent, rate limit) before
      // it books anything; anything else may have booked the hire.
      if (err instanceof AgentHireError && err.status !== null && err.status >= 400 && err.status < 500) {
        this.sent_.delete(receipt);
        return this.refuse(req, `AgentHire refused trigger-direct before booking it: ${errorMessage(err)}`);
      }
      return this.unconfirmed(req, receipt, `AgentHire trigger-direct did not confirm: ${errorMessage(err)}`);
    }
    const hire = res.newEvents.find((e) => e.kind === "a2a_hire" && isObject(e.meta) && e.meta.trigger === reason);
    receipt.a2a = { fromId, toId, reason, eventIds: res.newEvents.map((e) => e.id) };
    receipt.realTx = typeof res.realTxHash === "string" && res.realTxHash.length > 0;
    receipt.simulated = !receipt.realTx;
    receipt.note = "AgentHire simulation route (/api/sim/trigger-direct)";
    // AgentHire answered 2xx, so it ran the hire: a mismatch below is not a
    // refusal, it is a booking that does not match what was asked.
    if (res.ok === false) return this.unconfirmed(req, receipt, `AgentHire trigger-direct answered ok:false`);
    if (res.fromId !== fromId || res.toId !== toId) {
      return this.unconfirmed(req, receipt, `AgentHire echoed ${res.fromId}->${res.toId}, expected ${fromId}->${toId}`);
    }
    if (typeof res.amountUSDC !== "number" || agentHireMicroOf(res.amountUSDC) !== req.amount) {
      return this.unconfirmed(req, receipt, `AgentHire booked ${res.amountUSDC} USDC, expected ${formatAmount(req.amount)}`);
    }
    if (!hire) return this.unconfirmed(req, receipt, `no a2a_hire event tagged "${reason}" in AgentHire's response`);
    return this.ok(req, `agenthire-a2a-sim:${hire.id}`);
  }
}

/** Why an x402 challenge is unacceptable for this payment, or null if it is fine. */
export function checkChallenge(
  ch: X402Challenge,
  want: { amount: bigint; chainId: number; usdc: string; escrow: string; expiry: number; now: number },
): string | null {
  if (ch.scheme !== AGENTHIRE_X402_SCHEME) return `scheme "${ch.scheme}" is not ${AGENTHIRE_X402_SCHEME}`;
  const d = ch.permit.domain;
  const t = ch.permit.template;
  if (ch.chain.chainId !== want.chainId) return `chainId ${ch.chain.chainId}, expected ${want.chainId}`;
  if (d.chainId !== want.chainId) return `permit domain chainId ${d.chainId}, expected ${want.chainId}`;
  if (d.name !== MOCK_USDC_DOMAIN_NAME || d.version !== MOCK_USDC_DOMAIN_VERSION) {
    return `permit domain "${d.name}" v${d.version}, expected "${MOCK_USDC_DOMAIN_NAME}" v${MOCK_USDC_DOMAIN_VERSION}`;
  }
  if (!sameAddress(ch.token.address, want.usdc)) return `token ${ch.token.address} is not MockUSDC ${want.usdc}`;
  if (!sameAddress(d.verifyingContract, want.usdc)) {
    return `permit verifyingContract ${d.verifyingContract} is not MockUSDC ${want.usdc}`;
  }
  if (!sameAddress(ch.recipient, want.escrow)) return `recipient ${ch.recipient} is not EscrowPayment ${want.escrow}`;
  if (!sameAddress(t.to, want.escrow)) return `permit.to ${t.to} is not EscrowPayment ${want.escrow}`;
  const priced = toBigIntOrNull(ch.price.amountMicro);
  if (priced !== want.amount) {
    return `amountMicro ${String(ch.price.amountMicro)} != mandate-checked amount ${want.amount}`;
  }
  const value = toBigIntOrNull(t.value);
  if (value !== want.amount) return `permit value ${String(t.value)} != mandate-checked amount ${want.amount}`;
  const validBefore = Number(t.validBefore);
  if (!Number.isSafeInteger(validBefore)) return `validBefore ${String(t.validBefore)} is not an integer`;
  if (validBefore <= want.now) return `validBefore ${validBefore} is not in the future (now ${want.now})`;
  if (validBefore > want.expiry) {
    return `validBefore ${validBefore} outlives the mandate (expiry ${want.expiry})`;
  }
  return null;
}

/** Sign an EIP-3009 TransferWithAuthorization in AgentHire's X-Payment format. */
export async function signTransferWithAuthorization(
  signer: TypedDataSigner,
  p: { usdc: string; chainId: number; to: string; value: bigint; validBefore: number; nonce: string; agentId: number; validAfter?: number; categoryId?: number },
): Promise<X402Permit> {
  const from = getAddress(signer.address);
  const to = getAddress(p.to);
  const validAfter = p.validAfter ?? 0;
  const message = {
    from,
    to,
    value: p.value,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(p.validBefore),
    nonce: p.nonce,
  };
  const sig = Signature.from(
    await signer.signTypedData(mockUsdcDomain(p.usdc, p.chainId), TRANSFER_WITH_AUTHORIZATION_TYPES, message),
  );
  return {
    from,
    to,
    value: p.value.toString(),
    validAfter,
    validBefore: p.validBefore,
    nonce: p.nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
    agentId: p.agentId,
    tokenBudget: p.value.toString(),
    categoryId: p.categoryId ?? 0,
  };
}

/** The typed-data message a permit signed, for `ethers.verifyTypedData`. */
export function permitMessage(permit: X402Permit): Record<string, unknown> {
  return {
    from: permit.from,
    to: permit.to,
    value: BigInt(permit.value),
    validAfter: BigInt(permit.validAfter),
    validBefore: BigInt(permit.validBefore),
    nonce: permit.nonce,
  };
}

/** The address that signed `permit` for Mock USDC at `usdc` on `chainId` (EIP-712 recovery). */
export function recoverPermitSigner(permit: X402Permit, usdc: string, chainId: number = AGENTHIRE_CHAIN_ID): string {
  return verifyTypedData(mockUsdcDomain(usdc, chainId), TRANSFER_WITH_AUTHORIZATION_TYPES, permitMessage(permit), {
    r: permit.r,
    s: permit.s,
    v: permit.v,
  });
}

/* ------------------------------------------------------------------ */
/* Operators (agent -> deployer wallet + World ID nullifier)          */
/* ------------------------------------------------------------------ */

export interface OperatorBinding {
  agentId: number;
  /** Lower-cased 0x deployer wallet from AgentHire. */
  deployerWallet: string;
  /** The operator's World ID nullifier: the counterparty key. */
  worldIdNullifier: string;
  /** True while the nullifier comes from the World ID mock (not a real proof). */
  simulated: boolean;
}

export interface OperatorRegistryConfig {
  /** Mints the operator nullifier. Default: the World IDKit mock (`MockPrincipalVerifier`). */
  verifier?: PrincipalVerifier;
  /** IDKit action the operator proof is scoped to. */
  action?: string;
  /** Set false only when `verifier` is a real World ID verifier. Default true. */
  simulated?: boolean;
}

/**
 * Binds each AgentHire agent to its operator, so that differently named agents
 * run by one operator are ONE counterparty and incidents follow the operator.
 *
 * The counterparty key is a World ID nullifier minted once per deployer wallet
 * through the existing World ID adapter (the mock by default, seeded by the
 * wallet). With a real World ID the operator would prove personhood once and
 * the nullifier would also unify several wallets of one human; the mock can
 * only unify agents that share a deployer wallet.
 */
export class OperatorRegistry {
  private readonly verifier: PrincipalVerifier;
  private readonly action: string;
  private readonly simulated: boolean;
  private readonly byAgent_ = new Map<number, OperatorBinding>();
  private readonly nullifierByWallet_ = new Map<string, Promise<string>>();

  constructor(config: OperatorRegistryConfig = {}) {
    this.verifier = config.verifier ?? new MockPrincipalVerifier();
    this.action = config.action ?? "allowance-agenthire-operator";
    this.simulated = config.simulated ?? true;
  }

  /** Bind `agentId` to the operator at `deployerWallet`. Idempotent; refuses a different operator. */
  async bind(agentId: number, deployerWallet: string): Promise<OperatorBinding> {
    if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new RangeError(`not an agent id: ${agentId}`);
    if (!isAddress(deployerWallet)) throw new Error(`agent ${agentId}: deployer wallet "${deployerWallet}" is not an address`);
    const wallet = deployerWallet.toLowerCase();
    const existing = this.byAgent_.get(agentId);
    if (existing) {
      if (existing.deployerWallet !== wallet) {
        throw new Error(`agent ${agentId} is already bound to operator ${existing.deployerWallet}, not ${wallet}`);
      }
      return existing;
    }
    const worldIdNullifier = await this.nullifierFor(wallet);
    const binding: OperatorBinding = { agentId, deployerWallet: wallet, worldIdNullifier, simulated: this.simulated };
    const raced = this.byAgent_.get(agentId); // a concurrent bind() may have won
    if (raced) {
      if (raced.deployerWallet !== wallet) {
        throw new Error(`agent ${agentId} is already bound to operator ${raced.deployerWallet}, not ${wallet}`);
      }
      return raced;
    }
    this.byAgent_.set(agentId, binding);
    return binding;
  }

  /** Read the agent's `deployer_wallet` from AgentHire and bind it. */
  async bindFromAgentHire(client: AgentHireClient, agentId: number): Promise<OperatorBinding> {
    const existing = this.byAgent_.get(agentId);
    if (existing) return existing;
    const agent = await client.getAgent(agentId);
    if (typeof agent.deployer_wallet !== "string" || !agent.deployer_wallet) {
      throw new Error(`AgentHire agent ${agentId} (${agent.name}) has no deployer_wallet; operator unknown`);
    }
    return this.bind(agentId, agent.deployer_wallet);
  }

  get(agentId: number): OperatorBinding | undefined {
    return this.byAgent_.get(agentId);
  }

  /** The counterparty key (World ID nullifier) of a bound agent. */
  counterpartyOf(agentId: number): string | undefined {
    return this.byAgent_.get(agentId)?.worldIdNullifier;
  }

  /** Every bound agent run by the operator with this nullifier. */
  agentsOf(worldIdNullifier: string): number[] {
    return [...this.byAgent_.values()].filter((b) => b.worldIdNullifier === worldIdNullifier).map((b) => b.agentId);
  }

  /** True when both agents are bound and resolve to the same operator. */
  sameCounterparty(a: number, b: number): boolean {
    const x = this.counterpartyOf(a);
    return x !== undefined && x === this.counterpartyOf(b);
  }

  list(): OperatorBinding[] {
    return [...this.byAgent_.values()];
  }

  private nullifierFor(wallet: string): Promise<string> {
    let pending = this.nullifierByWallet_.get(wallet);
    if (!pending) {
      pending = this.verifier.verify({ action: this.action, signal: wallet }).then((r) => {
        if (!r.verified || !r.nullifierHash) {
          throw new Error(`World ID refused operator ${wallet}: ${r.reason ?? "no nullifier"}`);
        }
        return r.nullifierHash;
      });
      pending.catch(() => this.nullifierByWallet_.delete(wallet));
      this.nullifierByWallet_.set(wallet, pending);
    }
    return pending;
  }
}

/* ------------------------------------------------------------------ */
/* Incidents                                                          */
/* ------------------------------------------------------------------ */

/**
 * An incident recorded by Allowance, keyed by agent AND operator. This is not
 * a slash: it records that an agent kept trying to spend past its mandate.
 */
export interface AllowanceIncident {
  id: string;
  agentId: number;
  /** Operator counterparty key (World ID nullifier). */
  operator: string;
  deployerWallet: string;
  kind: string;
  reason: string;
  node?: string;
  attempts?: number;
  at: number;
  /** Provenance, e.g. "scripted by the Allowance demo acting for agent 5". */
  note?: string;
  /** What happened when the incident was sent to AgentHire's dispute route, if it was. */
  agentHireReport?: { route: string; ok: boolean; status?: string; note?: string; error?: string };
}

/** Where an `IncidentLedger` keeps its incidents between processes. */
export interface IncidentStore {
  /** Human-readable location, for messages (e.g. the file path). */
  readonly location: string;
  /** Every stored incident, oldest first. Throws when the store is unreadable. */
  load(): Promise<AllowanceIncident[]>;
  /** Replace the stored list. */
  save(incidents: readonly AllowanceIncident[]): Promise<void>;
}

function isIncident(v: unknown): v is AllowanceIncident {
  if (!isObject(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.agentId === "number" &&
    typeof v.operator === "string" &&
    typeof v.deployerWallet === "string" &&
    typeof v.kind === "string" &&
    typeof v.reason === "string" &&
    typeof v.at === "number"
  );
}

/**
 * A local JSON file of incidents (`{"version":1,"incidents":[...]}`), written
 * atomically (temp file + rename). Any process that opens the same file sees
 * the same incidents, including after a restart. It is a single-writer file,
 * not a database: two processes recording at the same instant can lose one
 * write. It lives on the Allowance side only; AgentHire never sees it.
 */
export class JsonFileIncidentStore implements IncidentStore {
  readonly path: string;
  readonly location: string;

  constructor(path: string) {
    this.path = path;
    this.location = path;
  }

  async load(): Promise<AllowanceIncident[]> {
    const { readFile } = await import("node:fs/promises");
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (isObject(err) && err.code === "ENOENT") return [];
      throw err;
    }
    const parsed: unknown = JSON.parse(text);
    const list = isObject(parsed) ? parsed.incidents : undefined;
    if (!Array.isArray(list)) throw new Error(`incident store ${this.path}: expected {"incidents": [...]}`);
    list.forEach((i, n) => {
      if (!isIncident(i)) throw new Error(`incident store ${this.path}: incidents[${n}] is malformed`);
    });
    return list as AllowanceIncident[];
  }

  async save(incidents: readonly AllowanceIncident[]): Promise<void> {
    const { mkdir, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = {
      version: 1,
      note: "Allowance-side incident record (not AgentHire's): repeated attempts to spend past a mandate, keyed by agent and operator. Not a slash.",
      incidents,
    };
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
    await rename(tmp, this.path);
  }
}

/**
 * Allowance's own incident record. AgentHire @ ab317f2 has no keyless route
 * that adds an incident without slashing: the only code path that raises
 * `rep_incident_count` is the simulator's `_do_slash` (sim_engine.py:713-736),
 * reached from /api/sim/slash-agent, which also burns stake. So incidents live
 * here, keyed by agent and operator, and screening reads them from here.
 *
 * Without a store the ledger is in-memory and local to its process. With an
 * `IncidentStore` (e.g. `JsonFileIncidentStore`) every `record()` is written
 * through and `sync()` reloads it, and `AgentHireScreeningService` calls
 * `sync()` before every check, so a buyer in another process, or after a
 * restart, is screened against the same incidents.
 */
export class IncidentLedger {
  private incidents_: AllowanceIncident[] = [];
  private readonly store: IncidentStore | undefined;

  constructor(store?: IncidentStore) {
    this.store = store;
  }

  /** True when incidents are written through to a store other processes can read. */
  get persistent(): boolean {
    return this.store !== undefined;
  }

  /** Where the incidents live: the store's location, or "memory (this process only)". */
  get location(): string {
    return this.store?.location ?? "memory (this process only)";
  }

  /** Reload from the store (a no-op in memory). Throws when the store is unreadable. */
  async sync(): Promise<void> {
    if (this.store) this.incidents_ = await this.store.load();
  }

  async record(
    binding: OperatorBinding,
    input: { kind: string; reason: string; node?: string; attempts?: number; at?: number; note?: string },
  ): Promise<AllowanceIncident> {
    await this.sync();
    const incident: AllowanceIncident = {
      id: `ALW-INC-${this.nextNumber()}`,
      agentId: binding.agentId,
      operator: binding.worldIdNullifier,
      deployerWallet: binding.deployerWallet,
      kind: input.kind,
      reason: input.reason,
      at: input.at ?? Math.floor(Date.now() / 1000),
    };
    if (input.node !== undefined) incident.node = input.node;
    if (input.attempts !== undefined) incident.attempts = input.attempts;
    if (input.note !== undefined) incident.note = input.note;
    this.incidents_.push(incident);
    await this.store?.save(this.incidents_);
    return incident;
  }

  /** Store what AgentHire answered when the incident was sent to it. */
  async annotate(id: string, report: NonNullable<AllowanceIncident["agentHireReport"]>): Promise<void> {
    await this.sync();
    const incident = this.incidents_.find((i) => i.id === id);
    if (!incident) throw new Error(`no incident ${id} in ${this.location}`);
    incident.agentHireReport = report;
    await this.store?.save(this.incidents_);
  }

  /** The incidents as of the last `sync()` / `record()`. */
  list(): readonly AllowanceIncident[] {
    return this.incidents_;
  }

  forAgent(agentId: number): AllowanceIncident[] {
    return this.incidents_.filter((i) => i.agentId === agentId);
  }

  forOperator(worldIdNullifier: string): AllowanceIncident[] {
    return this.incidents_.filter((i) => i.operator === worldIdNullifier);
  }

  countForAgent(agentId: number): number {
    return this.forAgent(agentId).length;
  }

  countForOperator(worldIdNullifier: string): number {
    return this.forOperator(worldIdNullifier).length;
  }

  private nextNumber(): number {
    let max = 0;
    for (const i of this.incidents_) {
      const m = /^ALW-INC-(\d+)$/.exec(i.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }
}

/**
 * Send an Allowance incident to AgentHire's buyer dispute route
 * (POST /api/dispute/submit) and store the answer on the incident. Keyless
 * AgentHire only prints the dispute to its server log and answers
 * `pending_review`: no ModerationReport row, no incident counter change,
 * nothing slashed. Never throws: a failure is stored as `agentHireReport.error`.
 */
export async function pushIncidentReport(
  client: AgentHireClient,
  incident: AllowanceIncident,
  affectedUser: string,
): Promise<AllowanceIncident> {
  const route = "/api/dispute/submit";
  try {
    const res = await client.submitDispute({
      agentId: incident.agentId,
      severity: 1,
      reason:
        `[Allowance ${incident.id}] ${incident.kind}: ${incident.reason}` +
        (incident.note ? ` [${incident.note}]` : "") +
        ` (operator ${incident.deployerWallet}; this is an incident report, not a slash request)`,
      affectedUser,
    });
    const report: NonNullable<AllowanceIncident["agentHireReport"]> = { route, ok: true };
    if (typeof res.status === "string") report.status = res.status;
    if (typeof res.note === "string") report.note = res.note;
    incident.agentHireReport = report;
  } catch (err) {
    incident.agentHireReport = { route, ok: false, error: errorMessage(err) };
  }
  return incident;
}

export interface OverspendWatchConfig {
  ledger: IncidentLedger;
  operators: OperatorRegistry;
  /** Binds an agent's operator on demand. Defaults to `report.client`. */
  client?: AgentHireClient;
  /** Over-mandate attempts that make one incident. Default 2 ("repeatedly"). */
  threshold?: number;
  /** When set, each incident is also sent to AgentHire's dispute route. */
  report?: { client: AgentHireClient; affectedUser: string };
  /**
   * Provenance stored on every incident and quoted in the dispute, e.g.
   * "scripted by the Allowance demo acting for agent 5" when the attempts
   * were made by a script rather than the agent itself.
   */
  note?: string;
}

/**
 * Turns repeated over-mandate attempts into incidents. Feed it every
 * `PaymentRecord` of a node that acts for an AgentHire agent; when the agent
 * has been stopped for spending past its mandate `threshold` times, one
 * incident is recorded (and optionally sent to AgentHire) and the count
 * starts again.
 */
export class OverspendWatch {
  private readonly config: OverspendWatchConfig;
  private readonly threshold: number;
  private readonly attempts_ = new Map<number, number>();

  constructor(config: OverspendWatchConfig) {
    this.config = config;
    this.threshold = Math.max(1, Math.floor(config.threshold ?? 2));
  }

  /** Over-mandate attempts counted towards the next incident for this agent. */
  attempts(agentId: number): number {
    return this.attempts_.get(agentId) ?? 0;
  }

  async observe(record: PaymentRecord, agentId: number): Promise<AllowanceIncident | null> {
    if (!isOverspend(record)) return null;
    const n = this.attempts(agentId) + 1;
    if (n < this.threshold) {
      this.attempts_.set(agentId, n);
      return null;
    }
    this.attempts_.set(agentId, 0);
    // An over-mandate payment stops before screening runs, so the operator may
    // not be bound yet: bind it from AgentHire when a client is available.
    const client = this.config.client ?? this.config.report?.client;
    const binding =
      this.config.operators.get(agentId) ??
      (client ? await this.config.operators.bindFromAgentHire(client, agentId) : undefined);
    if (!binding) {
      throw new Error(`OverspendWatch: agent ${agentId} has no operator binding and no client to bind it`);
    }
    const input: Parameters<IncidentLedger["record"]>[1] = {
      kind: "mandate_overspend",
      reason: `${n} attempts to spend past its mandate; last: ${record.reason ?? "blocked"}`,
      node: record.node,
      attempts: n,
      at: record.at,
    };
    if (this.config.note !== undefined) input.note = this.config.note;
    const incident = await this.config.ledger.record(binding, input);
    if (this.config.report) {
      await pushIncidentReport(this.config.report.client, incident, this.config.report.affectedUser);
      if (incident.agentHireReport) await this.config.ledger.annotate(incident.id, incident.agentHireReport);
    }
    return incident;
  }
}

/** A payment stopped by the budget check (not by scope, expiry, or settlement). */
export function isOverspend(record: PaymentRecord): boolean {
  return record.outcome === "BLOCKED_MANDATE" && /exceeds available/.test(record.reason ?? "");
}

/* ------------------------------------------------------------------ */
/* Screening                                                          */
/* ------------------------------------------------------------------ */

export interface AgentHireScreeningConfig {
  client: AgentHireClient;
  operators: OperatorRegistry;
  incidents: IncidentLedger;
  /** Merchant -> AgentHire agent id. Default `parseAgentHireMerchant`. */
  agentIdOf?: (merchant: string) => number | undefined;
  /** Lowest AgentHire reputation tier (1..3) accepted. Default 1. */
  minTier?: number;
  /** Most AgentHire-side incidents (reputation or stake) accepted. Default 2 (its 3rd incident bans). */
  maxIncidents?: number;
  /** Most Allowance incidents against the agent's OPERATOR accepted. Default 0. */
  maxOperatorIncidents?: number;
  /** Runs first (e.g. sanctions screening) and alone for non-AgentHire merchants. */
  inner?: ScreeningService;
}

/**
 * AgentHire reputation as a core `ScreeningService`. Blocks (fail-closed) when:
 *   - AgentHire can't be read (network, HTML 429, bad shape),
 *   - the agent has no resolvable operator,
 *   - the agent is banned on AgentHire,
 *   - its reputation tier is below `minTier`,
 *   - its AgentHire incident count is above `maxIncidents`,
 *   - its OPERATOR has more than `maxOperatorIncidents` Allowance incidents,
 *     whichever of that operator's agents they were recorded against.
 */
export class AgentHireScreeningService implements ScreeningService {
  private readonly config: AgentHireScreeningConfig;
  private readonly agentIdOf: (merchant: string) => number | undefined;
  private readonly minTier: number;
  private readonly maxIncidents: number;
  private readonly maxOperatorIncidents: number;

  constructor(config: AgentHireScreeningConfig) {
    this.config = config;
    this.agentIdOf = config.agentIdOf ?? parseAgentHireMerchant;
    this.minTier = config.minTier ?? 1;
    this.maxIncidents = config.maxIncidents ?? 2;
    this.maxOperatorIncidents = config.maxOperatorIncidents ?? 0;
  }

  async screen(req: ScreeningRequest): Promise<ScreeningResult> {
    try {
      return await this.screenInner(req);
    } catch (err) {
      return { approved: false, reason: `screening: unexpected error: ${errorMessage(err)}` };
    }
  }

  private async screenInner(req: ScreeningRequest): Promise<ScreeningResult> {
    const agentId = this.agentIdOf(req.merchant);
    const first = this.config.inner ? await this.config.inner.screen(req) : undefined;
    if (first && !first.approved) return first;
    if (agentId === undefined) {
      return first ?? { approved: true, reason: `"${req.merchant}" is not an AgentHire agent; no reputation screen applied` };
    }

    const reference = `agenthire-screen:${agentId}`;
    let binding: OperatorBinding;
    try {
      binding = await this.config.operators.bindFromAgentHire(this.config.client, agentId);
    } catch (err) {
      return { approved: false, reason: `screening: operator of agent ${agentId} unknown: ${errorMessage(err)}`, reference };
    }

    let rep: AgentHireReputation;
    let stake: AgentHireStake;
    try {
      [rep, stake] = await Promise.all([this.config.client.reputation(agentId), this.config.client.stake(agentId)]);
    } catch (err) {
      return { approved: false, reason: `screening: AgentHire reputation unavailable: ${errorMessage(err)}`, reference };
    }

    if (stake.banned) return { approved: false, reason: `screening: agent ${agentId} is banned on AgentHire`, reference };
    if (rep.tier < this.minTier) {
      return { approved: false, reason: `screening: agent ${agentId} reputation tier ${rep.tier} < required ${this.minTier}`, reference };
    }
    const incidents = Math.max(rep.incidentCount, stake.incidentCount);
    if (incidents > this.maxIncidents) {
      return {
        approved: false,
        reason: `screening: agent ${agentId} has ${incidents} AgentHire incident(s) > ${this.maxIncidents} allowed`,
        reference,
      };
    }
    // Read the incident store fresh: another process (or an earlier run) may
    // have recorded an incident since. Unreadable store -> fail closed.
    try {
      await this.config.incidents.sync();
    } catch (err) {
      return { approved: false, reason: `screening: incident record ${this.config.incidents.location} unreadable: ${errorMessage(err)}`, reference };
    }
    const operatorIncidents = this.config.incidents.forOperator(binding.worldIdNullifier);
    if (operatorIncidents.length > this.maxOperatorIncidents) {
      const agents = [...new Set(operatorIncidents.map((i) => i.agentId))].join(", ");
      return {
        approved: false,
        reason:
          `screening: operator ${binding.deployerWallet} (World ID nullifier ${binding.worldIdNullifier.slice(0, 10)}…) ` +
          `has ${operatorIncidents.length} Allowance incident(s) (agent ${agents}) > ${this.maxOperatorIncidents} allowed`,
        reference,
      };
    }
    return {
      approved: true,
      reason:
        `cleared: tier ${rep.tier}, score ${rep.score}, ${incidents} AgentHire incident(s), ` +
        `operator ${binding.deployerWallet} has ${operatorIncidents.length} Allowance incident(s)` +
        (rep.simulated ? " (AgentHire reputation is its simulated DB mirror)" : ""),
      reference,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Serialized payments                                                */
/* ------------------------------------------------------------------ */

/** One queue per (tree, root mandate), shared by every SerializedPayer in the process. */
const ROOT_QUEUES = new WeakMap<DelegationTree, Map<string, Promise<void>>>();

/**
 * Runs core `pay()` one payment at a time per ROOT mandate.
 *
 * `pay()` checks the budget, then awaits screening and settlement, then books
 * the spend. Two concurrent payments against the same leftover budget would
 * both pass the check and both settle. Queuing every payment (and `close()`)
 * that shares a root closes that gap: the second payment sees the first one's
 * spend. Different roots (different trees) still run in parallel.
 *
 * The queues are shared by EVERY `SerializedPayer` in this process (they are
 * keyed by tree object and root name, not by payer instance), so two services
 * that each build their own payer over the same tree still take turns. They
 * cannot serialize writes that bypass a payer (a bare `pay()` or tree write),
 * or another process's copy of the tree.
 */
export class SerializedPayer {
  private readonly adapters: PaymentAdapters;
  private readonly defaults: PayOptions;

  constructor(adapters: PaymentAdapters, defaults: PayOptions = {}) {
    this.adapters = adapters;
    this.defaults = defaults;
  }

  /** The root mandate `name` draws from (itself if it is the root or unknown). */
  rootOf(tree: DelegationTree, name: string): string {
    return tree.ancestors(name).at(-1)?.name ?? name;
  }

  /** `pay()`, queued behind every earlier call on the same root. */
  pay(tree: DelegationTree, req: PaymentRequest, opts: PayOptions = {}): Promise<PaymentRecord> {
    return this.run(tree, req.node, () => pay(tree, req, this.adapters, { ...this.defaults, ...opts }));
  }

  /** `tree.close(name)`, queued so it cannot land between a payment's check and its booking. */
  close(tree: DelegationTree, name: string): Promise<bigint> {
    return this.run(tree, name, () => tree.close(name));
  }

  /** Run `fn` in the queue of `name`'s root. A failing `fn` does not block the queue. */
  run<T>(tree: DelegationTree, name: string, fn: () => T | Promise<T>): Promise<T> {
    let queues = ROOT_QUEUES.get(tree);
    if (!queues) {
      queues = new Map();
      ROOT_QUEUES.set(tree, queues);
    }
    const root = this.rootOf(tree, name);
    const previous = queues.get(root) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(root, tail);
    void tail.then(() => {
      if (queues.get(root) === tail) queues.delete(root);
    });
    return result;
  }
}
