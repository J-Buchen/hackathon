/**
 * ENSv2 — the delegation tree as a subname hierarchy.
 *
 * THE CENTRAL INSIGHT: ENSv2's hierarchical name registry *is* the delegation
 * tree. `scraper.researcher.alice.eth` encodes who-is-boss-of-whom, and each
 * node stores its mandate (budget/scope/expiry) as resolver TEXT records under an
 * `allowance.*` namespace. Registering a subname == delegating; reading a name's
 * text records == reading its mandate.
 *
 * Sponsor: ENS ($6k) — the authority/delegation tree + mandate storage. Docs:
 *   https://docs.ens.domains/           (ENS)
 *   ENSv2 (Namechain) name-wrapper / registry + public resolver on Sepolia.
 *
 * Ships:
 *   - `EnsRegistry`   in-memory mock modelling subname registration + text records
 *   - `EnsV2Registry` real-integration stub (TODO(cred), Sepolia)
 */

import type { AgentNode, DelegationTree, Mandate, MandateInput } from "@allowance/core";
import { childName, parentNameOf } from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** TEXT-record keys used to encode a mandate on a name (the resolver namespace). */
export const MANDATE_KEYS = {
  budget: "allowance.budget",
  spentDirect: "allowance.spentDirect",
  allowedMerchants: "allowance.allowedMerchants",
  allowedPurposes: "allowance.allowedPurposes",
  expiry: "allowance.expiry",
  revoked: "allowance.revoked",
} as const;

/** Sentinel stored for an unrestricted (undefined) allowlist. */
const ANY = "*";

/** A decoded mandate as read back from text records. */
export interface DecodedMandate {
  budget: bigint;
  spentDirect: bigint;
  allowedMerchants?: string[];
  allowedPurposes?: string[];
  expiry: number;
  revoked: boolean;
}

/** One registered name and its resolver state (the mock's storage unit). */
export interface EnsNameRecord {
  name: string;
  parent: string | null;
  owner: string;
  texts: Map<string, string>;
}

/**
 * In-memory ENSv2 registry + public-resolver mock.
 *
 * Models the two operations Allowance needs: register a subname under a parent
 * (delegation), and set/get TEXT records (mandate storage). Parent resolution is
 * derived from the dotted name, exactly as ENS hierarchy implies.
 */
export class EnsRegistry {
  private readonly names = new Map<string, EnsNameRecord>();

  /** Register a top-level / root name (e.g. `alice.eth`). Idempotent. */
  register(name: string, owner = "principal"): EnsNameRecord {
    const existing = this.names.get(name);
    if (existing) return existing;
    const rec: EnsNameRecord = { name, parent: parentNameOf(name), owner, texts: new Map() };
    this.names.set(name, rec);
    return rec;
  }

  /**
   * Register a subname `childLabel` under `parentName` (i.e. delegate). Returns
   * the full child name. The parent must already exist.
   */
  registerSubname(parentName: string, childLabel: string, owner = "agent"): string {
    if (!this.names.has(parentName)) {
      throw new Error(`ENS: cannot register subname under unknown parent "${parentName}"`);
    }
    const full = childName(parentName, childLabel);
    const rec: EnsNameRecord = { name: full, parent: parentName, owner, texts: new Map() };
    this.names.set(full, rec);
    return full;
  }

  /** True if the name is registered. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  /** All registered names, in insertion order. */
  list(): string[] {
    return [...this.names.keys()];
  }

  /** The resolved (structural) parent of a name, or null for a root. */
  resolveParent(name: string): string | null {
    const rec = this.names.get(name);
    return rec ? rec.parent : parentNameOf(name);
  }

  /** Set a single TEXT record on a name. */
  setText(name: string, key: string, value: string): void {
    this.requireName(name).texts.set(key, value);
  }

  /** Get a single TEXT record, or undefined. */
  getText(name: string, key: string): string | undefined {
    return this.names.get(name)?.texts.get(key);
  }

  /** All TEXT records on a name as a plain object (dashboard/debug friendly). */
  allTexts(name: string): Record<string, string> {
    return Object.fromEntries(this.requireName(name).texts);
  }

  /** Encode a mandate into this name's TEXT records (the `allowance.*` namespace). */
  setMandate(name: string, mandate: Mandate | MandateInput): void {
    const rec = this.requireName(name);
    const spent = "spentDirect" in mandate ? mandate.spentDirect : 0n;
    const revoked = "revoked" in mandate ? mandate.revoked : false;
    rec.texts.set(MANDATE_KEYS.budget, mandate.budget.toString());
    rec.texts.set(MANDATE_KEYS.spentDirect, spent.toString());
    rec.texts.set(MANDATE_KEYS.allowedMerchants, encodeList(mandate.allowedMerchants));
    rec.texts.set(MANDATE_KEYS.allowedPurposes, encodeList(mandate.allowedPurposes));
    rec.texts.set(MANDATE_KEYS.expiry, mandate.expiry.toString());
    rec.texts.set(MANDATE_KEYS.revoked, String(revoked));
  }

  /** Decode a mandate previously stored on a name. Throws if none is present. */
  getMandate(name: string): DecodedMandate {
    const t = this.requireName(name).texts;
    const budget = t.get(MANDATE_KEYS.budget);
    if (budget === undefined) throw new Error(`ENS: no mandate records on "${name}"`);
    return {
      budget: BigInt(budget),
      spentDirect: BigInt(t.get(MANDATE_KEYS.spentDirect) ?? "0"),
      allowedMerchants: decodeList(t.get(MANDATE_KEYS.allowedMerchants)),
      allowedPurposes: decodeList(t.get(MANDATE_KEYS.allowedPurposes)),
      expiry: Number(t.get(MANDATE_KEYS.expiry) ?? "0"),
      revoked: t.get(MANDATE_KEYS.revoked) === "true",
    };
  }

  /**
   * Project an entire `DelegationTree` onto the registry: register every node as
   * a (sub)name and write its mandate as text records. Roots are registered
   * first so subname registration always finds its parent. Returns the number of
   * names written. This is how the ENS view stays in lock-step with core state.
   */
  syncFromTree(tree: DelegationTree): number {
    // No sort needed: `tree.listNodes()` yields nodes in insertion order, and a
    // node can only be inserted after its parent exists (fundRoot precedes any
    // delegate; delegate throws UnknownNodeError without an existing parent). So
    // parents already precede their children — iterate directly and skip the
    // per-call O(n log n) sort + two String.split allocations per comparison.
    let count = 0;
    for (const node of tree.listNodes()) {
      this.upsertNode(node);
      this.setMandate(node.name, node.mandate);
      count++;
    }
    return count;
  }

  /** Register a node's name whether it is a root or a subname. */
  private upsertNode(node: AgentNode): void {
    if (this.names.has(node.name)) return;
    if (node.parent === null) {
      this.register(node.name, "principal");
    } else {
      // Ensure parent exists (it will, given depth-ordered sync).
      if (!this.names.has(node.parent)) this.register(node.parent, "agent");
      const label = node.name.slice(0, node.name.length - node.parent.length - 1);
      this.registerSubname(node.parent, label, "agent");
    }
  }

  private requireName(name: string): EnsNameRecord {
    const rec = this.names.get(name);
    if (!rec) throw new Error(`ENS: unknown name "${name}"`);
    return rec;
  }
}

/** Encode an allowlist for a text record: `"*"` for any, else comma-joined. */
function encodeList(list: string[] | undefined): string {
  return list === undefined ? ANY : list.join(",");
}

/** Decode an allowlist text record back to `string[] | undefined`. */
function decodeList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === ANY) return undefined;
  if (value === "") return [];
  return value.split(",");
}

/**
 * Real ENSv2 registry adapter (integration stub).
 *
 * PRODUCTION FLOW:
 *   - Delegation => register a subname on the ENSv2 registry / name-wrapper and
 *     set its resolver, owned by the parent agent.
 *   - Mandate storage => `setText` the `allowance.*` records on the public
 *     resolver; reads use `text(node, key)`.
 *   - Parent resolution => structural (from the name) and/or on-chain owner.
 *
 * TODO(cred): set a `provider` (Sepolia RPC), a `signer`, and the ENSv2 registry
 *   + public-resolver addresses, then implement register/setText via ethers/viem.
 *   Docs: https://docs.ens.domains/  (ENSv2 / Sepolia deployment addresses).
 */
export interface EnsV2Config {
  /** JSON-RPC URL (e.g. Sepolia). TODO(cred). */
  rpcUrl?: string;
  /** ENSv2 registry address. TODO(cred). */
  registryAddress?: string;
  /** Public resolver address. TODO(cred). */
  resolverAddress?: string;
}

export class EnsV2Registry {
  constructor(private readonly config: EnsV2Config = {}) {}

  private ensureConfigured(): void {
    if (!this.config.rpcUrl || !this.config.registryAddress) {
      throw new AdapterNotConfiguredError("ENSv2", "See https://docs.ens.domains/");
    }
  }

  async registerSubname(_parentName: string, _childLabel: string): Promise<string> {
    this.ensureConfigured();
    // TODO(cred): call the ENSv2 registry / name-wrapper to create the subname.
    throw new AdapterNotConfiguredError("ENSv2", "on-chain register not implemented.");
  }

  async setMandate(_name: string, _mandate: Mandate | MandateInput): Promise<void> {
    this.ensureConfigured();
    // TODO(cred): resolver.setText(node, key, value) for each allowance.* record.
    throw new AdapterNotConfiguredError("ENSv2", "resolver setText not implemented.");
  }

  async getMandate(_name: string): Promise<DecodedMandate> {
    this.ensureConfigured();
    // TODO(cred): resolver.text(node, key) reads decoded via decodeList/BigInt.
    throw new AdapterNotConfiguredError("ENSv2", "resolver text read not implemented.");
  }
}
