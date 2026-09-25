/**
 * Uniswap v4 hook — off-chain mirror of the on-chain spend-cap enforcement.
 *
 * On-chain, a Uniswap v4 hook (see `contracts/`) enforces the attenuated spend
 * cap: a settlement swap for a node reverts unless the amount fits inside that
 * node's remaining available authority and the mandate is live (not revoked, not
 * expired). This module is the DETERMINISTIC OFF-CHAIN MIRROR of that exact
 * check, so the demo/orchestrator can show the same decision the hook makes and
 * assert both agree.
 *
 * Sponsor: Uniswap ($6k) — the on-chain hook enforcing the cap (needs FEEDBACK.md).
 * Reference contract: `contracts/src/SpendCapHook.sol` (the source of truth for
 * the revert names below).
 *
 * Ships:
 *   - `SpendCapHook`  off-chain mirror (pure, offline)
 *   (No "real" network stub is needed — the real enforcement is the Solidity
 *    contract in `contracts/`; this class deliberately mirrors it 1:1.)
 */

import type { DelegationTree } from "@allowance/core";

/** Solidity custom-error names the on-chain hook reverts with (mirrored here). */
export type HookRevert = "SpendCapExceeded" | "MandateRevoked" | "MandateExpired";

/** Inputs the hook needs to decide, independent of how they were sourced. */
export interface SpendCapCheck {
  node: string;
  /** Amount the settlement wants to move (smallest units). */
  amount: bigint;
  /** Node's remaining authority: budget - spentDirect - reserved (smallest units). */
  available: bigint;
  /** Whether the node or any ancestor is revoked. */
  revoked: boolean;
  /** Whether the node or any ancestor mandate is expired at evaluation time. */
  expired: boolean;
}

/** The hook's decision, mirroring an on-chain allow / revert. */
export interface HookDecision {
  allowed: boolean;
  /** The custom error the on-chain hook would revert with, when not allowed. */
  revert?: HookRevert;
  reason?: string;
}

/**
 * Off-chain mirror of the Uniswap v4 `beforeSwap` spend-cap hook.
 *
 * Enforcement order matches the Solidity contract: revocation, then expiry, then
 * the numeric cap. Keeping this identical to `contracts/src/SpendCapHook.sol`
 * lets the orchestrator prove the off-chain pipeline and the on-chain guard agree.
 */
export class SpendCapHook {
  /** Core check: does this settlement fit within the node's live spend cap? */
  beforeSwap(check: SpendCapCheck): HookDecision {
    if (check.revoked) {
      return {
        allowed: false,
        revert: "MandateRevoked",
        reason: `mandate for "${check.node}" (or an ancestor) is revoked`,
      };
    }
    if (check.expired) {
      return {
        allowed: false,
        revert: "MandateExpired",
        reason: `mandate for "${check.node}" (or an ancestor) is expired`,
      };
    }
    if (check.amount > check.available) {
      return {
        allowed: false,
        revert: "SpendCapExceeded",
        reason: `amount ${check.amount} exceeds spend cap ${check.available} for "${check.node}"`,
      };
    }
    return { allowed: true };
  }

  /**
   * Convenience: build the `SpendCapCheck` straight from a live `DelegationTree`
   * and evaluate it. This is what the demo uses to show the hook's verdict for a
   * given payment, sourced from the same state `pay()` reads.
   */
  checkFromTree(tree: DelegationTree, node: string, amount: bigint, now: number): HookDecision {
    return this.beforeSwap({
      node,
      amount,
      available: tree.available(node),
      revoked: tree.isRevokedInChain(node),
      expired: tree.isExpiredInChain(node, now),
    });
  }
}
