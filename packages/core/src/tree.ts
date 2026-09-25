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
  isAllowlistSubset,
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
/* Invariants                                                         */
/* ------------------------------------------------------------------ */

/**
 * A broken standing invariant of the tree (see `DelegationTree.audit`):
 *  - OVER_COMMITTED  spentDirect + Σ children's budgets > budget, i.e. the node
 *                    handed down or spent more than it holds (available < 0)
 *  - NEGATIVE_BUDGET a budget below zero
 *  - NOT_ATTENUATED  a child's merchants/purposes/expiry broaden its parent's
 *  - BROKEN_LINK     a node whose parent is not in the tree
 */
export type TreeViolationKind = "OVER_COMMITTED" | "NEGATIVE_BUDGET" | "NOT_ATTENUATED" | "BROKEN_LINK";

export interface TreeViolation {
  kind: TreeViolationKind;
  node: string;
  message: string;
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

    // A revoked ANCESTOR kills the parent too (checkAttenuation only sees the
    // parent itself): nothing new is ever minted inside a dead subtree.
    const deadAbove = !parent.mandate.revoked && this.isRevokedInChain(parentName);
    const decision: AttenuationDecision = deadAbove
      ? {
          ok: false,
          reason: "PARENT_REVOKED",
          message: `an ancestor of "${parentName}" is revoked; it cannot delegate`,
        }
      : checkAttenuation(parent, mandate, this.available(parentName));

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
   * Close a mandate: give back everything its subtree has not spent, then
   * revoke it. Returns the authority freed back to the parent (or, for the
   * root, back to the principal) as a bigint.
   *
   * Order of operations (synchronous, so no pay() budget check interleaves;
   * a settlement already awaiting inside pay() can still land afterwards, so
   * queue close() with payments via SerializedPayer when they are live):
   *   1. Every descendant, DEEPEST FIRST, is shrunk to what its whole subtree
   *      actually spent: its own `spentDirect` plus everything spent under
   *      each of its children. A leaf therefore ends at exactly what it spent.
   *   2. The node itself is shrunk the same way, so its budget ends equal to
   *      the total spent anywhere in its subtree.
   *   3. The node is revoked; descendants then fail `pay()` with REVOKED (and
   *      have 0 available anyway).
   *
   * Budgets only ever shrink. If a descendant overspent its budget (possible
   * only when unserialized concurrent pay() calls both passed the budget check),
   * it keeps its budget, and its ancestors count what it really spent, not its
   * budget: a parent is never shrunk below what its subtree spent, so close()
   * cannot turn a local overspend into extra authority for the grandparent.
   *
   * `freed = budgetBefore(name) - budgetAfter(name)`, which is exactly how much
   * the parent's `available()` rises. Descendant shrinks flow up into the
   * node's own budget before it is shrunk, so they are included in `freed`.
   *
   * Events: one RESIZE / OK per node whose budget actually changed (deepest
   * first), then one REVOKE / REVOKED for the node carrying `freed` as its
   * amount. Shrinking to the committed amount can never violate attenuation,
   * so unlike `resize()` it also applies to descendants that were revoked
   * individually earlier — their dead, unspent authority is reclaimed too.
   *
   * Idempotent: closing an already-closed node frees 0n and records nothing.
   * A node that was revoked (but not closed) can still be closed to reclaim
   * its unspent budget; it is not revoked a second time.
   *
   * @throws UnknownNodeError for a name that is not in the tree.
   */
  close(name: string): bigint {
    const node = this.requireNode(name);
    const before = node.mandate.budget;

    // Post-order walk: children are settled before their parent. Returns what
    // the subtree under `current` (itself included) actually spent.
    const shrinkSubtree = (current: AgentNode): bigint => {
      let spent = current.mandate.spentDirect;
      const bucket = this.childrenIndex_.get(current.name);
      // A child's own budget can be BELOW what its subtree spent (it overspent
      // and was left at its budget), so count the spend, not the budget.
      if (bucket) for (const child of bucket) spent += shrinkSubtree(child);
      const old = current.mandate.budget;
      // Only ever shrink. spent > old only arises when unserialized concurrent
      // pay() calls overspent a node (see SerializedPayer in
      // @allowance/adapters); growing here would hand out authority the parent
      // never granted.
      if (spent >= old) return spent;
      current.mandate.budget = spent;
      this.recordEvent({
        type: "RESIZE",
        node: current.name,
        detail: `close("${name}"): budget of "${current.name}" shrunk ${old} -> ${spent} (what its subtree spent)`,
        result: "OK",
        amount: spent,
        merchant: null,
      });
      return spent;
    };
    shrinkSubtree(node);

    const freed = before - node.mandate.budget;
    if (!node.mandate.revoked) {
      node.mandate.revoked = true;
      const to = node.parent === null ? "the principal" : `"${node.parent}"`;
      this.recordEvent({
        type: "REVOKE",
        node: name,
        detail: `mandate for "${name}" closed: subtree kept ${node.mandate.budget} spent, freed ${freed} back to ${to}; all descendants disabled`,
        result: "REVOKED",
        amount: freed,
        merchant: null,
      });
    }
    return freed;
  }

  /* ---------------------------------------------------------------- */
  /* Subtrees and invariants                                          */
  /* ---------------------------------------------------------------- */

  /** The node and every descendant, each parent before its children. */
  subtree(name: string): AgentNode[] {
    const out: AgentNode[] = [];
    const walk = (node: AgentNode): void => {
      out.push(node);
      const bucket = this.childrenIndex_.get(node.name);
      if (bucket) for (const child of bucket) walk(child);
    };
    walk(this.requireNode(name));
    return out;
  }

  /** Everything spent anywhere in the node's subtree, its own spend included. */
  spentInSubtree(name: string): bigint {
    let spent = 0n;
    for (const node of this.subtree(name)) spent += node.mandate.spentDirect;
    return spent;
  }

  /**
   * True when `name` is revoked AND nothing in its subtree still holds unspent
   * authority (every node's `available` ≤ 0) — the state `close()` leaves. A
   * node that was only `revoke()`d still strands its unspent budget (dead
   * authority its parent cannot reuse), so it is not closed.
   */
  isClosed(name: string): boolean {
    if (!this.requireNode(name).mandate.revoked) return false;
    return this.subtree(name).every((node) => this.available(node.name) <= 0n);
  }

  /**
   * Check the tree's standing invariants and return every violation (empty
   * when the tree is sound). `delegate`, `resize` and `close` preserve all of
   * them on their own; the audit is for callers that want the guarantee
   * checked rather than assumed (the swarm book runs it every tick), and it
   * catches what the API cannot prevent: an overspend by unserialized
   * concurrent `pay()` calls, or a caller writing to a node object directly.
   *
   *  - reservation: spentDirect + Σ children's budgets ≤ budget for every node
   *    (children ≤ parent, available ≥ 0), and no budget is negative;
   *  - attenuation: every child's merchants, purposes and expiry are within
   *    its parent's;
   *  - structure: every non-root node's parent exists.
   */
  audit(): TreeViolation[] {
    const out: TreeViolation[] = [];
    for (const node of this.nodes_.values()) {
      const m = node.mandate;
      if (m.budget < 0n) {
        out.push({ kind: "NEGATIVE_BUDGET", node: node.name, message: `budget ${m.budget} < 0` });
      }
      const committed = m.spentDirect + this.reserved(node.name);
      if (committed > m.budget) {
        out.push({
          kind: "OVER_COMMITTED",
          node: node.name,
          message: `spent ${m.spentDirect} + delegated ${committed - m.spentDirect} > budget ${m.budget}`,
        });
      }
      if (node.parent === null) continue;
      const parent = this.nodes_.get(node.parent);
      if (!parent) {
        out.push({ kind: "BROKEN_LINK", node: node.name, message: `parent "${node.parent}" is not in the tree` });
        continue;
      }
      const p = parent.mandate;
      const broadened = [
        !isAllowlistSubset(m.allowedMerchants, p.allowedMerchants) && "merchants",
        !isAllowlistSubset(m.allowedPurposes, p.allowedPurposes) && "purposes",
        m.expiry > p.expiry && "expiry",
      ].filter((x): x is string => typeof x === "string");
      if (broadened.length > 0) {
        out.push({
          kind: "NOT_ATTENUATED",
          node: node.name,
          message: `${broadened.join(", ")} broaden parent "${parent.name}"`,
        });
      }
    }
    return out;
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
