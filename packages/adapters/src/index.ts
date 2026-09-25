/**
 * @allowance/adapters — sponsor adapters behind the @allowance/core ports.
 *
 * For each sponsor: a deterministic OFFLINE MOCK (used by the demo) plus a
 * clearly-marked real-integration stub (`TODO(cred)`). The four payment ports
 * (identity / screening / settlement / principal) are the locked contract from
 * DESIGN §5; the remaining adapters (ENS, Uniswap hook mirror, Curvegrid,
 * Sui) are supporting/demo surfaces that read or mirror the same domain state.
 *
 *   world.ts       World ID for Agents  -> IdentityGate      (Mock + WorldAgent*)
 *   worldidkit.ts  World IDKit          -> PrincipalVerifier (Mock + WorldIDKit*)
 *   intercepta.ts  Intercepta           -> ScreeningService  (Mock + Intercepta*)
 *   oneinch.ts     1inch Aqua           -> SettlementService (Mock + Aqua*)
 *   ens.ts         ENSv2                -> subname/mandate registry
 *   uniswap.ts     Uniswap v4 hook      -> off-chain spend-cap mirror
 *   curvegrid.ts   Curvegrid MultiBaas  -> dashboard view models + chain reader
 *   sui.ts         Sui (stretch)        -> programmable escrow w/ clawback
 */

import type { PaymentAdapters } from "@allowance/core";
import { MockIdentityGate } from "./world";
import { MockScreeningService } from "./intercepta";
import { MockSettlementService } from "./oneinch";

export * from "./errors";
export * from "./world";
export * from "./worldidkit";
export * from "./intercepta";
export * from "./oneinch";
export * from "./ens";
export * from "./uniswap";
export * from "./curvegrid";
export * from "./sui";

/* ------------------------------------------------------------------ */
/* Convenience aliases (match the prose names used in the build brief). */
/* The DESIGN §5 lock names (Mock* / real-stub*) remain the canonical  */
/* exports above; these are just friendlier aliases for the mocks.     */
/* ------------------------------------------------------------------ */
export { MockIdentityGate as WorldIdentityGate } from "./world";
export { MockScreeningService as InterceptaScreening } from "./intercepta";
export { MockSettlementService as AquaSettlement } from "./oneinch";

/* ------------------------------------------------------------------ */
/* createMockAdapters — the one-call bundle used by pay() in the demo. */
/* ------------------------------------------------------------------ */

/** Configuration for the mock adapter bundle (DESIGN §5). */
export interface MockAdapterConfig {
  /** Merchants Intercepta should always block (plus the `sanctioned*` prefix). */
  deniedMerchants?: string[];
  /** 1inch Aqua mock swap rate (merchant units per payer unit). Default 1. */
  swapRate?: number;
  /**
   * If provided, only these node names are treated as World-ID-verified
   * (otherwise each node's own `identityStatus` drives the identity decision).
   */
  verifiedNames?: string[];
}

/**
 * Build the deterministic, offline `PaymentAdapters` bundle that `pay()` needs:
 * the World-ID-for-Agents identity gate, the Intercepta screening service, and
 * the 1inch Aqua settlement service — all mocks. The human-principal verifier
 * (World IDKit) is constructed separately via `MockPrincipalVerifier`, since it
 * runs at funding time and is not part of the per-payment bundle.
 */
export function createMockAdapters(config: MockAdapterConfig = {}): PaymentAdapters {
  return {
    identity: new MockIdentityGate(
      config.verifiedNames ? { verifiedNames: config.verifiedNames } : {},
    ),
    screening: new MockScreeningService(
      config.deniedMerchants ? { deniedMerchants: config.deniedMerchants } : {},
    ),
    settlement: new MockSettlementService(
      config.swapRate !== undefined ? { swapRate: config.swapRate } : {},
    ),
  };
}
