/**
 * Snapshot serialization.
 *
 * `toSnapshot` renders a `DelegationTree` (plus its event log) into the exact
 * JSON the web dashboard consumes. Every bigint amount becomes a decimal STRING
 * of smallest units, and derived fields (`reserved`, `available`) are computed
 * from the tree so the dashboard never has to.
 *
 * Each event also carries what replay needs (`grant`, `before`) and its
 * hash-chain link (`hash`), so the JSON alone rebuilds the tree:
 * `replaySnapshot` / `verifySnapshot` replay the events, check the chain, and
 * check that the nodes the snapshot shows are the nodes its log replays to.
 */

import { DelegationTree, ReplayError, type LogDiscrepancy } from "./tree";
import type {
  AllowanceEvent,
  EventGrant,
  Snapshot,
  SnapshotEvent,
  SnapshotGrant,
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

function serializeGrant(g: EventGrant): SnapshotGrant {
  const out: SnapshotGrant = {
    parent: g.parent,
    identityStatus: g.identityStatus,
    allowedMerchants: g.allowedMerchants === undefined ? null : [...g.allowedMerchants],
    allowedPurposes: g.allowedPurposes === undefined ? null : [...g.allowedPurposes],
    expiry: g.expiry,
  };
  if (g.principal !== undefined) out.principal = { name: g.principal.name, verified: g.principal.verified };
  return out;
}

function serializeEvent(e: AllowanceEvent): SnapshotEvent {
  const out: SnapshotEvent = {
    seq: e.seq,
    type: e.type,
    node: e.node,
    detail: e.detail,
    result: e.result,
    amount: e.amount === null ? null : e.amount.toString(),
    merchant: e.merchant,
  };
  // Present only when the event has them, so events without them serialize
  // exactly as before.
  if (e.grant !== undefined) out.grant = serializeGrant(e.grant);
  if (e.before !== undefined) out.before = e.before.toString();
  if (e.hash !== undefined) out.hash = e.hash;
  return out;
}

/** Build the snapshot JSON object from a tree. */
export function toSnapshot(tree: DelegationTree, opts: ToSnapshotOptions = {}): Snapshot {
  const asOf = opts.asOf ?? Math.floor(Date.now() / 1000);
  const events = opts.events ?? tree.events;
  const principal = tree.principal;

  const nodes: SnapshotNode[] = tree.listNodes().map((n) => {
    // Compute `reserved` once and derive `available` from the node already in
    // hand, rather than calling tree.available() (which would recompute
    // reserved() and re-do a requireNode map lookup). Byte-identical output.
    const reserved = tree.reserved(n.name);
    const available = n.mandate.budget - n.mandate.spentDirect - reserved;
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

/* ------------------------------------------------------------------ */
/* Reading a snapshot back: replay and verification                    */
/* ------------------------------------------------------------------ */

/** Thrown for a snapshot event whose fields are not the serialized shape. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

const DECIMAL = /^-?\d+$/;

function bigintField(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new SnapshotFormatError(`${path}: expected a decimal string`);
  return BigInt(v);
}

function listField(v: unknown, path: string): readonly string[] | undefined {
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new SnapshotFormatError(`${path}: expected string[] | null`);
  }
  return [...(v as string[])];
}

/**
 * One serialized event back to the in-memory event it was written from:
 * decimal strings to bigints, `null` allowlists to "any" (undefined). Fields
 * a snapshot does not carry stay absent, so replay reports what is missing.
 *
 * @throws SnapshotFormatError for a field that is not the serialized shape.
 */
export function fromSnapshotEvent(e: SnapshotEvent, path = "event"): AllowanceEvent {
  const out: AllowanceEvent = {
    seq: e.seq,
    type: e.type,
    node: e.node,
    detail: e.detail,
    result: e.result,
    amount: e.amount === null ? null : bigintField(e.amount, `${path}.amount`),
    merchant: e.merchant,
  };
  if (e.grant !== undefined) {
    const g = e.grant;
    if (typeof g !== "object" || g === null || typeof g.expiry !== "number") {
      throw new SnapshotFormatError(`${path}.grant: expected a serialized grant`);
    }
    const grant: EventGrant = { parent: g.parent, identityStatus: g.identityStatus, expiry: g.expiry };
    const merchants = listField(g.allowedMerchants, `${path}.grant.allowedMerchants`);
    const purposes = listField(g.allowedPurposes, `${path}.grant.allowedPurposes`);
    if (merchants !== undefined) grant.allowedMerchants = merchants;
    if (purposes !== undefined) grant.allowedPurposes = purposes;
    if (g.principal !== undefined) grant.principal = { name: g.principal.name, verified: g.principal.verified };
    out.grant = grant;
  }
  if (e.before !== undefined) out.before = bigintField(e.before, `${path}.before`);
  if (e.hash !== undefined) out.hash = e.hash;
  return out;
}

/** `fromSnapshotEvent` over a snapshot's whole log. */
export function fromSnapshotEvents(events: readonly SnapshotEvent[]): AllowanceEvent[] {
  return events.map((e, i) => fromSnapshotEvent(e, `events[${i}]`));
}

export interface VerifySnapshotOptions {
  /**
   * A head hash the reader already trusts (`DelegationTree.head` when the
   * log was written, published or countersigned elsewhere). Without it the
   * chain cannot tell a log cut short at its end, or rewritten with every
   * hash recomputed, from the original.
   */
  head?: string;
}

/**
 * Replay a snapshot's log and report every way the snapshot departs from it:
 *  - whatever replaying the events finds (BAD_EVENT for an event replay
 *    cannot apply, e.g. from a snapshot written before `grant`/`before` were
 *    serialized; LOG_REWRITTEN for a broken hash chain; see `LogDiscrepancy`);
 *  - LOG_REWRITTEN if `opts.head` is given and the log does not end there;
 *  - UNLOGGED_WRITE for any node field, node, node order or principal the
 *    snapshot shows that its own log does not replay to (a budget edited in
 *    the JSON, say, without a matching event).
 * Empty when the snapshot is exactly what its log says.
 *
 * @throws SnapshotFormatError for an event field that is not the serialized shape.
 */
export function verifySnapshot(snapshot: Snapshot, opts: VerifySnapshotOptions = {}): LogDiscrepancy[] {
  return replayAndCheck(snapshot, opts).discrepancies;
}

/**
 * Rebuild the `DelegationTree` a snapshot's JSON describes, from its event
 * log alone, after checking it as `verifySnapshot` does. The tree holds the
 * snapshot's events (hashes included), so it can be carried on: the next
 * event it records chains onto the snapshot's last.
 *
 * @throws ReplayError listing every discrepancy, if there is any.
 */
export function replaySnapshot(snapshot: Snapshot, opts: VerifySnapshotOptions = {}): DelegationTree {
  const { tree, discrepancies } = replayAndCheck(snapshot, opts);
  if (discrepancies.length > 0) throw new ReplayError(discrepancies);
  return tree;
}

function replayAndCheck(
  snapshot: Snapshot,
  opts: VerifySnapshotOptions,
): { tree: DelegationTree; discrepancies: LogDiscrepancy[] } {
  const { tree, discrepancies: out } = DelegationTree.replayLog(fromSnapshotEvents(snapshot.events));
  if (opts.head !== undefined && tree.head !== opts.head) {
    out.push({
      kind: "LOG_REWRITTEN",
      node: null,
      seq: null,
      message: `the log ends at hash ${tree.head}, not at the trusted head ${opts.head}: it was cut short or rewritten`,
    });
  }

  const unlogged = (node: string | null, message: string): void => {
    out.push({ kind: "UNLOGGED_WRITE", node, seq: null, message });
  };
  const replayed = toSnapshot(tree, { asOf: snapshot.asOf, decimals: snapshot.decimals, events: [] });
  const show = (p: { name: string; verified: boolean }) => `"${p.name}" (verified: ${p.verified})`;
  if (snapshot.principal.name !== replayed.principal.name || snapshot.principal.verified !== replayed.principal.verified) {
    unlogged(null, `the snapshot's principal is ${show(snapshot.principal)}, but its log says ${show(replayed.principal)}`);
  }
  const shown = new Map(snapshot.nodes.map((n) => [n.name, n]));
  const logged = new Map(replayed.nodes.map((n) => [n.name, n]));
  for (const name of shown.keys()) {
    if (!logged.has(name)) unlogged(name, `the snapshot shows "${name}", but its log never created it`);
  }
  for (const name of logged.keys()) {
    if (!shown.has(name)) unlogged(name, `the log created "${name}", but the snapshot does not show it`);
  }
  const shownOrder = snapshot.nodes.map((n) => n.name);
  const logOrder = replayed.nodes.map((n) => n.name);
  if (shownOrder.length === logOrder.length && shownOrder.some((n, i) => n !== logOrder[i])) {
    unlogged(null, "the snapshot shows its nodes in another order than its log created them");
  }
  const text = (v: unknown): string => JSON.stringify(v);
  for (const [name, is] of shown) {
    const says = logged.get(name);
    if (!says) continue;
    const field = (what: string, a: unknown, b: unknown): void => {
      if (text(a) !== text(b)) unlogged(name, `in the snapshot, ${what} of "${name}" is ${text(a)}, but its log says ${text(b)}`);
    };
    field("the parent", is.parent, says.parent);
    field("the identity status", is.identityStatus, says.identityStatus);
    for (const k of Object.keys(says.mandate) as (keyof SnapshotNode["mandate"])[]) {
      field(k, is.mandate[k], says.mandate[k]);
    }
  }
  return { tree, discrepancies: out };
}
