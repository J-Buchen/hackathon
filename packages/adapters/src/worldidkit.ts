/**
 * World IDKit — the HUMAN principal verifier.
 *
 * Before the human at the top of the tree may fund/authorize the root agent,
 * they prove personhood with World IDKit (the widget-driven proof-of-human
 * flow). This is the `PrincipalVerifier` port from `@allowance/core`. It is
 * distinct from World ID *for Agents* (see `world.ts`): IDKit verifies the human
 * root of trust once, up front; the agent gate verifies each machine identity on
 * every payment.
 *
 * Sponsor: World IDKit ($5k). Docs:
 *   https://docs.world.org/world-id/id/cloud  (cloud verification)
 *   https://github.com/worldcoin/idkit-js     (IDKit widget)
 *
 * Ships:
 *   - `MockPrincipalVerifier`  deterministic, offline (used by the demo)
 *   - `WorldIDKitVerifier`     real-integration stub (TODO(cred))
 */

import type {
  PrincipalProof,
  PrincipalVerificationResult,
  PrincipalVerifier,
} from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** Configuration for the deterministic mock IDKit verifier. */
export interface MockPrincipalVerifierConfig {
  /**
   * Proof `signal`/`action` values that force a FAILED verification, to exercise
   * the IDKit failure path (funding refused). Default: `["fail"]`.
   */
  failSignals?: string[];
}

/**
 * Deterministic, offline World IDKit verifier.
 *
 * Rule (matches DESIGN §5): returns `verified:true` for a normal proof, and
 * `verified:false` when `proof.signal` or `proof.action` is a configured fail
 * signal (default `"fail"`). A stable pseudo `nullifierHash` is derived from the
 * proof so repeated demo runs are reproducible.
 */
export class MockPrincipalVerifier implements PrincipalVerifier {
  private readonly failSignals: Set<string>;

  constructor(config: MockPrincipalVerifierConfig = {}) {
    this.failSignals = new Set(config.failSignals ?? ["fail"]);
  }

  async verify(proof: PrincipalProof): Promise<PrincipalVerificationResult> {
    const signal = typeof proof.signal === "string" ? proof.signal : undefined;
    const action = typeof proof.action === "string" ? proof.action : undefined;

    if ((signal && this.failSignals.has(signal)) || (action && this.failSignals.has(action))) {
      return {
        verified: false,
        reason: "IDKit verification failed (proof rejected / not a unique human)",
      };
    }

    return {
      verified: true,
      nullifierHash: mockNullifier(signal ?? action ?? "principal"),
    };
  }
}

/** Deterministic, human-readable pseudo nullifier hash for the mock. */
function mockNullifier(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "0x" + h.toString(16).padStart(8, "0") + "idkitmocknullifier".padEnd(56, "0");
}

/**
 * Real World IDKit verifier (integration stub).
 *
 * PRODUCTION FLOW:
 *   1. The frontend renders the IDKit widget; the human completes the proof.
 *   2. The widget returns { merkle_root, nullifier_hash, proof, verification_level }.
 *   3. This service POSTs that payload to World's cloud verify endpoint for the
 *      app+action and returns whether it verified. On success the orchestrator
 *      calls `tree.fundRoot(...)`; on failure it refuses to fund.
 *
 * TODO(cred): set `appId` + `action` from https://developer.worldcoin.org/ and
 *   implement the POST to `${apiUrl}/api/v2/verify/${appId}`.
 */
export interface WorldIDKitVerifierConfig {
  /** World app id (`app_...`). TODO(cred). */
  appId?: string;
  /** IDKit action id configured in the developer portal. TODO(cred). */
  action?: string;
  /** Cloud verify endpoint. Defaults to the World cloud verifier. */
  apiUrl?: string;
}

export class WorldIDKitVerifier implements PrincipalVerifier {
  constructor(private readonly config: WorldIDKitVerifierConfig = {}) {}

  async verify(_proof: PrincipalProof): Promise<PrincipalVerificationResult> {
    if (!this.config.appId || !this.config.action) {
      throw new AdapterNotConfiguredError(
        "World IDKit",
        "See https://docs.world.org/world-id/id/cloud",
      );
    }
    // TODO(cred): POST { merkle_root, nullifier_hash, proof, verification_level,
    // action } to the cloud verify endpoint and map response.success -> verified.
    throw new AdapterNotConfiguredError("World IDKit", "cloud verify not implemented.");
  }
}
