/**
 * Attenuation — the heart of Allowance.
 *
 * When a parent P delegates a mandate M to a child C, the child may only NARROW
 * the parent's authority, never broaden it. This module is a PURE validator: it
 * takes a parent node, the parent's currently-available budget, and a proposed
 * child mandate, and returns either `{ ok: true }` or a typed rejection.
 *
 * A proposed mandate M is valid IFF ALL of the following hold:
 *   1. M.budget <= available(P)
 *   2. P.allowedMerchants === undefined  OR  M.allowedMerchants ⊆ P.allowedMerchants
 *   3. P.allowedPurposes  === undefined  OR  M.allowedPurposes  ⊆ P.allowedPurposes
 *   4. M.expiry <= P.mandate.expiry
 * (plus a guard: a revoked parent cannot delegate at all).
 *
 * Note on (2)/(3): if the parent restricts the set (defined allowlist) then the
 * child MUST also declare a defined allowlist — leaving it `undefined` would mean
 * "any", which broadens authority and is therefore rejected.
 */

import type { AgentNode, MandateInput } from "./types";

/** Reasons a proposed child mandate can be rejected. */
export type AttenuationRejectionReason =
  | "PARENT_REVOKED"
  | "BUDGET_EXCEEDS_AVAILABLE"
  | "MERCHANTS_NOT_SUBSET"
  | "PURPOSES_NOT_SUBSET"
  | "EXPIRY_EXCEEDS_PARENT"
  | "NEGATIVE_BUDGET"
  | "BELOW_COMMITTED";

/** Result of an attenuation check. */
export type AttenuationDecision =
  | { ok: true }
  | { ok: false; reason: AttenuationRejectionReason; message: string };

/** Thrown by `DelegationTree.delegate` when attenuation fails. */
export class AttenuationError extends Error {
  readonly reason: AttenuationRejectionReason;
  constructor(reason: AttenuationRejectionReason, message: string) {
    super(message);
    this.name = "AttenuationError";
    this.reason = reason;
  }
}

/**
 * Is `child` a subset of the authority described by `parent`?
 * `undefined` on the parent means "any" (superset of everything). `undefined`
 * on the child means "any", which is only a subset when the parent is also "any".
 */
export function isAllowlistSubset(
  child: string[] | undefined,
  parent: string[] | undefined,
): boolean {
  if (parent === undefined) return true; // parent allows anything
  if (child === undefined) return false; // child "any" would broaden a restricted parent
  const parentSet = new Set(parent);
  return child.every((item) => parentSet.has(item));
}

/**
 * Validate a proposed child mandate against its parent.
 *
 * @param parent            the delegating node
 * @param proposed          the mandate the child would receive
 * @param parentAvailable   parent's available budget (budget - spentDirect - reserved)
 */
export function checkAttenuation(
  parent: AgentNode,
  proposed: MandateInput,
  parentAvailable: bigint,
): AttenuationDecision {
  if (parent.mandate.revoked) {
    return {
      ok: false,
      reason: "PARENT_REVOKED",
      message: `parent "${parent.name}" is revoked and cannot delegate`,
    };
  }

  if (proposed.budget < 0n) {
    return {
      ok: false,
      reason: "NEGATIVE_BUDGET",
      message: `proposed budget ${proposed.budget} is negative`,
    };
  }

  if (proposed.budget > parentAvailable) {
    return {
      ok: false,
      reason: "BUDGET_EXCEEDS_AVAILABLE",
      message: `proposed budget ${proposed.budget} exceeds parent available ${parentAvailable}`,
    };
  }

  if (!isAllowlistSubset(proposed.allowedMerchants, parent.mandate.allowedMerchants)) {
    return {
      ok: false,
      reason: "MERCHANTS_NOT_SUBSET",
      message: `proposed merchants are not a subset of parent "${parent.name}" merchants`,
    };
  }

  if (!isAllowlistSubset(proposed.allowedPurposes, parent.mandate.allowedPurposes)) {
    return {
      ok: false,
      reason: "PURPOSES_NOT_SUBSET",
      message: `proposed purposes are not a subset of parent "${parent.name}" purposes`,
    };
  }

  if (proposed.expiry > parent.mandate.expiry) {
    return {
      ok: false,
      reason: "EXPIRY_EXCEEDS_PARENT",
      message: `proposed expiry ${proposed.expiry} is later than parent expiry ${parent.mandate.expiry}`,
    };
  }

  return { ok: true };
}
