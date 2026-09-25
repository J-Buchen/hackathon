/**
 * Snapshot schema consumed by the dashboard.
 *
 * This mirrors §7 of DESIGN.md exactly. The orchestrator writes this file to
 * `apps/web/public/demo-snapshot.json`; the web app only ever *reads* it.
 *
 * IMPORTANT: all amounts are decimal STRINGS of smallest-unit integers
 * (USDC has 6 decimals, so "100000000" = 100 USDC). Allowlists are `null`
 * when unrestricted (meaning "any").
 */

export type IdentityStatus = "verified" | "expired" | "none";

export type EventType = "FUND" | "DELEGATE" | "PAYMENT" | "REVOKE" | "RESIZE";

export type EventResult =
  | "OK"
  | "SETTLED"
  | "BLOCKED_MANDATE"
  | "BLOCKED_SCREENING"
  | "DENIED_IDENTITY"
  | "REVOKED"
  | "ATTENUATION_REJECTED";

export interface SnapshotMandate {
  /** Total delegated budget, smallest-unit string. */
  budget: string;
  /** Amount this node has spent directly (not via children), smallest-unit string. */
  spentDirect: string;
  /** Sum of children's budgets (derived), smallest-unit string. */
  reserved: string;
  /** budget − spentDirect − reserved (derived), smallest-unit string. */
  available: string;
  /** null = any merchant allowed. */
  allowedMerchants: string[] | null;
  /** null = any purpose allowed. */
  allowedPurposes: string[] | null;
  /** Unix seconds. */
  expiry: number;
  revoked: boolean;
}

export interface SnapshotNode {
  /** ENS-style dotted name; the left-most label is the node itself. */
  name: string;
  /** Parent node name, or null for the root. */
  parent: string | null;
  identityStatus: IdentityStatus;
  mandate: SnapshotMandate;
}

export interface SnapshotEvent {
  seq: number;
  type: EventType;
  node: string;
  detail: string;
  result: EventResult;
  /** Smallest-unit string, or null for non-monetary events. */
  amount: string | null;
  merchant: string | null;
}

export interface Snapshot {
  /** Unix seconds. */
  asOf: number;
  currency: string;
  decimals: number;
  principal: { name: string; verified: boolean };
  nodes: SnapshotNode[];
  events: SnapshotEvent[];
}
