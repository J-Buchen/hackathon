/**
 * The Allowance agent-payment flow (the "x402" money-move for autonomous agents).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS THE x402 SHAPE?
 * ─────────────────────────────────────────────────────────────────────────────
 * An agent hits a resource that answers HTTP 402 "Payment Required" with a price
 * and a merchant. The agent must PAY, then retry. Before any autonomous agent is
 * allowed to move money on its principal's behalf, Allowance runs a four-stage
 * gauntlet — and only a payment that clears all four stages is ever signed:
 *
 *   1. IDENTITY   — World ID for Agents: is this exact machine identity (and every
 *                   boss above it in the delegation chain) a verified agent?
 *   2. MANDATE    — the attenuated authority check: not revoked, not expired,
 *                   amount within this node's *remaining* slice, merchant/purpose
 *                   inside its allowlist. This is the on-chain-equivalent guard.
 *   3. SCREENING  — Intercepta: a LIVE compliance/sanctions call on (merchant,
 *                   amount, purpose) BEFORE the payment is signed.
 *   4. SETTLEMENT — 1inch Aqua: move the funds, swapping payer-token -> merchant-
 *                   token (SwapVM) when they differ.
 *
 * This module composes those stages by delegating to `@allowance/core`'s pure
 * `pay()` pipeline (which owns the ordering and the typed outcomes) and wires in
 * the concrete sponsor adapters:
 *
 *   - World ID for Agents  -> IdentityGate     (adapters: MockIdentityGate / WorldAgentIdentityGate)
 *   - Intercepta           -> ScreeningService (adapters: MockScreeningService / InterceptaScreeningService)
 *   - 1inch Aqua           -> SettlementService(adapters: MockSettlementService / AquaSettlementService)
 *   - ENSv2                -> EnsRegistry       (the delegation tree projected onto subnames + mandate text records)
 *   - Uniswap v4 hook      -> SpendCapHook      (off-chain MIRROR of the on-chain spend-cap revert)
 *
 * The flow is deliberately thin: `pay()` is the single source of truth for the
 * business logic. The flow adds the cross-cutting concerns a real deployment
 * needs around each payment — the ENS projection stays in lock-step with core
 * state, and the Uniswap hook mirror is evaluated so we can PROVE the off-chain
 * pipeline and the on-chain guard reach the same verdict.
 */

import {
  assertNever,
  pay,
  type AllowanceEvent,
  type DelegationTree,
  type PaymentAdapters,
  type PaymentRecord,
  type PaymentRequest,
  type PayOptions,
} from "@allowance/core";
import { EnsRegistry, SpendCapHook, type HookDecision } from "@allowance/adapters";

/** Everything the flow returns for a single payment attempt. */
export interface FlowResult {
  /** The typed outcome from core's pay() pipeline (never throws on business paths). */
  record: PaymentRecord;
  /** The single PAYMENT event pay() appended to the tree's ordered log. */
  event: AllowanceEvent;
  /**
   * The Uniswap v4 spend-cap hook's verdict for this exact payment, evaluated
   * against the SAME tree state pay() reads (revoked -> expired -> cap order).
   * In production this is what the on-chain `beforeSwap` hook would return; here
   * it is the off-chain mirror, so the demo can assert both agree.
   */
  hook: HookDecision;
  /**
   * True when the mandate/cap decision of the pipeline and the on-chain hook
   * mirror agree. (Identity and live screening are off-chain-only stages that the
   * hook does not model, so agreement is asserted on the mandate/cap dimension.)
   */
  hookAgrees: boolean;
}

/** Construction options for the flow. */
export interface AllowanceFlowOptions {
  /** Default settlement token used when a request omits payer/merchant token. Default "USDC". */
  settlementToken?: string;
  /** Reuse an existing ENS registry (e.g. one seeded for the whole demo). */
  ens?: EnsRegistry;
}

/**
 * The agent-payment flow. Holds the delegation tree, the concrete payment
 * adapters, the ENS projection, and the Uniswap hook mirror, and exposes a single
 * `executePayment` entrypoint that runs the full identity -> mandate -> screening
 * -> settlement gauntlet for one x402 payment.
 */
export class AllowanceFlow {
  readonly tree: DelegationTree;
  readonly adapters: PaymentAdapters;
  /** ENSv2 projection of the delegation tree (subnames + mandate text records). */
  readonly ens: EnsRegistry;
  /** Off-chain mirror of the on-chain Uniswap v4 spend-cap hook. */
  readonly hook: SpendCapHook;

  private readonly settlementToken: string;

  constructor(tree: DelegationTree, adapters: PaymentAdapters, opts: AllowanceFlowOptions = {}) {
    this.tree = tree;
    this.adapters = adapters;
    this.ens = opts.ens ?? new EnsRegistry();
    this.hook = new SpendCapHook();
    this.settlementToken = opts.settlementToken ?? "USDC";
    // Bring the ENS view up to date with whatever the tree already contains.
    this.syncEns();
  }

  /**
   * Run one x402 agent payment through the full gauntlet.
   *
   * Ordering, short-circuiting, and the typed outcome are owned by core's
   * `pay()`. Around it we (a) snapshot the on-chain hook's verdict BEFORE funds
   * move (the hook decides on the pre-payment available balance, exactly like an
   * on-chain `beforeSwap`), and (b) re-project the tree onto ENS afterwards so the
   * subname/mandate view reflects the new `spentDirect`.
   */
  async executePayment(req: PaymentRequest, payOpts: PayOptions = {}): Promise<FlowResult> {
    const now = payOpts.now ?? Math.floor(Date.now() / 1000);

    // (a) Mirror the on-chain Uniswap v4 hook against the pre-payment state.
    const hook = this.hook.checkFromTree(this.tree, req.node, req.amount, now);

    // Run the pure pipeline: identity -> mandate -> screening -> settlement.
    const record = await pay(this.tree, req, this.adapters, {
      now,
      settlementToken: this.settlementToken,
      ...payOpts,
    });

    // pay() appends exactly one PAYMENT event whose seq === record.seq.
    const event = this.requireEvent(record.seq);

    // (b) Keep the ENS projection in lock-step with core state.
    this.syncEns();

    return {
      record,
      event,
      hook,
      hookAgrees: this.mandateVerdictAgrees(record, hook),
    };
  }

  /** Re-project the whole delegation tree onto the ENS subname/mandate registry. */
  syncEns(): number {
    return this.ens.syncFromTree(this.tree);
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                        */
  /* ---------------------------------------------------------------- */

  private requireEvent(seq: number): AllowanceEvent {
    // Sequence numbers are assigned monotonically (seq_++) and events are only
    // ever appended, so seq === array index. Try the O(1) direct index first;
    // fall back to a linear scan only if that invariant is somehow violated.
    const direct = this.tree.events[seq];
    if (direct && direct.seq === seq) return direct;

    const event = this.tree.events.find((e) => e.seq === seq);
    if (!event) {
      // pay() always records exactly one event; a miss is a programming bug.
      throw new Error(`flow: expected a PAYMENT event with seq ${seq} but found none`);
    }
    return event;
  }

  /**
   * Do the pipeline outcome and the on-chain hook mirror agree on the MANDATE/CAP
   * dimension? The hook models only revocation, expiry, and the spend cap; it does
   * not model World ID identity or Intercepta screening. So:
   *  - REVOKED / BLOCKED_MANDATE  <=> hook rejects (not allowed)
   *  - SETTLED                    <=> hook allows
   *  - DENIED_IDENTITY / BLOCKED_SCREENING: identity/screening failed BEFORE or
   *    AFTER the cap; the cap itself was satisfied, so the hook allowing is the
   *    expected, consistent answer.
   */
  private mandateVerdictAgrees(record: PaymentRecord, hook: HookDecision): boolean {
    switch (record.outcome) {
      case "REVOKED":
      case "BLOCKED_MANDATE":
        return !hook.allowed;
      case "SETTLED":
      case "DENIED_IDENTITY":
      case "BLOCKED_SCREENING":
        return hook.allowed;
      default:
        // Exhaustive: every PaymentOutcome is handled above, so `record.outcome`
        // narrows to `never` here. A newly-added outcome turns this into a
        // compile error, forcing the mandate/cap agreement to be classified.
        return assertNever(record.outcome, "mandateVerdictAgrees");
    }
  }
}

/**
 * Convenience factory: build a flow over an existing tree + adapter bundle.
 * Mirrors the ergonomics of `createMockAdapters()` from `@allowance/adapters`.
 */
export function createFlow(
  tree: DelegationTree,
  adapters: PaymentAdapters,
  opts?: AllowanceFlowOptions,
): AllowanceFlow {
  return new AllowanceFlow(tree, adapters, opts);
}
