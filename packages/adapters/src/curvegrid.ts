/**
 * Curvegrid MultiBaas — the spend-tree dashboard + on-chain-reader AI angle.
 *
 * Turns a `Snapshot` (the one artifact the web app reads) into dashboard-ready
 * view models: a flattened spend tree with per-node utilization, portfolio
 * totals, and a normalized event feed. Also exposes a mock "read chain activity"
 * helper that synthesizes MultiBaas-style on-chain events from the snapshot — the
 * Curvegrid AI-agent angle ("an agent that reads chain state and explains it").
 *
 * Sponsor: Curvegrid ($1k x3) — AI agent reads chain state + a MultiBaas-style
 * dashboard visualizing the spend tree. Docs:
 *   https://docs.curvegrid.com/multibaas/  (MultiBaas REST API + event queries)
 *
 * Ships:
 *   - `MultiBaasDashboard`  offline view-model builder + mock chain reader (demo)
 *   - `MultiBaasClient`     real-integration stub (TODO(cred))
 */

import type {
  IdentityStatus,
  Snapshot,
  SnapshotEvent,
} from "@allowance/core";
import { formatAmount, isFailureResult, leftLabel } from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** One node rendered for the spend-tree view. */
export interface SpendTreeNodeVM {
  name: string;
  label: string;
  parent: string | null;
  /** Depth from the root (root = 0). */
  depth: number;
  identityStatus: IdentityStatus;
  revoked: boolean;
  expiry: number;
  /** Smallest-unit strings (as in the snapshot). */
  budget: string;
  spentDirect: string;
  reserved: string;
  available: string;
  /** Human decimal strings for display (e.g. "30.000000"). */
  budgetHuman: string;
  spentDirectHuman: string;
  reservedHuman: string;
  availableHuman: string;
  /** (spentDirect + reserved) / budget, 0..1, rounded to 4 dp. 0 when budget=0. */
  utilization: number;
  allowedMerchants: string[] | null;
  allowedPurposes: string[] | null;
  childNames: string[];
}

/** Aggregate totals across the whole tree. */
export interface DashboardTotals {
  nodeCount: number;
  rootBudget: string;
  rootBudgetHuman: string;
  totalSpent: string;
  totalSpentHuman: string;
  paymentCount: number;
  settledCount: number;
  blockedCount: number;
}

/** A normalized event row for the activity feed. */
export interface EventVM {
  seq: number;
  type: SnapshotEvent["type"];
  node: string;
  detail: string;
  result: SnapshotEvent["result"];
  amount: string | null;
  amountHuman: string | null;
  merchant: string | null;
  /** True for a terminal-failure result (denied/blocked/revoked/rejected). */
  failed: boolean;
}

/** The full dashboard view model the web app / a Curvegrid agent can render. */
export interface DashboardViewModel {
  asOf: number;
  currency: string;
  decimals: number;
  principal: { name: string; verified: boolean };
  totals: DashboardTotals;
  tree: SpendTreeNodeVM[];
  events: EventVM[];
}

/** A synthesized MultiBaas-style on-chain event (mock chain reader output). */
export interface ChainActivityEntry {
  seq: number;
  /** Contract event name the on-chain settlement/hook would have emitted. */
  event: "Funded" | "Delegated" | "Settled" | "Blocked" | "Revoked";
  node: string;
  merchant: string | null;
  amount: string | null;
  /** Deterministic pseudo tx hash (mock). */
  txHash: string;
  /** Monotonic mock block number. */
  blockNumber: number;
}

/**
 * Offline MultiBaas dashboard builder + mock chain reader. Pure functions over a
 * `Snapshot`; no I/O, fully deterministic.
 */
export class MultiBaasDashboard {
  private readonly decimals: number;

  constructor(decimals?: number) {
    this.decimals = decimals ?? 6;
  }

  /** Build the complete dashboard view model from a snapshot. */
  build(snapshot: Snapshot): DashboardViewModel {
    return {
      asOf: snapshot.asOf,
      currency: snapshot.currency,
      decimals: snapshot.decimals,
      principal: snapshot.principal,
      totals: this.totals(snapshot),
      tree: this.toSpendTree(snapshot),
      events: snapshot.events.map((e) => this.toEventVM(e, snapshot.decimals)),
    };
  }

  /** Flatten nodes into a depth-annotated spend tree (roots first, DFS order). */
  toSpendTree(snapshot: Snapshot): SpendTreeNodeVM[] {
    const dec = snapshot.decimals;
    const childrenOf = new Map<string | null, typeof snapshot.nodes>();
    for (const n of snapshot.nodes) {
      const bucket = childrenOf.get(n.parent) ?? [];
      bucket.push(n);
      childrenOf.set(n.parent, bucket);
    }

    const vmOf = (name: string): string[] =>
      (childrenOf.get(name) ?? []).map((c) => c.name);

    const out: SpendTreeNodeVM[] = [];
    const visit = (parent: string | null, depth: number): void => {
      for (const n of childrenOf.get(parent) ?? []) {
        const m = n.mandate;
        const budget = BigInt(m.budget);
        const usedNum = BigInt(m.spentDirect) + BigInt(m.reserved);
        const utilization =
          budget === 0n ? 0 : Math.round((Number(usedNum) / Number(budget)) * 10000) / 10000;
        out.push({
          name: n.name,
          label: leftLabel(n.name),
          parent: n.parent,
          depth,
          identityStatus: n.identityStatus,
          revoked: m.revoked,
          expiry: m.expiry,
          budget: m.budget,
          spentDirect: m.spentDirect,
          reserved: m.reserved,
          available: m.available,
          budgetHuman: formatAmount(budget, dec),
          spentDirectHuman: formatAmount(BigInt(m.spentDirect), dec),
          reservedHuman: formatAmount(BigInt(m.reserved), dec),
          availableHuman: formatAmount(BigInt(m.available), dec),
          utilization,
          allowedMerchants: m.allowedMerchants,
          allowedPurposes: m.allowedPurposes,
          childNames: vmOf(n.name),
        });
        visit(n.name, depth + 1);
      }
    };
    visit(null, 0);
    return out;
  }

  /** Portfolio totals across the tree. */
  totals(snapshot: Snapshot): DashboardTotals {
    const dec = snapshot.decimals;
    const roots = snapshot.nodes.filter((n) => n.parent === null);
    const rootBudget = roots.reduce((s, n) => s + BigInt(n.mandate.budget), 0n);
    const totalSpent = snapshot.nodes.reduce((s, n) => s + BigInt(n.mandate.spentDirect), 0n);
    const payments = snapshot.events.filter((e) => e.type === "PAYMENT");
    const settled = payments.filter((e) => e.result === "SETTLED").length;
    return {
      nodeCount: snapshot.nodes.length,
      rootBudget: rootBudget.toString(),
      rootBudgetHuman: formatAmount(rootBudget, dec),
      totalSpent: totalSpent.toString(),
      totalSpentHuman: formatAmount(totalSpent, dec),
      paymentCount: payments.length,
      settledCount: settled,
      blockedCount: payments.length - settled,
    };
  }

  private toEventVM(e: SnapshotEvent, decimals: number): EventVM {
    return {
      seq: e.seq,
      type: e.type,
      node: e.node,
      detail: e.detail,
      result: e.result,
      amount: e.amount,
      amountHuman: e.amount === null ? null : formatAmount(BigInt(e.amount), decimals),
      merchant: e.merchant,
      failed: isFailureResult(e.result),
    };
  }

  /**
   * Mock "read chain activity": synthesize the MultiBaas-style on-chain event
   * stream a Curvegrid AI agent would query, derived deterministically from the
   * snapshot's events. In production this would be a MultiBaas event query
   * against the deployed settlement/hook contracts.
   */
  readChainActivity(snapshot: Snapshot): ChainActivityEntry[] {
    const map: Record<SnapshotEvent["type"], ChainActivityEntry["event"]> = {
      FUND: "Funded",
      DELEGATE: "Delegated",
      PAYMENT: "Settled",
      REVOKE: "Revoked",
    };
    const baseBlock = 8_000_000;
    return snapshot.events.map((e, i) => {
      const failed = isFailureResult(e.result);
      const event: ChainActivityEntry["event"] =
        e.type === "PAYMENT" && failed ? "Blocked" : map[e.type];
      return {
        seq: e.seq,
        event,
        node: e.node,
        merchant: e.merchant,
        amount: e.amount,
        txHash: pseudoTxHash(e.seq, e.node, e.detail),
        blockNumber: baseBlock + i,
      };
    });
  }

  /**
   * A short natural-language summary of the spend tree — the "AI agent that reads
   * chain state and explains it" deliverable, kept fully deterministic/offline.
   */
  summarize(snapshot: Snapshot): string {
    const t = this.totals(snapshot);
    const revoked = snapshot.nodes.filter((n) => n.mandate.revoked).map((n) => n.name);
    const lines = [
      `Principal "${snapshot.principal.name}" is ${snapshot.principal.verified ? "verified" : "UNVERIFIED"}.`,
      `${t.nodeCount} agent node(s); root budget ${t.rootBudgetHuman} ${snapshot.currency}, ` +
        `${t.totalSpentHuman} spent directly across the tree.`,
      `${t.paymentCount} payment attempt(s): ${t.settledCount} settled, ${t.blockedCount} blocked/denied.`,
      revoked.length ? `Revoked node(s): ${revoked.join(", ")}.` : `No nodes revoked.`,
    ];
    return lines.join(" ");
  }
}

/** Deterministic pseudo tx hash for the mock chain reader. */
function pseudoTxHash(seq: number, node: string, detail: string): string {
  const seed = `${seq}|${node}|${detail}`;
  let h = 0x811c9dc5;
  let out = "";
  for (let b = 0; b < 32; b++) {
    h ^= seed.charCodeAt((b * 5 + seq) % seed.length) + b;
    h = Math.imul(h, 0x01000193) >>> 0;
    out += (h & 0xff).toString(16).padStart(2, "0");
  }
  return "0x" + out;
}

/**
 * Real Curvegrid MultiBaas client (integration stub).
 *
 * PRODUCTION FLOW:
 *   - Deploy the settlement/hook contracts and link them in MultiBaas.
 *   - `readChainActivity` => MultiBaas event-query API for the contract's
 *     Funded/Delegated/Settled/Revoked events.
 *   - The dashboard reads those normalized events (plus current on-chain mandate
 *     state) instead of the local snapshot.
 *
 * TODO(cred): set `baseUrl` (your MultiBaas deployment) + `apiKey` and implement
 *   the event query. Docs: https://docs.curvegrid.com/multibaas/
 */
export interface MultiBaasConfig {
  /** MultiBaas deployment base URL. TODO(cred). */
  baseUrl?: string;
  /** MultiBaas API key (JWT). TODO(cred). */
  apiKey?: string;
  /** Contract label registered in MultiBaas. TODO(cred). */
  contractLabel?: string;
}

export class MultiBaasClient {
  constructor(private readonly config: MultiBaasConfig = {}) {}

  async readChainActivity(): Promise<ChainActivityEntry[]> {
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new AdapterNotConfiguredError(
        "Curvegrid MultiBaas",
        "See https://docs.curvegrid.com/multibaas/",
      );
    }
    // TODO(cred): GET /api/v0/chains/ethereum/addresses/{label}/events ...
    throw new AdapterNotConfiguredError("Curvegrid MultiBaas", "event query not implemented.");
  }
}
