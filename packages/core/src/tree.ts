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

  /** Direct children of a node. */
  childrenOf(name: string): AgentNode[] {
    return this.listNodes().filter((n) => n.parent === name);
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
    return this.childrenOf(name).reduce((sum, child) => sum + child.mandate.budget, 0n);
  }

  /** budget - spentDirect - reserved. What this node can still delegate or spend. */
  available(name: string): bigint {
    const node = this.requireNode(name);
    return node.mandate.budget - node.mandate.spentDirect - this.reserved(name);
  }

  /** True if this node or any ancestor is revoked. */
  isRevokedInChain(name: string): boolean {
    const node = this.getNode(name);
    if (!node) return false;
    if (node.mandate.revoked) return true;
    return this.ancestors(name).some((a) => a.mandate.revoked);
  }

  /** True if this node or any ancestor is expired at `now` (unix seconds). */
  isExpiredInChain(name: string, now: number): boolean {
    const node = this.getNode(name);
    if (!node) return false;
    if (now > node.mandate.expiry) return true;
    return this.ancestors(name).some((a) => now > a.mandate.expiry);
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                        */
  /* ---------------------------------------------------------------- */

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
    this.nodes_.set(node.name, node);

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
    this.nodes_.set(node.name, node);

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
