/**
 * The delegation tree.
 *
 * KEY INSIGHT: an ENS-style hierarchical name IS a delegation tree. A name like
 * `scraper.researcher.alice.eth` encodes who-is-boss-of-whom (left-most label is
 * the node itself), and each node carries its mandate. The tree enforces
 * attenuation on delegation, tracks reserved/available budget, supports
 * revocation, and keeps an ordered event log that the snapshot serializer reads.
 */

import {
  AttenuationError,
  checkAttenuation,
  type AttenuationDecision,
  type AttenuationRejectionReason,
} from "./attenuation";
import type {
  AgentNode,
  AllowanceEvent,
  IdentityStatus,
  MandateInput,
  Principal,
} from "./types";

/* ------------------------------------------------------------------ */
/* ENS-style name helpers                                             */
/* ------------------------------------------------------------------ */

/** Split a dotted name into labels, left-most first. */
export function labels(name: string): string[] {
  return name.split(".");
}

/** The left-most label (the node itself), e.g. "scraper". */
export function leftLabel(name: string): string {
  return labels(name)[0] ?? name;
}

/**
 * The structural parent name derived from the dotted name, or `null` if the name
 * is a single label. This is naming sugar; the tree stores explicit parent links.
 * @example parentNameOf("scraper.researcher.alice.eth") // "researcher.alice.eth"
 */
export function parentNameOf(name: string): string | null {
  const parts = labels(name);
  return parts.length <= 1 ? null : parts.slice(1).join(".");
}

/** Compose a child's full name from a parent name and a new left-most label. */
export function childName(parentName: string, childLabel: string): string {
  return `${childLabel}.${parentName}`;
}

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

export class UnknownNodeError extends Error {
  constructor(name: string) {
    super(`unknown node: "${name}"`);
    this.name = "UnknownNodeError";
  }
}

export class DuplicateNodeError extends Error {
  constructor(name: string) {
    super(`node already exists: "${name}"`);
    this.name = "DuplicateNodeError";
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                            */
/* ------------------------------------------------------------------ */

export interface FundRootOptions {
  /** Human principal identifier, e.g. "alice". */
  principal: string;
  /** Root agent name, e.g. "alice.eth". */
  rootName: string;
  /** Root mandate (budget/scope/expiry). */
  mandate: MandateInput;
  /** Whether the human passed IDKit. Defaults to true. */
  principalVerified?: boolean;
  /** Root agent's machine-identity status. Defaults to "verified". */
  identityStatus?: IdentityStatus;
}

export interface DelegateOptions {
  /** Child's machine-identity status. Defaults to "verified". */
  identityStatus?: IdentityStatus;
}

/* ------------------------------------------------------------------ */
/* DelegationTree                                                     */
/* ------------------------------------------------------------------ */

export class DelegationTree {
  private principal_: Principal | null = null;
  private readonly nodes_ = new Map<string, AgentNode>();
  /**
   * Parent-name → direct-children bucket index, maintained incrementally on every
   * node insertion (see `indexNode_`). This turns `childrenOf` into an O(1) map
   * lookup instead of an O(n) full-scan-and-filter, which matters because
   * `reserved()`/`available()` — and therefore the hot `delegate()`/attenuation
   * path and `toSnapshot()` (which calls both for every node) — depend on it. The
   * bucket holds live `AgentNode` references in insertion order; `childrenOf`
   * returns a defensive copy so callers can't corrupt the index.
   */
  private readonly childrenIndex_ = new Map<string | null, AgentNode[]>();
  private readonly events_: AllowanceEvent[] = [];
  private seq_ = 0;

  /** The human principal, or null before `fundRoot`. */
  get principal(): Principal | null {
    return this.principal_;
  }

  /** Ordered event log (live reference — treat as read-only). */
  get events(): readonly AllowanceEvent[] {
    return this.events_;
  }

  /** All nodes in insertion order. */
  listNodes(): AgentNode[] {
    return [...this.nodes_.values()];
  }

  /** Look up a node or return undefined. */
  getNode(name: string): AgentNode | undefined {
    return this.nodes_.get(name);
  }

  /** Look up a node or throw. */
  requireNode(name: string): AgentNode {
    const node = this.nodes_.get(name);
    if (!node) throw new UnknownNodeError(name);
    return node;
  }

  /**
   * Direct children of a node. O(1) lookup via `childrenIndex_`; returns a
   * defensive copy of the bucket so callers may freely mutate the result.
   */
  childrenOf(name: string): AgentNode[] {
    const bucket = this.childrenIndex_.get(name);
    return bucket ? [...bucket] : [];
  }

  /** Ancestors from the immediate parent up to the root. */
  ancestors(name: string): AgentNode[] {
    const chain: AgentNode[] = [];
    let current = this.nodes_.get(name);
    while (current && current.parent !== null) {
      const parent = this.nodes_.get(current.parent);
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /** Sum of direct children's budgets — authority already handed downward. */
  reserved(name: string): bigint {
    // Iterate the index bucket directly (read-only) to avoid the defensive copy
    // that `childrenOf` makes — keeps this O(children) with zero allocation.
    const bucket = this.childrenIndex_.get(name);
    if (!bucket) return 0n;
    let sum = 0n;
    for (const child of bucket) sum += child.mandate.budget;
    return sum;
  }

  /** budget - spentDirect - reserved. What this node can still delegate or spend. */
  available(name: string): bigint {
    const node = this.requireNode(name);
    return node.mandate.budget - node.mandate.spentDirect - this.reserved(name);
  }

  /**
   * True if this node or any ancestor is revoked. Walks parent pointers inline
   * rather than materializing an `ancestors()` array and calling `.some()`, so
   * external callers (e.g. SpendCapHook.checkFromTree) pay zero allocation cost.
   */
  isRevokedInChain(name: string): boolean {
    let current = this.nodes_.get(name);
    while (current) {
      if (current.mandate.revoked) return true;
      if (current.parent === null) break;
      current = this.nodes_.get(current.parent);
    }
    return false;
  }

  /**
   * True if this node or any ancestor is expired at `now` (unix seconds). Walks
   * parent pointers inline (no intermediate `ancestors()` array), matching
   * `isRevokedInChain`.
   */
  isExpiredInChain(name: string, now: number): boolean {
    let current = this.nodes_.get(name);
    while (current) {
      if (now > current.mandate.expiry) return true;
      if (current.parent === null) break;
      current = this.nodes_.get(current.parent);
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Insert a node into both the primary `nodes_` map and the `childrenIndex_`
   * bucket keyed by its parent. Single choke-point for node creation so the
   * index can never drift out of sync with the node map.
   */
  private indexNode_(node: AgentNode): void {
    this.nodes_.set(node.name, node);
    const bucket = this.childrenIndex_.get(node.parent);
    if (bucket) bucket.push(node);
    else this.childrenIndex_.set(node.parent, [node]);
  }

  /**
   * Establish the principal and fund the root agent. Records a FUND event.
   * The caller is responsible for having verified the principal via IDKit; pass
   * the result as `principalVerified`.
   */
  fundRoot(opts: FundRootOptions): AgentNode {
    if (this.principal_) {
      throw new Error("fundRoot: principal/root already established");
    }
    if (this.nodes_.has(opts.rootName)) {
      throw new DuplicateNodeError(opts.rootName);
    }

    this.principal_ = { name: opts.principal, verified: opts.principalVerified ?? true };

    const node: AgentNode = {
      name: opts.rootName,
      parent: null,
      identityStatus: opts.identityStatus ?? "verified",
      mandate: {
        budget: opts.mandate.budget,
        spentDirect: 0n,
        allowedMerchants: opts.mandate.allowedMerchants,
        allowedPurposes: opts.mandate.allowedPurposes,
        expiry: opts.mandate.expiry,
        revoked: false,
      },
    };
    this.indexNode_(node);

    this.recordEvent({
      type: "FUND",
      node: node.name,
      detail: `principal "${opts.principal}" funded root with budget ${opts.mandate.budget}`,
      result: "OK",
      amount: opts.mandate.budget,
      merchant: null,
    });

    return node;
  }

  /**
   * Delegate a mandate from `parentName` to a new child labelled `childLabel`.
   * Enforces attenuation. On success creates the child and records a DELEGATE/OK
   * event. On failure records a DELEGATE/ATTENUATION_REJECTED event and throws
   * `AttenuationError` — so a rejected attempt is still visible in the snapshot.
   */
  delegate(
    parentName: string,
    childLabel: string,
    mandate: MandateInput,
    opts: DelegateOptions = {},
  ): AgentNode {
    const parent = this.requireNode(parentName);
    const fullName = childName(parentName, childLabel);
    if (this.nodes_.has(fullName)) {
      throw new DuplicateNodeError(fullName);
    }

    const decision: AttenuationDecision = checkAttenuation(
      parent,
      mandate,
      this.available(parentName),
    );

    if (!decision.ok) {
      this.recordEvent({
        type: "DELEGATE",
        node: fullName,
        detail: `attenuation rejected (${decision.reason}): ${decision.message}`,
        result: "ATTENUATION_REJECTED",
        amount: mandate.budget,
        merchant: null,
      });
      throw new AttenuationError(decision.reason, decision.message);
    }

    const node: AgentNode = {
      name: fullName,
      parent: parentName,
      identityStatus: opts.identityStatus ?? "verified",
      mandate: {
        budget: mandate.budget,
        spentDirect: 0n,
        allowedMerchants: mandate.allowedMerchants,
        allowedPurposes: mandate.allowedPurposes,
        expiry: mandate.expiry,
        revoked: false,
      },
    };
    this.indexNode_(node);

    this.recordEvent({
      type: "DELEGATE",
      node: node.name,
      detail: `${parentName} delegated budget ${mandate.budget} to ${childLabel}`,
      result: "OK",
      amount: mandate.budget,
      merchant: null,
    });

    return node;
  }

  /**
   * Revoke a node. Sets `revoked = true`; every descendant's payments then fail
   * the ancestor-revoked check. Records a REVOKE event.
   */
  revoke(name: string): AgentNode {
    const node = this.requireNode(name);
    node.mandate.revoked = true;
    this.recordEvent({
      type: "REVOKE",
      node: name,
      detail: `mandate for "${name}" revoked; all descendants disabled`,
      result: "REVOKED",
      amount: null,
      merchant: null,
    });
    return node;
  }

  /**
   * Change a live node's budget in place — the allocator's lever.
   *
   * Shrinking is always attenuation-safe as long as the new budget still covers
   * what the node has already committed (its own spend plus the budgets it has
   * handed to its children); cutting below that would leave children holding
   * authority their parent no longer has, so it is rejected (BELOW_COMMITTED).
   * Growing takes the extra slice from the parent's *available* budget, exactly
   * like a fresh delegation (BUDGET_EXCEEDS_AVAILABLE otherwise). The root has
   * no parent to draw from, so it can only shrink. A revoked node (or one under
   * a revoked ancestor) cannot be resized — revocation is final.
   *
   * Success records RESIZE / OK. Failure records RESIZE / ATTENUATION_REJECTED
   * and throws `AttenuationError`, mirroring `delegate`.
   */
  resize(name: string, newBudget: bigint): AgentNode {
    const node = this.requireNode(name);
    const oldBudget = node.mandate.budget;
    const reject = (reason: AttenuationRejectionReason, message: string): never => {
      this.recordEvent({
        type: "RESIZE",
        node: name,
        detail: `resize rejected (${reason}): ${message}`,
        result: "ATTENUATION_REJECTED",
        amount: newBudget,
        merchant: null,
      });
      throw new AttenuationError(reason, message);
    };

    if (newBudget < 0n) reject("NEGATIVE_BUDGET", `budget must be >= 0, got ${newBudget}`);
    if (this.isRevokedInChain(name)) {
      reject("PARENT_REVOKED", `"${name}" or an ancestor is revoked; resize refused`);
    }
    const committed = node.mandate.spentDirect + this.reserved(name);
    if (newBudget < committed) {
      reject("BELOW_COMMITTED", `budget ${newBudget} is below committed ${committed} (spent + delegated)`);
    }
    if (newBudget > oldBudget) {
      const growth = newBudget - oldBudget;
      if (node.parent === null) {
        reject("BUDGET_EXCEEDS_AVAILABLE", `root "${name}" has no parent to draw ${growth} from`);
      } else {
        const parentAvailable = this.available(node.parent);
        if (growth > parentAvailable) {
          reject(
            "BUDGET_EXCEEDS_AVAILABLE",
            `growth ${growth} exceeds parent "${node.parent}" available ${parentAvailable}`,
          );
        }
      }
    }

    node.mandate.budget = newBudget;
    this.recordEvent({
      type: "RESIZE",
      node: name,
      detail: `budget of "${name}" resized ${oldBudget} -> ${newBudget}`,
      result: "OK",
      amount: newBudget,
      merchant: null,
    });
    return node;
  }

  /**
   * Append an event to the log, assigning the next sequence number. Used
   * internally and by the payment pipeline; orchestrators may also use it to
   * record custom events into the same ordered stream.
   */
  recordEvent(event: Omit<AllowanceEvent, "seq">): AllowanceEvent {
    const full: AllowanceEvent = { seq: this.seq_++, ...event };
    this.events_.push(full);
    return full;
  }

  /** The next sequence number that would be assigned. */
  get nextSeq(): number {
    return this.seq_;
  }
}
