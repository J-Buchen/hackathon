/**
 * Intercepta — live compliance / sanctions screening.
 *
 * The screening stage runs a LIVE call on `(merchant, amount, purpose)` BEFORE a
 * payment is ever signed/settled. This is the `ScreeningService` port from
 * `@allowance/core`. It is deliberately positioned after the mandate check but
 * before settlement, so policy-permitted merchants can still be caught by live
 * screening (the demo's `sanctioned-vendor` case).
 *
 * Sponsor: Intercepta ($2k). The production integration is exposed over x402
 * (HTTP 402 "Payment Required" pay-per-call) semantics: the caller pays a tiny
 * fee for the screening call itself, then receives a signed decision.
 *
 * Ships:
 *   - `MockScreeningService`        deterministic, offline (used by the demo)
 *   - `InterceptaScreeningService`  real-integration stub (TODO(cred), x402)
 */

import type {
  ScreeningRequest,
  ScreeningResult,
  ScreeningService,
} from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** Configuration for the deterministic mock screening service. */
export interface MockScreeningConfig {
  /**
   * Exact merchant identifiers that are always BLOCKED. Default:
   * `["sanctioned-vendor"]`. In addition, any merchant whose id starts with
   * `"sanctioned"` is blocked (prefix rule, always on).
   */
  deniedMerchants?: string[];
  /**
   * Optional amount ceiling (smallest units). Payments strictly above it are
   * flagged for manual review and blocked. Undefined = no ceiling.
   */
  amountCeiling?: bigint;
}

/**
 * Deterministic, offline Intercepta screening.
 *
 * Rule (matches DESIGN §5): blocks any merchant on the denylist or matching the
 * `sanctioned*` prefix (and, if configured, any amount over the ceiling);
 * approves everything else. A `reference` (mock case id) is returned on BOTH
 * paths so the audit trail always has a screening reference.
 */
export class MockScreeningService implements ScreeningService {
  private readonly denied: Set<string>;
  private readonly amountCeiling?: bigint;

  constructor(config: MockScreeningConfig = {}) {
    this.denied = new Set(config.deniedMerchants ?? ["sanctioned-vendor"]);
    this.amountCeiling = config.amountCeiling;
  }

  async screen(req: ScreeningRequest): Promise<ScreeningResult> {
    const reference = mockCaseId(req);

    const sanctioned =
      this.denied.has(req.merchant) || req.merchant.toLowerCase().startsWith("sanctioned");
    if (sanctioned) {
      return {
        approved: false,
        reason: `merchant "${req.merchant}" matched a sanctions/denylist screen`,
        reference,
      };
    }

    if (this.amountCeiling !== undefined && req.amount > this.amountCeiling) {
      return {
        approved: false,
        reason: `amount ${req.amount} exceeds screening ceiling ${this.amountCeiling}`,
        reference,
      };
    }

    return { approved: true, reason: "cleared", reference };
  }
}

/** Deterministic, human-readable pseudo screening case id for the mock. */
function mockCaseId(req: ScreeningRequest): string {
  const seed = `${req.node}|${req.merchant}|${req.amount}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "INTCPT-" + h.toString(16).padStart(8, "0").toUpperCase();
}

/**
 * Real Intercepta screening (integration stub, x402).
 *
 * PRODUCTION FLOW ("one live API call before payment is signed"):
 *   1. POST the screening request to the Intercepta endpoint.
 *   2. The endpoint responds `402 Payment Required` with x402 payment terms.
 *   3. The caller settles the micro-fee (x402 header / on-chain voucher) and
 *      retries; Intercepta returns a signed decision { approved, reason, caseId }.
 *   4. Only an `approved` decision allows the outer payment to proceed to
 *      settlement.
 *
 * TODO(cred): set `apiUrl` + `apiKey`, and wire an x402 payer to satisfy the 402
 *   challenge. Docs: https://www.x402.org/ (x402 spec) and the Intercepta portal.
 */
export interface InterceptaConfig {
  /** Intercepta screening endpoint. TODO(cred). */
  apiUrl?: string;
  /** API key. TODO(cred). */
  apiKey?: string;
}

export class InterceptaScreeningService implements ScreeningService {
  constructor(private readonly config: InterceptaConfig = {}) {}

  async screen(_req: ScreeningRequest): Promise<ScreeningResult> {
    if (!this.config.apiUrl || !this.config.apiKey) {
      throw new AdapterNotConfiguredError(
        "Intercepta",
        "Live x402 screening. See https://www.x402.org/",
      );
    }
    // TODO(cred): POST req -> handle 402 -> settle x402 fee -> retry -> map the
    // signed decision to a ScreeningResult. Left unimplemented on purpose.
    throw new AdapterNotConfiguredError("Intercepta", "x402 screening not implemented.");
  }
}
