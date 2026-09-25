/**
 * Presentation helpers. All amounts arrive as decimal strings of smallest-unit
 * integers; we render them as human token amounts using BigInt so we never lose
 * precision to floating point.
 */

/**
 * Format a smallest-unit integer string as a human amount.
 * e.g. formatAmount("8000000", 6) -> "8" ; formatAmount("8500000", 6) -> "8.5"
 */
export function formatAmount(raw: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return raw; // be defensive: show the raw string if it isn't an integer
  }
  const negative = value < 0n;
  if (negative) value = -value;

  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;

  const wholeStr = whole.toLocaleString("en-US");
  if (frac === 0n) return (negative ? "-" : "") + wholeStr;

  // Zero-pad the fractional part, then trim trailing zeros.
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${wholeStr}.${fracStr}`;
}

/** Format a smallest-unit string with the currency ticker, e.g. "8 USDC". */
export function formatMoney(raw: string, decimals: number, currency: string): string {
  return `${formatAmount(raw, decimals)} ${currency}`;
}

/** Format a unix-seconds timestamp as a compact local date/time. */
export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The left-most label of a dotted ENS-style name (the node's own label). */
export function shortLabel(name: string): string {
  return name.split(".")[0] ?? name;
}

/** Fraction spent+reserved of budget, clamped to [0,1], for the usage bar. */
export function usageFraction(budget: string, spent: string, reserved: string): {
  spent: number;
  reserved: number;
} {
  let b: bigint;
  let s: bigint;
  let r: bigint;
  try {
    b = BigInt(budget);
    s = BigInt(spent);
    r = BigInt(reserved);
  } catch {
    return { spent: 0, reserved: 0 };
  }
  if (b <= 0n) return { spent: 0, reserved: 0 };
  // Use Number for the ratio only (safe: ratios are in [0,1]).
  const spentPct = Number((s * 10000n) / b) / 100;
  const reservedPct = Number((r * 10000n) / b) / 100;
  return { spent: spentPct, reserved: reservedPct };
}
