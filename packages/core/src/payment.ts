/**
 * The payment pipeline.
 *
 * `pay()` runs four stages, in order, short-circuiting on the first failure:
 *
 *   1. IDENTITY   — the node must be "verified" and no ancestor may be
 *                   revoked/expired in identity terms. Delegated to an injected
 *                   `IdentityGate` (World ID for Agents). -> DENIED_IDENTITY
 *   2. MANDATE    — not revoked (self+ancestors) -> REVOKED;
 *                   not expired (self+ancestors), amount <= available(N),
 *                   merchant allowed, purpose allowed -> else BLOCKED_MANDATE.
 *   3. SCREENING  — a live compliance call (Intercepta). -> BLOCKED_SCREENING
 *   4. SETTLEMENT — move funds; swap payer->merchant token if needed (1inch
 *                   Aqua). -> SETTLED
 *
 * On SETTLED the node's `spentDirect` is incremented. Every attempt (success or
 * failure) records exactly one PAYMENT event on the tree's log.
 *
 * The three sponsor integrations are injected as INTERFACES so core stays pure
 * and offline-testable; @allowance/adapters supplies mocks + real stubs.
 */

import type { DelegationTree } from "./tree";
import { UnknownNodeError } from "./tree";
import type {
  IdentityCheckContext,
  IdentityResult,
  PaymentOutcome,
  PaymentRecord,
  PaymentRequest,
  PrincipalProof,
  PrincipalVerificationResult,
  ScreeningRequest,
  ScreeningResult,
  SettlementRequest,
  SettlementResult,
} from "./types";

/* ------------------------------------------------------------------ */
/* Ports — implemented by @allowance/adapters (mock + real stub).      */
/* ------------------------------------------------------------------ */

/** World ID for Agents: proves the acting node's machine identity. */
export interface IdentityGate {
  verify(ctx: IdentityCheckContext): Promise<IdentityResult>;
}

/** Intercepta: live compliance/sanctions screening before a payment signs. */
export interface ScreeningService {
  screen(req: ScreeningRequest): Promise<ScreeningResult>;
}

/** 1inch Aqua / SwapVM: pay-in-any-token settlement. */
export interface SettlementService {
  settle(req: SettlementRequest): Promise<SettlementResult>;
}

/** World IDKit: verifies the human principal who funds the root agent. */
export interface PrincipalVerifier {
  verify(proof: PrincipalProof): Promise<PrincipalVerificationResult>;
}

/** The bundle of adapters the payment pipeline needs. */
export interface PaymentAdapters {
  identity: IdentityGate;
  screening: ScreeningService;
  settlement: SettlementService;
}

/** Options for a single `pay()` call. */
export interface PayOptions {
  /** Evaluation time (unix seconds). Defaults to now. Injectable for tests. */
  now?: number;
  /** Default settlement token when a request omits payer/merchant token. */
  settlementToken?: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** `undefined` allowlist means "any"; otherwise membership is required. */
function allowlistPermits(list: string[] | undefined, value: string): boolean {
  return list === undefined || list.includes(value);
}

/* ------------------------------------------------------------------ */
/* pay()                                                              */
/* ------------------------------------------------------------------ */

/**
 * Attempt a payment. Never throws for business outcomes — it returns a
 * `PaymentRecord` whose `outcome` field carries the result. (It does throw
 * `UnknownNodeError` for a non-existent paying node, which is a programming bug.)
 */
export async function pay(
  tree: DelegationTree,
  req: PaymentRequest,
  adapters: PaymentAdapters,
  opts: PayOptions = {},
): Promise<PaymentRecord> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const settlementToken = opts.settlementToken ?? "USDC";

  const node = tree.getNode(req.node);
  if (!node) throw new UnknownNodeError(req.node);
  const ancestors = tree.ancestors(req.node);

  // Small closure that records the PAYMENT event and returns the record.
  const finalize = (
    outcome: PaymentOutcome,
    extra: {
      reason?: string;
      screening?: ScreeningResult;
      settlement?: SettlementResult;
    } = {},
  ): PaymentRecord => {
    const event = tree.recordEvent({
      type: "PAYMENT",
      node: req.node,
      detail:
        outcome === "SETTLED"
          ? `paid ${req.amount} to ${req.merchant}`
          : `payment of ${req.amount} to ${req.merchant} -> ${outcome}${extra.reason ? `: ${extra.reason}` : ""}`,
      result: outcome,
      amount: req.amount,
      merchant: req.merchant,
    });
    return {
      seq: event.seq,
      node: req.node,
      merchant: req.merchant,
      amount: req.amount,
      purpose: req.purpose,
      outcome,
      reason: extra.reason,
      screening: extra.screening,
      settlement: extra.settlement,
      at: now,
    };
  };

  /* 1) IDENTITY ---------------------------------------------------- */
  const idContext: IdentityCheckContext = { node, ancestors };
  const identity = await adapters.identity.verify(idContext);
  if (!identity.ok) {
    return finalize("DENIED_IDENTITY", {
      reason: identity.reason ?? "identity verification failed",
    });
  }

  /* 2) MANDATE ----------------------------------------------------- */
  // Revocation (self or any ancestor) is its own terminal result.
  if (tree.isRevokedInChain(req.node)) {
    return finalize("REVOKED", { reason: "node or an ancestor is revoked" });
  }
  // Expiry (self or any ancestor).
  if (tree.isExpiredInChain(req.node, now)) {
    return finalize("BLOCKED_MANDATE", { reason: "node or an ancestor mandate is expired" });
  }
  // Budget: only the node's own remaining authority is spendable. Attenuation
  // guarantees this is already bounded by every ancestor's remaining budget.
  const available = tree.available(req.node);
  if (req.amount > available) {
    return finalize("BLOCKED_MANDATE", {
      reason: `amount ${req.amount} exceeds available ${available}`,
    });
  }
  // Merchant / purpose scope. Attenuation guarantees the node's own allowlist is
  // a subset of every ancestor's, so checking the node's own is sufficient.
  if (!allowlistPermits(node.mandate.allowedMerchants, req.merchant)) {
    return finalize("BLOCKED_MANDATE", {
      reason: `merchant "${req.merchant}" not permitted by mandate`,
    });
  }
  if (req.purpose !== undefined && !allowlistPermits(node.mandate.allowedPurposes, req.purpose)) {
    return finalize("BLOCKED_MANDATE", {
      reason: `purpose "${req.purpose}" not permitted by mandate`,
    });
  }

  /* 3) SCREENING --------------------------------------------------- */
  const screening = await adapters.screening.screen({
    node: req.node,
    merchant: req.merchant,
    amount: req.amount,
    purpose: req.purpose,
  });
  if (!screening.approved) {
    return finalize("BLOCKED_SCREENING", {
      reason: screening.reason ?? "screening rejected the payment",
      screening,
    });
  }

  /* 4) SETTLEMENT -------------------------------------------------- */
  const payerToken = req.payerToken ?? settlementToken;
  const merchantToken = req.merchantToken ?? settlementToken;
  const settlement = await adapters.settlement.settle({
    node: req.node,
    merchant: req.merchant,
    amount: req.amount,
    purpose: req.purpose,
    payerToken,
    merchantToken,
  });
  if (!settlement.settled) {
    // No dedicated settlement-failure code in the domain; surface as a blocked
    // mandate with an explicit reason so the demo never crashes.
    return finalize("BLOCKED_MANDATE", {
      reason: settlement.reason ?? "settlement failed",
      screening,
      settlement,
    });
  }

  // Success: charge the node's own spend and record it.
  node.mandate.spentDirect += req.amount;
  return finalize("SETTLED", { screening, settlement });
}
