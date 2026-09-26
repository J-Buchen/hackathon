/**
 * The event log's hash chain.
 *
 * Every event `recordEvent` appends carries `hash = SHA-256(canonical(prev,
 * event))`, where `prev` is the hash of the event before it (`GENESIS_HASH`
 * for the first) and `canonical` is a fixed-order JSON array of every field
 * the event carries: seq, type, node, detail, result, amount, merchant, the
 * grant (parent, identity, allowlists, expiry, principal) and the budget
 * before a resize. Bigints enter as decimal strings and an absent field as
 * null, so the hash of an event read back from snapshot JSON is the hash of
 * the event the tree recorded.
 *
 * What it makes evident: an event edited, removed, inserted or reordered
 * anywhere before the end of a log breaks the chain at that point
 * (`DelegationTree.verifyAgainstLog`, `DelegationTree.replay`,
 * `verifySnapshot`), unless every hash after it is recomputed too.
 *
 * What it does NOT stop:
 *  - it is unkeyed: anyone holding the log can recompute the whole chain
 *    after an edit. It is tamper-evident only against a head hash
 *    (`DelegationTree.head`) the reader already trusts, e.g. one published
 *    or countersigned when the log was written (`verifySnapshot`'s `head`);
 *  - without such an anchor, dropping events from the END of a log leaves a
 *    valid (shorter) chain;
 *  - anyone with API access can still append a forged event through the
 *    public `recordEvent`: it is chained like any other, so the chain proves
 *    the order and integrity of what was recorded, not who recorded it or
 *    that it was true (the replay still holds the tree to it, and `audit()`
 *    still holds the tree to its invariants).
 */

import { sha256Hex } from "./sha256";
import type { AllowanceEvent } from "./types";

/** The `prev` of the first event in a log. */
export const GENESIS_HASH = "0".repeat(64);

/** The fields an event's hash covers, in a fixed order (see the module doc). */
function canonical(prev: string, e: AllowanceEvent): string {
  const g = e.grant;
  return JSON.stringify([
    prev,
    e.seq,
    e.type,
    e.node,
    e.detail,
    e.result,
    e.amount === null ? null : e.amount.toString(),
    e.merchant,
    g === undefined
      ? null
      : [
          g.parent,
          g.identityStatus,
          g.allowedMerchants ?? null,
          g.allowedPurposes ?? null,
          g.expiry,
          g.principal === undefined ? null : [g.principal.name, g.principal.verified],
        ],
    e.before === undefined ? null : e.before.toString(),
  ]);
}

/** The hash an event recorded after an event hashed `prev` must carry. */
export function eventHash(prev: string, e: AllowanceEvent): string {
  return sha256Hex(canonical(prev, e));
}
