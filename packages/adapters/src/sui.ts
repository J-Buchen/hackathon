/**
 * Sui — programmable escrow / settlement rail (optional, stretch).
 *
 * Models a settlement pattern that adds a post-screening CLAWBACK WINDOW: funds
 * are locked into a programmable escrow object at settlement, and can be released
 * to the merchant or clawed back by the principal within a time window (e.g. if a
 * delayed screening signal or a revocation lands right after settlement). This
 * complements the synchronous `SettlementService` port rather than replacing it.
 *
 * Sponsor: Sui ($5k, optional/non-EVM). Docs:
 *   https://docs.sui.io/  (Move programmable objects / on-chain escrow)
 *
 * Ships:
 *   - `MockSuiEscrow`    deterministic, offline escrow with a clawback window
 *   - `SuiEscrowClient`  real-integration stub (TODO(cred))
 */

import { AdapterNotConfiguredError } from "./errors";

/** Lifecycle state of an escrow lock. */
export type EscrowStatus = "LOCKED" | "RELEASED" | "CLAWED_BACK";

/** Parameters to open an escrow lock. */
export interface EscrowLockParams {
  node: string;
  merchant: string;
  /** Amount locked (smallest units). */
  amount: bigint;
  token: string;
  /** Creation time (unix seconds). */
  now: number;
  /** Clawback window length in seconds. Default 3600 (1h). */
  windowSeconds?: number;
}

/** An escrow object (mock analogue of a Sui Move object). */
export interface EscrowLock {
  id: string;
  node: string;
  merchant: string;
  amount: bigint;
  token: string;
  status: EscrowStatus;
  createdAt: number;
  /** Funds may be clawed back while `now <= clawbackUntil`. */
  clawbackUntil: number;
}

/**
 * Deterministic, offline programmable escrow.
 *
 * `lock` opens an escrow object with a clawback window; `release` pays the
 * merchant (only from LOCKED); `clawback` refunds the payer, but ONLY while
 * within the window — after it expires the lock is effectively final and release
 * is the only valid move. All state changes are in-memory and reproducible.
 */
export class MockSuiEscrow {
  private readonly locks = new Map<string, EscrowLock>();
  private counter = 0;

  /** Open a new escrow lock and return it. */
  lock(params: EscrowLockParams): EscrowLock {
    const window = params.windowSeconds ?? 3600;
    const id = `0xsui${(this.counter++).toString(16).padStart(4, "0")}`;
    const lock: EscrowLock = {
      id,
      node: params.node,
      merchant: params.merchant,
      amount: params.amount,
      token: params.token,
      status: "LOCKED",
      createdAt: params.now,
      clawbackUntil: params.now + window,
    };
    this.locks.set(id, lock);
    return { ...lock };
  }

  /** Release escrowed funds to the merchant. Only valid from LOCKED. */
  release(id: string): EscrowLock {
    const lock = this.require(id);
    if (lock.status !== "LOCKED") {
      throw new Error(`escrow ${id}: cannot release from status ${lock.status}`);
    }
    lock.status = "RELEASED";
    return { ...lock };
  }

  /**
   * Claw back escrowed funds to the payer. Only valid from LOCKED AND while still
   * within the clawback window (`now <= clawbackUntil`).
   */
  clawback(id: string, now: number): EscrowLock {
    const lock = this.require(id);
    if (lock.status !== "LOCKED") {
      throw new Error(`escrow ${id}: cannot claw back from status ${lock.status}`);
    }
    if (now > lock.clawbackUntil) {
      throw new Error(`escrow ${id}: clawback window closed at ${lock.clawbackUntil}`);
    }
    lock.status = "CLAWED_BACK";
    return { ...lock };
  }

  /** Read an escrow lock (a copy), or undefined. */
  get(id: string): EscrowLock | undefined {
    const lock = this.locks.get(id);
    return lock ? { ...lock } : undefined;
  }

  /** All escrow locks (copies), in creation order. */
  list(): EscrowLock[] {
    return [...this.locks.values()].map((l) => ({ ...l }));
  }

  private require(id: string): EscrowLock {
    const lock = this.locks.get(id);
    if (!lock) throw new Error(`escrow: unknown lock "${id}"`);
    return lock;
  }
}

/**
 * Real Sui escrow client (integration stub).
 *
 * PRODUCTION FLOW:
 *   - Publish a Move package exposing `lock`, `release`, and windowed `clawback`
 *     entry functions over a `Coin<T>` escrow object.
 *   - `lock` => programmable transaction block moving the coin into the escrow
 *     object with an expiry; `release`/`clawback` => entry calls guarded on-chain
 *     by the window and the principal/merchant capabilities.
 *
 * TODO(cred): set `rpcUrl` (Sui fullnode), a signer keypair, and the published
 *   `packageId`, then implement the PTBs. Docs: https://docs.sui.io/
 */
export interface SuiEscrowConfig {
  /** Sui fullnode RPC URL. TODO(cred). */
  rpcUrl?: string;
  /** Published Move package id. TODO(cred). */
  packageId?: string;
}

export class SuiEscrowClient {
  constructor(private readonly config: SuiEscrowConfig = {}) {}

  private ensureConfigured(): void {
    if (!this.config.rpcUrl || !this.config.packageId) {
      throw new AdapterNotConfiguredError("Sui", "See https://docs.sui.io/");
    }
  }

  async lock(_params: EscrowLockParams): Promise<EscrowLock> {
    this.ensureConfigured();
    throw new AdapterNotConfiguredError("Sui", "on-chain escrow lock not implemented.");
  }

  async release(_id: string): Promise<EscrowLock> {
    this.ensureConfigured();
    throw new AdapterNotConfiguredError("Sui", "on-chain release not implemented.");
  }

  async clawback(_id: string, _now: number): Promise<EscrowLock> {
    this.ensureConfigured();
    throw new AdapterNotConfiguredError("Sui", "on-chain clawback not implemented.");
  }
}
