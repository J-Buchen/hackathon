/**
 * Pre-trade gate: the per-agent guardrail. It reads the agent's node in the
 * mandate tree and clips a proposed book to what the mandate allows:
 *
 *  - instruments   the node's allowlist (the tree's `allowedMerchants`, read as
 *                  "tradeable instruments"; attenuation already guarantees it is
 *                  a subset of the pod's and the fund's lists)
 *  - gross         at most `maxGross` × capital
 *  - liveness      a revoked or expired node (or ancestor) trades nothing
 *  - size          `sizeOrder` turns the clipped weights into notional from the
 *                  node's AVAILABLE authority in the tree (its budget, minus
 *                  what it has spent itself, minus what it has handed down to
 *                  sub-mandates) × leverage. The tree, not the book's own
 *                  accounting, decides how much an agent can put at risk: a
 *                  slice reserved for a sub-mandate is not also trading
 *                  capital, and a closed mandate (available 0) trades nothing.
 *
 * This is the table-stakes layer every agent-trading product ships. It is
 * necessary and it is not enough: every check here looks at ONE agent. The
 * center book (allocator.ts / book.ts) is what looks across all of them.
 */

import { formatAmount, type DelegationTree } from "@allowance/core";
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

/* ------------------------------------------------------------------ */
/* Size: the reservation is the binding limit                         */
/* ------------------------------------------------------------------ */

/** One agent's order for one tick: its gated weights, sized from its mandate. */
export interface SizedOrder {
  /** Full node name of the agent. */
  node: string;
  /**
   * USDC the order is sized on: the mandate's AVAILABLE authority when it was
   * sized (0 when the node or an ancestor is revoked or expired).
   */
  authority: number;
  /** Gross leverage the authority is run at. */
  leverage: number;
  /** Signed weights (Σ|w| ≤ the gate's `maxGross`); empty when the mandate is dead. */
  weights: Weights;
}

export interface SizeOptions {
  /** Gross leverage: notional = authority × leverage × weight. */
  leverage: number;
  /** Evaluation time in unix seconds, for expiry. */
  now: number;
}

/**
 * Size an agent's gated weights from the tree: notional = available × leverage
 * × weight, where available = budget − own spend − handed down. Nothing the
 * caller believes about the agent's capital enters: the only number that sizes
 * the trade is read from the agent's mandate at the moment of sizing. A revoked
 * or expired mandate (or ancestor) is sized at zero, with no weights.
 */
export function sizeOrder(tree: DelegationTree, nodeName: string, weights: Weights, opts: SizeOptions): SizedOrder {
  if (tree.isRevokedInChain(nodeName) || tree.isExpiredInChain(nodeName, opts.now)) {
    return { node: nodeName, authority: 0, leverage: opts.leverage, weights: {} };
  }
  const available = tree.available(nodeName);
  return {
    node: nodeName,
    authority: available > 0n ? Number(formatAmount(available)) : 0,
    leverage: opts.leverage,
    weights: { ...weights },
  };
}

/** Signed notional (USDC) per instrument: authority × leverage × weight. */
export function orderNotional(order: SizedOrder): Weights {
  const out: Weights = {};
  for (const [k, w] of Object.entries(order.weights)) out[k] = order.authority * order.leverage * w;
  return out;
}

/** Σ |notional|: the gross exposure (USDC) the order puts on. */
export function grossNotional(order: SizedOrder): number {
  let gross = 0;
  for (const n of Object.values(orderNotional(order))) gross += Math.abs(n);
  return gross;
}

/** What the order earns (USDC) on one tick's returns: authority × Σ leverage × w × r. */
export function orderPnl(order: SizedOrder, returns: Readonly<Record<string, number>>): number {
  let perUnit = 0;
  for (const [k, w] of Object.entries(order.weights)) perUnit += order.leverage * w * (returns[k] ?? 0);
  return order.authority * perUnit;
}
