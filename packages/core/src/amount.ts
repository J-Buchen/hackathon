/**
 * Amount helpers. Internally every amount is a `bigint` count of the token's
 * smallest unit. These helpers convert to/from the human decimal representation
 * used in the demo storyline (e.g. "100.000000" USDC <-> 100_000000n).
 */

/** USDC has 6 decimals across the whole project. */
export const USDC_DECIMALS = 6;

/**
 * Parse a human decimal string (or number) into smallest units.
 * @example parseAmount("100.000000") // 100000000n
 * @example parseAmount("0.5")        // 500000n
 */
export function parseAmount(value: string | number, decimals: number = USDC_DECIMALS): bigint {
  const text = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`parseAmount: not a decimal number: "${value}"`);
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, frac = ""] = unsigned.split(".");
  if (frac.length > decimals) {
    throw new Error(`parseAmount: too many fractional digits for ${decimals} decimals: "${value}"`);
  }
  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  const magnitude = BigInt(combined === "" ? "0" : combined);
  return negative ? -magnitude : magnitude;
}

/**
 * Format smallest units as a fixed-precision human decimal string.
 * @example formatAmount(100000000n) // "100.000000"
 */
export function formatAmount(value: bigint, decimals: number = USDC_DECIMALS): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const s = magnitude.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  const body = decimals > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}
