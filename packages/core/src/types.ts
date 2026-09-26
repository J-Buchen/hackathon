/**
 * @allowance/core — domain types.
 *
 * AMOUNTS. Every monetary amount is an integer number of the token's smallest
 * unit, held as a `bigint` in memory (USDC has 6 decimals, so 1 USDC = 1_000000n).
 * When an amount crosses the JSON boundary it is serialized as a decimal STRING
 * of that same smallest-unit integer (e.g. 100 USDC -> "100000000"). See
 * `amount.ts` for human <-> smallest-unit helpers used by the demo/orchestrator.
 */

/** Verification state of an agent node's machine identity (World ID for Agents). */
export type IdentityStatus = "verified" | "expired" | "none";

/**
 * A mandate is the spending authority attached to a node. It is always a slice
 * of the parent's remaining authority (see `attenuation.ts`).
 */
export interface Mandate {
  /** Total authority granted to this node, in smallest units. */
  budget: bigint;
  /** Amount this node has itself spent (not counting descendants). */
  spentDirect: bigint;
  /** Merchant allowlist. `undefined` means "any merchant". */
  allowedMerchants?: string[];
  /** Purpose allowlist. `undefined` means "any purpose". */
  allowedPurposes?: string[];
  /** Expiry as a unix timestamp in seconds. */
  expiry: number;
  /** When true this mandate (and, transitively, all descendants) is dead. */
  revoked: boolean;
}

/**
 * An agent node in the delegation tree. The node's `name` is an ENS-style dotted
 * name whose LEFT-MOST label is the node itself, e.g.
 * `scraper.researcher.alice.eth` — scraper is the child of researcher.alice.eth.
 */
export interface AgentNode {
  /** ENS-style dotted name; child label is left-most. */
  name: string;
  /** Parent node name, or `null` for the root agent (granted by the principal). */
  parent: string | null;
  /** Machine-identity status for this node. */
  identityStatus: IdentityStatus;
  /** The spending mandate held by this node. */
  mandate: Mandate;
}

/** The human root of trust, verified with World IDKit. */
export interface Principal {
  /** Human-readable identifier, e.g. "alice". */
  name: string;
  /** True once the human has passed IDKit verification. */
  verified: boolean;
}

/**
 * Input shape for granting/delegating a mandate. `spentDirect` and `revoked` are
 * managed by the tree, so callers only describe the authority being granted.
 */
export interface MandateInput {
  budget: bigint;
  allowedMerchants?: string[];
  allowedPurposes?: string[];
  expiry: number;
}

/** A request to make a payment from a node to a merchant. */
export interface PaymentRequest {
  /** Name of the paying node. */
  node: string;
  /** Merchant identifier being paid. */
  merchant: string;
  /** Amount in smallest units. */
  amount: bigint;
  /** Optional purpose tag, checked against the mandate's purpose allowlist. */
  purpose?: string;
  /** Token the payer holds. Defaults to the settlement token (USDC). */
  payerToken?: string;
  /** Token the merchant wants to receive. Defaults to USDC. */
  merchantToken?: string;
}

/** Terminal outcome of the payment pipeline. */
export type PaymentOutcome =
  | "SETTLED"
  | "DENIED_IDENTITY"
  | "REVOKED"
  | "BLOCKED_MANDATE"
  | "BLOCKED_SCREENING";

/** A recorded payment attempt and its result. */
export interface PaymentRecord {
  /** Sequence number shared with the emitted event. */
  seq: number;
  node: string;
  merchant: string;
  amount: bigint;
  purpose?: string;
  outcome: PaymentOutcome;
  /** Human-readable explanation, present on any non-SETTLED outcome. */
  reason?: string;
  /** Screening result, present once the screening stage runs. */
  screening?: ScreeningResult;
  /** Settlement result, present once the settlement stage runs. */
  settlement?: SettlementResult;
  /** Unix seconds at which the attempt was evaluated. */
  at: number;
}

/* ------------------------------------------------------------------ */
/* Event log                                                          */
/* ------------------------------------------------------------------ */

export type EventType = "FUND" | "DELEGATE" | "PAYMENT" | "REVOKE" | "RESIZE";

/** Result codes as they appear in the snapshot event log. */
export type EventResult =
  | "OK"
  | "SETTLED"
  | "BLOCKED_MANDATE"
  | "BLOCKED_SCREENING"
  | "DENIED_IDENTITY"
  | "REVOKED"
  | "ATTENUATION_REJECTED";

/**
 * What a FUND / OK or DELEGATE / OK event records about the node it created,
 * beyond its budget (the event's `amount`): everything replay needs to rebuild
 * the node exactly. Allowlists are copies taken when the event is recorded, so
 * a later write to the caller's array (or the node's) does not rewrite history.
 */
export interface EventGrant {
  /** The node's parent (null for the root). */
  parent: string | null;
  identityStatus: IdentityStatus;
  allowedMerchants?: readonly string[];
  allowedPurposes?: readonly string[];
  expiry: number;
  /** FUND only: the principal who funded the root. */
  principal?: Principal;
}

/** An event as held in memory (amounts as bigint). */
export interface AllowanceEvent {
  seq: number;
  type: EventType;
  node: string;
  detail: string;
  result: EventResult;
  amount: bigint | null;
  merchant: string | null;
  /**
   * FUND / OK and DELEGATE / OK: the node as created (see `EventGrant`). The
   * tree's own API always sets it; replay refuses a grant event without it.
   */
  grant?: EventGrant;
  /**
   * RESIZE / OK: the budget the node held just before the resize (`amount` is
   * the budget after). Replay checks that the log left the node at exactly
   * this budget, so a write that bypassed the API is caught even when a later
   * resize overwrites it. The tree's own API always sets it.
   */
  before?: bigint;
  /**
   * SHA-256 (hex) over the hash of the event before it and every field
   * above (see `chain.ts`). `recordEvent` always sets it; replay reports an
   * event without it, or with one that does not match, as LOG_REWRITTEN.
   */
  hash?: string;
}

/* ------------------------------------------------------------------ */
/* Adapter port request/result types                                  */
/* (The port INTERFACES themselves live in payment.ts.)               */
/* ------------------------------------------------------------------ */

/** Context handed to the identity gate for a payment attempt. */
export interface IdentityCheckContext {
  /** The paying node. */
  node: AgentNode;
  /** Ancestors from the immediate parent up to the root. */
  ancestors: AgentNode[];
}

/** Result of an identity check. */
export interface IdentityResult {
  ok: boolean;
  reason?: string;
}

/** Request to the compliance-screening service (Intercepta). */
export interface ScreeningRequest {
  node: string;
  merchant: string;
  amount: bigint;
  purpose?: string;
}

/** Result of a screening call. */
export interface ScreeningResult {
  approved: boolean;
  reason?: string;
  /** Opaque provider reference (case id, request id, ...). */
  reference?: string;
}

/** Request to move funds (1inch Aqua / SwapVM). */
export interface SettlementRequest {
  node: string;
  merchant: string;
  amount: bigint;
  purpose?: string;
  /** Token the payer holds. */
  payerToken: string;
  /** Token the merchant receives. */
  merchantToken: string;
}

/** Result of a settlement call. */
export interface SettlementResult {
  settled: boolean;
  /** True when a cross-token swap was performed. */
  swapped: boolean;
  fromToken: string;
  toToken: string;
  /** Amount taken from the payer, smallest units. */
  amountIn: bigint;
  /** Amount delivered to the merchant, smallest units. */
  amountOut: bigint;
  /** Opaque settlement reference (tx hash, order id, ...). */
  reference?: string;
  reason?: string;
}

/** Proof material produced by World IDKit for the human principal. */
export interface PrincipalProof {
  /** IDKit action id. */
  action?: string;
  /** Signal bound into the proof (e.g. the root agent name). */
  signal?: string;
  /** Remaining IDKit proof fields (merkle_root, nullifier_hash, proof, ...). */
  [key: string]: unknown;
}

/** Result of verifying the human principal. */
export interface PrincipalVerificationResult {
  verified: boolean;
  nullifierHash?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Snapshot (serialized) types — the exact JSON the dashboard reads.   */
/* Amounts are decimal STRINGS of smallest-unit integers.             */
/* ------------------------------------------------------------------ */

export interface SnapshotMandate {
  budget: string;
  spentDirect: string;
  reserved: string;
  available: string;
  allowedMerchants: string[] | null;
  allowedPurposes: string[] | null;
  expiry: number;
  revoked: boolean;
}

export interface SnapshotNode {
  name: string;
  parent: string | null;
  identityStatus: IdentityStatus;
  mandate: SnapshotMandate;
}

/** `EventGrant` as serialized: allowlists as arrays, `null` meaning "any". */
export interface SnapshotGrant {
  parent: string | null;
  identityStatus: IdentityStatus;
  allowedMerchants: string[] | null;
  allowedPurposes: string[] | null;
  expiry: number;
  /** FUND only. */
  principal?: { name: string; verified: boolean };
}

export interface SnapshotEvent {
  seq: number;
  type: EventType;
  node: string;
  detail: string;
  result: EventResult;
  amount: string | null;
  merchant: string | null;
  /**
   * What replay needs (see `AllowanceEvent`). Optional so that snapshots
   * written before they were serialized still parse; such a snapshot shows
   * its log but cannot be replayed (`verifySnapshot` reports it).
   */
  grant?: SnapshotGrant;
  /** RESIZE / OK: the budget before, as a decimal string. */
  before?: string;
  /** The event's hash-chain link (see `chain.ts`). */
  hash?: string;
}

export interface Snapshot {
  asOf: number;
  currency: "USDC";
  decimals: number;
  principal: { name: string; verified: boolean };
  nodes: SnapshotNode[];
  events: SnapshotEvent[];
}
