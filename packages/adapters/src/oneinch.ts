/**
 * 1inch Aqua — pay-in-any-token settlement.
 *
 * The settlement stage moves funds to the merchant. If the payer's token differs
 * from the token the merchant wants, Aqua / SwapVM swaps payer-token -> merchant-
 * token atomically as part of settlement. This is the `SettlementService` port
 * from `@allowance/core`.
 *
 * Sponsor: 1inch Aqua ($5k). Aqua executes intents on SwapVM; docs:
 *   https://portal.1inch.dev/  (1inch developer portal)
 *   https://1inch.io/aqua/     (Aqua overview)
 *
 * Ships:
 *   - `MockSettlementService`  deterministic, offline swap simulation (demo)
 *   - `AquaSettlementService`  real-integration stub (TODO(cred))
 */

import type {
  SettlementRequest,
  SettlementResult,
  SettlementService,
} from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** A quoted swap, as the mock (and, later, the real Aqua adapter) would return. */
export interface SwapQuote {
  fromToken: string;
  toToken: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Rate applied, expressed as toToken units per fromToken unit. */
  rate: number;
  /** True when a cross-token swap is actually required. */
  swapped: boolean;
}

/** Configuration for the deterministic mock settlement service. */
export interface MockSettlementConfig {
  /**
   * Quoted swap rate: how many merchant-token units the payer receives per payer-
   * token unit. `1` (default) models a stable-to-stable 1:1 settlement, which
   * keeps demo balances exact. A rate like `1.02` simulates a favorable quote.
   */
  swapRate?: number;
  /** Settlement token used when a request omits token fields. Default `"USDC"`. */
  settlementToken?: string;
}

/** Rate is applied in fixed-point (1e6 scale) so bigint math stays exact-ish. */
const RATE_SCALE = 1_000_000n;

/**
 * Apply a floating swap rate to a smallest-unit bigint amount without leaving
 * bigint space. The rate is rounded to 6 fractional digits.
 */
export function applySwapRate(amountIn: bigint, rate: number): bigint {
  const scaled = BigInt(Math.round(rate * Number(RATE_SCALE)));
  return (amountIn * scaled) / RATE_SCALE;
}

/**
 * Deterministic, offline 1inch Aqua settlement.
 *
 * Rule (matches DESIGN §5): always `settled:true`; `swapped = payerToken !==
 * merchantToken`; `amountIn = req.amount`; `amountOut = amountIn * swapRate`
 * (default rate 1 => amountOut === amountIn). A mock settlement reference (an
 * on-chain-style pseudo tx hash) is always included.
 */
export class MockSettlementService implements SettlementService {
  private readonly swapRate: number;

  constructor(config: MockSettlementConfig = {}) {
    this.swapRate = config.swapRate ?? 1;
  }

  /** Produce the swap quote for a request (no state change). */
  quote(req: SettlementRequest): SwapQuote {
    const swapped = req.payerToken !== req.merchantToken;
    const amountOut = swapped ? applySwapRate(req.amount, this.swapRate) : req.amount;
    return {
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut,
      rate: swapped ? this.swapRate : 1,
      swapped,
    };
  }

  async settle(req: SettlementRequest): Promise<SettlementResult> {
    const q = this.quote(req);
    return {
      settled: true,
      swapped: q.swapped,
      fromToken: q.fromToken,
      toToken: q.toToken,
      amountIn: q.amountIn,
      amountOut: q.amountOut,
      reference: mockTxHash(req),
    };
  }
}

/** Deterministic, on-chain-style pseudo tx hash (32 bytes) for the mock. */
function mockTxHash(req: SettlementRequest): string {
  const seed = `${req.node}|${req.merchant}|${req.amount}|${req.payerToken}->${req.merchantToken}`;
  let h = 0x811c9dc5;
  let out = "";
  for (let b = 0; b < 32; b++) {
    h ^= seed.charCodeAt((b * 7) % seed.length) + b;
    h = Math.imul(h, 0x01000193) >>> 0;
    out += (h & 0xff).toString(16).padStart(2, "0");
  }
  return "0x" + out;
}

/**
 * Real 1inch Aqua settlement (integration stub).
 *
 * PRODUCTION FLOW:
 *   1. Build a swap intent (payerToken -> merchantToken, amountIn) for the payer.
 *   2. Request a quote and submit the intent to Aqua; it executes on SwapVM.
 *   3. On fill, funds land with the merchant in merchantToken; return the tx
 *      hash and realized amountOut. If payerToken === merchantToken, settle a
 *      direct transfer with `swapped:false`.
 *
 * TODO(cred): set `apiKey` (1inch dev portal) + `chainId` + payer signer, and
 *   implement quote+submit against the Aqua/SwapVM contracts. Docs:
 *   https://portal.1inch.dev/ and https://1inch.io/aqua/.
 */
export interface AquaSettlementConfig {
  /** 1inch API key. TODO(cred). */
  apiKey?: string;
  /** Chain id to settle on. TODO(cred). */
  chainId?: number;
  /** Aqua/SwapVM router address override. TODO(cred). */
  routerAddress?: string;
}

export class AquaSettlementService implements SettlementService {
  constructor(private readonly config: AquaSettlementConfig = {}) {}

  async settle(_req: SettlementRequest): Promise<SettlementResult> {
    if (!this.config.apiKey || this.config.chainId === undefined) {
      throw new AdapterNotConfiguredError(
        "1inch Aqua",
        "See https://portal.1inch.dev/ and https://1inch.io/aqua/",
      );
    }
    // TODO(cred): quote + submit an Aqua swap intent on SwapVM and return the
    // realized settlement. Left unimplemented on purpose.
    throw new AdapterNotConfiguredError("1inch Aqua", "SwapVM settlement not implemented.");
  }
}
