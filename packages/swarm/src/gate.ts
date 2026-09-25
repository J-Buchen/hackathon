/**
 * Pre-trade gate: the per-agent guardrail. It reads the agent's node in the
 * mandate tree and clips a proposed book to what the mandate allows:
 *
 *  - instruments   the node's allowlist (the tree's `allowedMerchants`, read as
 *                  "tradeable instruments"; attenuation already guarantees it is
 *                  a subset of the pod's and the fund's lists)
 *  - gross         at most `maxGross` × capital
 *  - liveness      a revoked or expired node (or ancestor) trades nothing
 *
 * This is the table-stakes layer every agent-trading product ships. It is
 * necessary and it is not enough: every check here looks at ONE agent. The
 * center book (allocator.ts / book.ts) is what looks across all of them.
 */

import type { DelegationTree } from "@allowance/core";
import type { Weights } from "./strategies";

export type GateViolation =
  | { kind: "OFF_MANDATE"; instrument: string }
  | { kind: "GROSS_LIMIT"; requested: number; cap: number }
  | { kind: "REVOKED" }
  | { kind: "EXPIRED" };

export interface GateResult {
  /** What the agent may actually trade right now (empty when revoked/expired). */
  weights: Weights;
  /**
   * The mandate-clipped book ignoring liveness. Used for the agent's attributable
   * (per-unit-of-capital) track record, which keeps accruing while it is cut.
   */
  clipped: Weights;
  violations: GateViolation[];
}

export interface GateOptions {
  /** Gross exposure cap as a multiple of the agent's capital. */
  maxGross: number;
  /** Evaluation time in unix seconds, for expiry. */
  now: number;
}

export function preTradeCheck(
  tree: DelegationTree,
  nodeName: string,
  proposed: Weights,
  opts: GateOptions,
): GateResult {
  const node = tree.requireNode(nodeName);
  const allowed = node.mandate.allowedMerchants;
  const violations: GateViolation[] = [];

  const clipped: Weights = {};
  let requestedGross = 0;
  for (const [instrument, w] of Object.entries(proposed)) {
    if (!Number.isFinite(w) || w === 0) continue;
    if (allowed !== undefined && !allowed.includes(instrument)) {
      violations.push({ kind: "OFF_MANDATE", instrument });
      continue;
    }
    clipped[instrument] = w;
    requestedGross += Math.abs(w);
  }
  if (requestedGross > opts.maxGross * (1 + 1e-9)) {
    violations.push({ kind: "GROSS_LIMIT", requested: requestedGross, cap: opts.maxGross });
    const scale = opts.maxGross / requestedGross;
    for (const k of Object.keys(clipped)) clipped[k] = clipped[k]! * scale;
  }

  if (tree.isRevokedInChain(nodeName)) {
    violations.push({ kind: "REVOKED" });
    return { weights: {}, clipped, violations };
  }
  if (tree.isExpiredInChain(nodeName, opts.now)) {
    violations.push({ kind: "EXPIRED" });
    return { weights: {}, clipped, violations };
  }
  return { weights: clipped, clipped, violations };
}
