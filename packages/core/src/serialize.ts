/**
 * Snapshot serialization.
 *
 * `toSnapshot` renders a `DelegationTree` (plus its event log) into the exact
 * JSON the web dashboard consumes. Every bigint amount becomes a decimal STRING
 * of smallest units, and derived fields (`reserved`, `available`) are computed
 * from the tree so the dashboard never has to.
 */

import type { DelegationTree } from "./tree";
import type {
  AllowanceEvent,
  Snapshot,
  SnapshotEvent,
  SnapshotNode,
} from "./types";
import { USDC_DECIMALS } from "./amount";

export interface ToSnapshotOptions {
  /** `asOf` timestamp (unix seconds). Defaults to now. */
  asOf?: number;
  /** Event list to serialize. Defaults to the tree's own event log. */
  events?: readonly AllowanceEvent[];
  /** Token decimals. Defaults to 6 (USDC). */
  decimals?: number;
}

function serializeEvent(e: AllowanceEvent): SnapshotEvent {
  return {
    seq: e.seq,
    type: e.type,
    node: e.node,
    detail: e.detail,
    result: e.result,
    amount: e.amount === null ? null : e.amount.toString(),
    merchant: e.merchant,
  };
}

/** Build the snapshot JSON object from a tree. */
export function toSnapshot(tree: DelegationTree, opts: ToSnapshotOptions = {}): Snapshot {
  const asOf = opts.asOf ?? Math.floor(Date.now() / 1000);
  const events = opts.events ?? tree.events;
  const principal = tree.principal;

  const nodes: SnapshotNode[] = tree.listNodes().map((n) => {
    const reserved = tree.reserved(n.name);
    const available = tree.available(n.name);
    return {
      name: n.name,
      parent: n.parent,
      identityStatus: n.identityStatus,
      mandate: {
        budget: n.mandate.budget.toString(),
        spentDirect: n.mandate.spentDirect.toString(),
        reserved: reserved.toString(),
        available: available.toString(),
        allowedMerchants: n.mandate.allowedMerchants ?? null,
        allowedPurposes: n.mandate.allowedPurposes ?? null,
        expiry: n.mandate.expiry,
        revoked: n.mandate.revoked,
      },
    };
  });

  return {
    asOf,
    currency: "USDC",
    decimals: opts.decimals ?? USDC_DECIMALS,
    principal: principal
      ? { name: principal.name, verified: principal.verified }
      : { name: "", verified: false },
    nodes,
    events: events.map(serializeEvent),
  };
}

/** Serialize a snapshot to pretty JSON. */
export function snapshotToJSON(snapshot: Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Convenience: build a snapshot and write it to disk (used by the orchestrator to
 * emit apps/web/public/demo-snapshot.json). Uses node's fs; kept out of the pure
 * modules so the rest of core has zero I/O.
 */
export async function writeSnapshotFile(
  tree: DelegationTree,
  filePath: string,
  opts: ToSnapshotOptions = {},
): Promise<Snapshot> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const snapshot = toSnapshot(tree, opts);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, snapshotToJSON(snapshot) + "\n", "utf8");
  return snapshot;
}
